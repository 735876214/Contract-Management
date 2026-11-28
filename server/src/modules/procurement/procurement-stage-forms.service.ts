import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { num } from '@cms/calc/numeric';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { DictService } from '../dict';
import { deleteContractsOfTask } from '../contract';

type JsonValue = Prisma.JsonValue;
import { TASK_STATUS, bidderStatusWhenNotWon } from '../../constants/procurementFlow';
import { assertResultReportRejectable } from '../../constants/workflowGuards';
import { BIDDER_STATUS, DICT_TYPES, MODULE_RECORD_STATUS } from '../../constants/statuses';
import {
  taskOf,
  mainContract,
  estimatedAmountYuan,
  resolveSupplierId,
  parseJsonArray,
  serializeTask,
  textOf,
  numOf,
  intOf,
  dateOf,
  toWan,
  noticeStageIndex,
  documentStageIndex,
  resultReportStageIndex,
  priceCompareStageIndex,
  PRE_MEETING_THRESHOLD_YUAN,
} from './procurement-task-shared';

/**
 * 采购任务·阶段表单服务（从 ProcurementTaskService 拆出，P1-3 大服务拆分）。
 *
 * 承载六个采购阶段表单（总采购清单之外：框架协议事前说明 / 采前会会议纪要 / 采购公告 /
 * 采购文件 / 成交报告 / 采购价格对比表）的读取与保存，以及投标人/评审、成交报告导入与模板。
 *
 * 约束：与主服务（CRUD/生命周期）通过 procurement-task-shared 共用纯函数与读取原语，
 * 服务之间不互相依赖。主服务保留同名转发，控制器调用点不变。
 */
@Injectable()
export class ProcurementStageFormsService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private tpl: ImportTemplateService,
  ) {}

  /**
   * 阶段表单的「已完成/编辑中」状态块（六个详情接口共用，此前各抄一遍 4 行）。
   * published 由各阶段进度推导传入。
   */
  private statusBlock(published: boolean) {
    return {
      published,
      status: published ? MODULE_RECORD_STATUS.COMPLETED : MODULE_RECORD_STATUS.EDITING,
      statusLabel: published ? '已完成' : '编辑中',
    };
  }

  /**
   * 六阶段表单统一 upsert（按 taskId 一对一），并对已有记录启用**乐观锁**：
   * - 记录不存在 → 创建（无需 version）；
   * - 记录存在且 body.version 传入 → 与库中 version 比对，不符抛 409，命中则 version+1 更新；
   * - 记录存在但 body.version 未传 → 兼容旧调用（前端尚未回传 version 时）直接更新并 version+1，
   *   不 409；一旦前端开始回传 version，即升级为严格互斥。
   * delegate 为对应 Prisma model 的 upsert 代理（this.prisma.xxx）。
   */
  private async upsertStageRecord(
    delegate: {
      findUnique: (args: any) => Promise<any>;
      create: (args: any) => Promise<any>;
      update: (args: any) => Promise<any>;
    },
    taskId: string,
    projectId: string,
    payload: Record<string, any>,
    clientVersion?: unknown,
  ): Promise<any> {
    const existing = await delegate.findUnique({ where: { taskId }, select: { id: true, version: true } });
    if (!existing) {
      return delegate.create({ data: { ...payload, projectId, taskId } });
    }
    if (clientVersion !== undefined && clientVersion !== null && clientVersion !== '') {
      if (Number(clientVersion) !== Number(existing.version)) {
        throw new ConflictException('数据已被其他用户修改，请刷新后重试');
      }
    }
    return delegate.update({
      where: { taskId },
      data: { ...payload, version: { increment: 1 } },
    });
  }

  /**
   * 框架协议事前说明（批次二 · 任务 3.1，仅 FRAMEWORK 类型任务）。
   * 状态由阶段进度推导：stage=1 编辑中（仅保存），stage≥2 已完成（发布后，仍可重新编辑）。
   */
  async frameworkExplanation(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'FRAMEWORK') {
      throw new BadRequestException('仅「引用框架协议」类型的采购任务可使用事前说明模块');
    }
    const record = await this.prisma.frameworkExplanation.findUnique({ where: { taskId } });
    const published = task.stage >= 2;
    return {
      task: serializeTask(task),
      editable: task.stage >= 1 && !published,
      ...this.statusBlock(published),
      data: record ? this.serializeExplanation(record) : null,
    };
  }

  /** 保存事前说明（编辑中/已完成均可保存；发布后重新编辑允许修改但保留 publishedAt） */
  async saveFrameworkExplanation(taskId: string, body: any) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'FRAMEWORK') {
      throw new BadRequestException('仅「引用框架协议」类型的采购任务可使用事前说明模块');
    }
    if (task.stage < 1) {
      throw new BadRequestException('总采购清单发布后才能编辑框架协议事前说明');
    }

    const text = textOf;
    const num = numOf('表格中的价格/占比', { min: 0 });
    const rows = (v: any, fields: string[]): string | null | undefined => {
      // 未传（undefined）= 不修改该字段（PATCH 语义）：发布价格对比表自动灌入的 priceCompareRows
      // 不能被「只保存框架简介」这类局部提交覆盖清空；显式传 []（清空表格）才会写 null。
      if (v === undefined) return undefined;
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException('表格数据无效');
      const normalized = v
        .filter((r: any) => r != null && typeof r === 'object')
        .map((r: any) => {
          const row: Record<string, string | number | null> = {};
          for (const f of fields) {
            row[f] = f === 'rank' || f === 'totalPrice' || f === 'execPrice' || f === 'amount' || f === 'ratio'
              ? num(r?.[f])
              : text(r?.[f]);
          }
          return row;
        });
      return normalized.length ? JSON.stringify(normalized) : null;
    };
    const files = (v: any): string | null | undefined => {
      if (v === undefined) return undefined; // 未传不修改
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException('附件数据无效');
      const normalized = v
        .filter((f: any) => f?.url)
        .map((f: any) => ({ fileName: text(f.fileName) ?? '附件', url: String(f.url), size: num(f.size) }));
      return normalized.length ? JSON.stringify(normalized) : null;
    };

    const payload = {
      frameworkIntro: text(body?.frameworkIntro),
      negotiation: text(body?.negotiation),
      inquiryRows: rows(body?.inquiryRows, ['rank', 'unit', 'totalPrice', 'taxIncluded', 'type']),
      priceCompareRows: rows(body?.priceCompareRows, ['unit', 'content', 'execPrice', 'note']),
      execution: text(body?.execution),
      costRows: rows(body?.costRows, ['item', 'amount', 'ratio', 'note']),
      attachments: files(body?.attachments),
      // 问题五：引用供应商及金额 [{supplier, amount}]（可从询价情况表自动填充最低价单位）
      referenceSuppliers: rows(body?.referenceSuppliers, ['supplier', 'amount']),
    };

    const saved = await this.upsertStageRecord(
      this.prisma.frameworkExplanation as any,
      taskId,
      task.projectId,
      payload,
      body?.version,
    );
    return this.serializeExplanation(saved);
  }

  /**
   * 任务 3.6：框架协议事前说明「价格对比表」明细从本任务的采购价格对比表导入。
   * 采购价格对比表已录入明细时，逐行映射为事前说明的「价格对比表」行（幂等覆盖）：
   * - 单位 / 物资名称（含规格）/ 成交价不含税单价 / 备注。
   */
  async importPriceCompare(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'FRAMEWORK') {
      throw new BadRequestException('仅「引用框架协议」类型的采购任务可导入价格对比表');
    }
    const pc = await this.prisma.procurementPriceCompare.findUnique({ where: { taskId } });
    const items = parseJsonArray<Record<string, any>>(pc?.items);
    if (!items.length) {
      throw new BadRequestException('采购价格对比表暂无明细，无法导入（请先在「采购价格对比表」录入成交价）');
    }
    const priceCompareRows = items.map((it) => ({
      unit: String(it.unit ?? '').trim(),
      content: [it.materialName, it.spec].filter((s) => s != null && String(s).trim()).join(' / '),
      execPrice: it.dealPrice != null ? Number(it.dealPrice) : null,
      note: String(it.remark ?? '').trim(),
    }));
    const saved = await this.prisma.frameworkExplanation.upsert({
      where: { taskId },
      create: { projectId: task.projectId, taskId, priceCompareRows },
      update: { priceCompareRows },
    });
    return this.serializeExplanation(saved);
  }

  private serializeExplanation(r: {
    id: string;
    taskId: string;
    frameworkIntro: string | null;
    negotiation: string | null;
    inquiryRows: JsonValue | null;
    priceCompareRows: JsonValue | null;
    execution: string | null;
    costRows: JsonValue | null;
    attachments: JsonValue | null;
    publishedAt: Date | null;
    version?: number;
    updatedAt: Date;
  }) {
    const parse = (v: any): any[] => parseJsonArray(v);
    return {
      id: r.id,
      taskId: r.taskId,
      version: r.version ?? 0,
      frameworkIntro: r.frameworkIntro ?? '',
      negotiation: r.negotiation ?? '',
      inquiryRows: parse(r.inquiryRows),
      priceCompareRows: parse(r.priceCompareRows),
      execution: r.execution ?? '',
      costRows: parse(r.costRows),
      attachments: parse(r.attachments),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  /**
   * 采前会会议纪要（批次二 · 任务 3.2，仅「单项采购」且预计采购金额 ≥ 100 万）。
   * 状态由阶段进度推导：stage=1 编辑中（仅保存），stage≥2 已完成（发布后，仍可重新编辑）。
   */
  async preMeetingMinutes(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采前会会议纪要模块');
    }
    const amountYuan = await estimatedAmountYuan(this.prisma, taskId);
    // 生成条件：单项采购且预计采购金额 ≥ 100 万元（存量手工标记同样视为需要）
    const generated = task.preMeetingRequired || amountYuan >= PRE_MEETING_THRESHOLD_YUAN;
    const record = await this.prisma.preMeetingMinutes.findUnique({ where: { taskId } });
    const published = task.stage >= 2;
    // 补充二：采前会纪要的「技术质量标准 / 验收方式 / 付款方式」默认取自采购发起填写的任务三字段；
    // 纪要自身已填写则优先（自身覆盖任务）。
    const minutesData = record ? this.serializeMinutes(record) : null;
    if (minutesData) {
      minutesData.techQuality = minutesData.techQuality || task.techQuality || '';
      minutesData.acceptance = minutesData.acceptance || task.acceptanceMethod || '';
      minutesData.paymentTerms = minutesData.paymentTerms || task.paymentMethod || '';
    }
    return {
      task: serializeTask(task),
      /** 是否生成采前会会议纪要模块（单项采购且金额 ≥ 100 万） */
      generated,
      thresholdWan: PRE_MEETING_THRESHOLD_YUAN / 10000,
      estimatedAmountWan: toWan(amountYuan),
      editable: task.stage >= 1 && !published,
      ...this.statusBlock(published),
      data: minutesData,
    };
  }

  /** 保存采前会会议纪要（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async savePreMeetingMinutes(taskId: string, body: any) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采前会会议纪要模块');
    }
    if (task.stage < 1) {
      throw new BadRequestException('总采购清单发布后才能编辑采前会会议纪要');
    }
    const amountYuan = await estimatedAmountYuan(this.prisma, taskId);
    if (!task.preMeetingRequired && amountYuan < PRE_MEETING_THRESHOLD_YUAN) {
      throw new BadRequestException(
        `预计采购金额不足 ${PRE_MEETING_THRESHOLD_YUAN / 10000} 万元，无需编制采前会会议纪要`,
      );
    }

    const text = textOf;
    const num = numOf('表格中的数量/金额', { min: 0 });
    const date = dateOf('会议时间');
    /** 表格行：数值字段按数字存，其余按文本存；空表存 null */
    const jsonRows = (v: any, numericFields: string[], fields: string[]): string | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException('表格数据无效');
      const numeric = new Set(numericFields);
      const normalized = v
        .filter((r: any) => r != null && typeof r === 'object')
        .map((r: any) => {
          const row: Record<string, string | number | null> = {};
          for (const f of fields) row[f] = numeric.has(f) ? num(r?.[f]) : text(r?.[f]);
          return row;
        });
      return normalized.length ? JSON.stringify(normalized) : null;
    };
    /** 询价单图片（支持多张） */
    const images = (v: any): string | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException('询价单图片数据无效');
      const normalized = v
        .filter((f: any) => f?.url)
        .map((f: any) => ({ fileName: text(f.fileName) ?? '询价单', url: String(f.url), size: num(f.size) }));
      return normalized.length ? JSON.stringify(normalized) : null;
    };

    const payload = {
      meetingTime: date(body?.meetingTime),
      content: text(body?.content),
      host: text(body?.host),
      attendees: text(body?.attendees),
      writer: text(body?.writer),
      reviewer: text(body?.reviewer),
      purchaseItems: jsonRows(body?.purchaseItems, ['qty'], ['materialName', 'spec', 'unit', 'qty']),
      techQuality: text(body?.techQuality),
      acceptance: text(body?.acceptance),
      paymentTerms: text(body?.paymentTerms),
      // 成本分析表：income/cost 均为「万元」，效益额与效益率由前端按公式计算展示
      costRows: jsonRows(body?.costRows, ['income', 'cost'], ['materialName', 'spec', 'income', 'cost']),
      inquirySheets: images(body?.inquirySheets),
    };

    const saved = await this.upsertStageRecord(
      this.prisma.preMeetingMinutes as any,
      taskId,
      task.projectId,
      payload,
      body?.version,
    );
    return this.serializeMinutes(saved);
  }

  private serializeMinutes(r: {
    id: string;
    taskId: string;
    meetingTime: Date | null;
    content: string | null;
    host: string | null;
    attendees: string | null;
    writer: string | null;
    reviewer: string | null;
    purchaseItems: JsonValue | null;
    techQuality: string | null;
    acceptance: string | null;
    paymentTerms: string | null;
    costRows: JsonValue | null;
    inquirySheets: JsonValue | null;
    publishedAt: Date | null;
    version?: number;
    updatedAt: Date;
  }) {
    const parse = (v: any): any[] => parseJsonArray(v);
    return {
      id: r.id,
      taskId: r.taskId,
      version: r.version ?? 0,
      meetingTime: r.meetingTime,
      content: r.content ?? '',
      host: r.host ?? '',
      attendees: r.attendees ?? '',
      writer: r.writer ?? '',
      reviewer: r.reviewer ?? '',
      purchaseItems: parse(r.purchaseItems),
      techQuality: r.techQuality ?? '',
      acceptance: r.acceptance ?? '',
      paymentTerms: r.paymentTerms ?? '',
      costRows: parse(r.costRows),
      inquirySheets: parse(r.inquirySheets),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  /**
   * 采购公告（批次二 · 任务 3.3，仅「单项采购」任务）。
   * 状态由阶段进度推导：stage=公告阶段下标 → 编辑中；stage > 公告阶段下标 → 已完成（发布后，仍可重新编辑）。
   * 采购清单不落库，始终从「总采购清单」派生（数据来自总采购清单、不可编辑）。
   */
  async notice(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购公告模块');
    }
    const stageIndex = noticeStageIndex(task);
    const reached = task.stage >= stageIndex;
    const published = task.stage > stageIndex;
    const record = await this.prisma.procurementNotice.findUnique({ where: { taskId } });
    const items = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      task: serializeTask(task),
      /** 公告阶段在阶段链中的下标（单项采购：无采前会=1 / 有采前会=2） */
      stageIndex,
      /** 是否已进入或完成公告阶段（总清单、采前会已发布） */
      reached,
      editable: reached && !published,
      ...this.statusBlock(published),
      /** 采购清单（只读）：来自总采购清单 */
      purchaseItems: items.map((i) => ({
        materialName: i.materialName,
        spec: i.spec,
        unit: i.unit,
        qty: i.qty,
        remark: '',
      })),
      data: record ? this.serializeNotice(record) : null,
    };
  }

  /** 保存采购公告（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async saveNotice(taskId: string, body: any) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购公告模块');
    }
    if (task.stage < noticeStageIndex(task)) {
      throw new BadRequestException('请先发布总采购清单（如有采前会会议纪要亦需发布）后再编制采购公告');
    }

    const text = textOf;
    const date = dateOf('采购时间');
    /** 动态列表（联系人 / 联系电话）：按位置保存，仅裁剪尾部空项以保证「联系人N/联系电话N」按同一位置配对 */
    const list = (v: any, label: string): string | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) throw new BadRequestException(`${label}数据无效`);
      const arr = v.map((x: any) => String(x ?? '').trim());
      while (arr.length && !arr[arr.length - 1]) arr.pop();
      return arr.length ? JSON.stringify(arr) : null;
    };

    const payload = {
      procurementNo: text(body?.procurementNo),
      procurementTime: date(body?.procurementTime),
      content: text(body?.content),
      contacts: list(body?.contacts, '联系人'),
      contactPhones: list(body?.contactPhones, '联系电话'),
    };

    const saved = await this.upsertStageRecord(
      this.prisma.procurementNotice as any,
      taskId,
      task.projectId,
      payload,
      body?.version,
    );
    return this.serializeNotice(saved);
  }

  private serializeNotice(r: {
    id: string;
    taskId: string;
    procurementNo: string | null;
    procurementTime: Date | null;
    content: string | null;
    techQuality: string | null;
    acceptanceMethod: string | null;
    paymentMethod: string | null;
    contacts: JsonValue | null;
    contactPhones: JsonValue | null;
    publishedAt: Date | null;
    version?: number;
    updatedAt: Date;
  }) {
    // 列已改 jsonb：Prisma 返回已解析数组；兼容历史调用传入的 JSON 字符串
    const parseList = (v: any): string[] => parseJsonArray<string>(v).map((x) => String(x ?? ''));
    return {
      id: r.id,
      taskId: r.taskId,
      version: r.version ?? 0,
      procurementNo: r.procurementNo ?? '',
      procurementTime: r.procurementTime,
      content: r.content ?? '',
      techQuality: r.techQuality ?? '',
      acceptanceMethod: r.acceptanceMethod ?? '',
      paymentMethod: r.paymentMethod ?? '',
      contacts: parseList(r.contacts),
      contactPhones: parseList(r.contactPhones),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  /**
   * 采购文件（批次二 · 任务 3.4，仅「单项采购」任务）。
   * 入口条件：采购公告已完成（stage > 采购公告阶段下标）；本阶段编辑中 ⇔ stage === 采购文件下标。
   * 采购清单不落库，始终从「总采购清单」派生：
   * 物资名称/规格型号/计量单位/暂定数量/备注来自总清单，
   * 税前单价/税率/综合单价/合价恒为空（由投标方填写）。
   */
  async document(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购文件模块');
    }
    const noticeIndex = noticeStageIndex(task);
    const stageIndex = documentStageIndex(task);
    /** 采购公告已完成后本阶段即进入（reached）；本阶段发布后为已完成 */
    const reached = task.stage >= stageIndex;
    const published = task.stage > stageIndex;
    const record = await this.prisma.procurementDocument.findUnique({ where: { taskId } });
    const notice = await this.prisma.procurementNotice.findUnique({ where: { taskId } });
    const items = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      task: serializeTask(task),
      stageIndex,
      noticeStageIndex: noticeIndex,
      /** 采购公告是否已完成（采购文件的入口条件） */
      noticeCompleted: task.stage > noticeIndex,
      reached,
      editable: reached && !published,
      ...this.statusBlock(published),
      /** 来自采购公告的取值（采购编号/采购内容来自公告；技术质量标准/验收方式/付款方式来自采购发起 task） */
      notice: notice
        ? {
            procurementNo: notice.procurementNo ?? '',
            content: notice.content ?? '',
            techQuality: task.techQuality ?? '',
            acceptanceMethod: task.acceptanceMethod ?? '',
            paymentMethod: task.paymentMethod ?? '',
          }
        : null,
      /**
       * 采购清单（只读，来自总采购清单）：10 列。
       * 价格类字段恒为 null，保证「价格留空、由投标方填写」。
       */
      purchaseItems: items.map((i) => ({
        materialName: i.materialName,
        spec: i.spec,
        unit: i.unit,
        qty: i.qty,
        preTaxPrice: null,
        taxRate: null,
        unitPrice: null,
        amount: null,
        remark: '',
      })),
      data: record ? this.serializeDocument(record) : null,
    };
  }

  /** 保存采购文件（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async saveDocument(taskId: string, body: any) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用采购文件模块');
    }
    if (task.stage < documentStageIndex(task)) {
      throw new BadRequestException('请先发布采购公告（采购公告已完成）后再编制采购文件');
    }

    const text = textOf;
    const num = numOf('响应保证金', { min: 0 });
    const date = dateOf('采购时间');

    const payload = {
      procurementTime: date(body?.procurementTime),
      responseDeposit: num(body?.responseDeposit),
      quoteDescription: text(body?.quoteDescription),
    };

    const saved = await this.upsertStageRecord(
      this.prisma.procurementDocument as any,
      taskId,
      task.projectId,
      payload,
      body?.version,
    );
    return this.serializeDocument(saved);
  }

  private serializeDocument(r: any) {
    return {
      id: r.id,
      taskId: r.taskId,
      version: r.version ?? 0,
      procurementTime: r.procurementTime,
      responseDeposit: num(r.responseDeposit),
      quoteDescription: r.quoteDescription ?? '',
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  /**
   * 成交报告（批次二 · 任务 3.5，仅「单项采购」任务）。
   * 入口条件：采购文件已完成（stage > 采购文件阶段下标）；本阶段编辑中 ⇔ stage === 成交报告下标。
   * 四张表（响应单位情况汇总表 / 开启报价情况表 / 第二轮报价情况表 / 拟推荐成交候选人表）
   * 由 suppliers（导入明细）与 candidates（勾选）派生，不单独落库；
   * 「预计采购金额」来自总采购清单（Σ 控制价 × 暂定数量）。
   */
  async resultReport(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用成交报告模块');
    }
    const documentIndex = documentStageIndex(task);
    const stageIndex = resultReportStageIndex(task);
    const reached = task.stage >= stageIndex;
    const published = task.stage > stageIndex;
    const record = await this.prisma.procurementResultReport.findUnique({ where: { taskId } });
    const doc = await this.prisma.procurementDocument.findUnique({ where: { taskId } });
    const notice = await this.prisma.procurementNotice.findUnique({ where: { taskId } });
    const estimatedYuan = await estimatedAmountYuan(this.prisma, taskId);
    return {
      task: serializeTask(task),
      stageIndex,
      documentStageIndex: documentIndex,
      /** 采购文件是否已完成（成交报告的入口条件） */
      documentCompleted: task.stage > documentIndex,
      reached,
      editable: reached && !published,
      ...this.statusBlock(published),
      /** 采购内容（默认取采购公告内容，其次取采购任务内容） */
      content: notice?.content ?? task.content ?? '',
      /** 预计采购金额（元，来自总采购清单） */
      estimatedAmount: estimatedYuan,
      /** 采购文件（响应保证金等，供页面参考展示） */
      document: doc ? this.serializeDocument(doc) : null,
      /** 响应单位明细（导入），四张表由其派生 */
      suppliers: parseJsonArray<Record<string, any>>(record?.suppliers),
      /** 拟推荐成交候选人（第二轮报价表勾选） */
      candidates: parseJsonArray<Record<string, any>>(record?.candidates),
      data: record ? this.serializeResultReport(record) : null,
    };
  }

  /** 保存成交报告（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async saveResultReport(taskId: string, body: any) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用成交报告模块');
    }
    if (task.stage < resultReportStageIndex(task)) {
      throw new BadRequestException('请先发布采购文件（采购文件已完成）后再编制成交报告');
    }

    const text = textOf;
    const int = (v: any, label: string): number | null => intOf(label, { min: 0 })(v);
    const date = dateOf('采购开启时间');
    const suppliers = Array.isArray(body?.suppliers) ? body.suppliers : undefined;
    const candidates = Array.isArray(body?.candidates) ? body.candidates : undefined;
    /**
     * 候选人会被持久化成两份事实：JSON 快照（本表）与结构化行（`applyCandidateStatuses` 写 Decimal）。
     * 不校验时，缺名称/非数字价格会先污染快照，再让生成合同取到空单位或让 Prisma 写 NaN 抛 500。
     */
    if (candidates !== undefined) {
      for (const [i, c] of candidates.entries()) {
        if (!String(c?.name ?? '').trim()) {
          throw new BadRequestException(`第 ${i + 1} 个拟推荐成交候选人缺少单位名称`);
        }
        const raw = c?.finalPreTaxPrice;
        if (raw !== undefined && raw !== null && raw !== '') {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            throw new BadRequestException(`第 ${i + 1} 个候选单位的「最终确认不含税价格」必须为非负数字`);
          }
        }
      }
    }

    const payload = {
      unitCount: int(body?.unitCount, '成交单位数量'),
      openTime: date(body?.openTime),
      openPlace: text(body?.openPlace),
      reviewMembers: text(body?.reviewMembers),
      approvedCount: int(body?.approvedCount, '审核通过响应单位数量'),
      participantCount: int(body?.participantCount, '参与响应单位数量'),
      abstainCount: int(body?.abstainCount, '弃权响应单位数量'),
      validFileCount: int(body?.validFileCount, '有效响应文件数量'),
      ...(suppliers !== undefined ? { suppliers } : {}),
      ...(candidates !== undefined ? { candidates } : {}),
    };

    const saved = await this.prisma.$transaction(async (tx) => {
      const rec = await this.upsertStageRecord(
        tx.procurementResultReport as any,
        taskId,
        task.projectId,
        payload,
        body?.version,
      );
      // 定标结果同步到结构化行：勾选即「中标」（并写入最终确认价格），取消勾选回落到入围/已递交。
      // 幂等：先补齐结构化行（存量/从未导入过的任务），再按 candidates 覆盖这两件事。
      // 与报告快照同事务：中途失败不能留下「快照已改、结构化行没跟上」的两份事实分叉。
      if (candidates !== undefined) {
        await this.ensureBiddersFromSnapshot({ id: task.id, projectId: task.projectId }, tx);
        await this.applyCandidateStatuses(task.id, candidates, tx);
      }
      return rec;
    });
    return this.serializeResultReport(saved);
  }

  /**
   * 任务 7：成交报告「退回 → 重发」（纯状态回退）。
   * 退回：清除成交报告发布时间、回退任务阶段到「成交报告编制中」、清理已自动生成的合同（草稿态），
   * 使报告可重新编辑并再次发布（重发）。
   * 若下游合同已签章/待签章，则禁止退回，需先驳回合同，避免产生孤儿合同。
   */
  async rejectResultReport(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    // 下游已生成的合同（关联只由 Contract.taskId 表达）：取主合同用于状态守卫
    const linked = await mainContract(this.prisma, taskId);
    // 成交报告阶段下标（由阶段链推导，退回时回退到该下标）
    const reportIndex = resultReportStageIndex(task);
    // 状态机守卫（单一事实源）：仅单项采购 + 成交报告已发布 + 下游合同仍为草稿/不存在
    assertResultReportRejectable({
      type: task.type,
      stage: task.stage,
      reportStageIndex: reportIndex,
      linkedContractStatus: linked?.status ?? null,
    });
    if (linked) {
      // 清除已自动生成（草稿态）的合同，避免孤儿。合同行归 contract 模块，走它的写入原语。
      await deleteContractsOfTask(this.prisma, taskId);
    }
    await this.prisma.procurementResultReport.updateMany({
      where: { taskId },
      data: { publishedAt: null },
    });
    const updated = await this.prisma.procurementTask.update({
      where: { id: taskId },
      data: { stage: reportIndex, status: TASK_STATUS.RESULT_EDITING, version: { increment: 1 } },
    });
    return serializeTask(updated);
  }

  /**
   * 导入「响应单位情况汇总表」（Excel）。
   * 解析后覆盖式写入响应单位明细，四张表随之自动重建。
   */
  async importResultReport(taskId: string, buffer?: Buffer, user?: any) {
    if (!buffer) throw new BadRequestException('未上传文件');
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE') {
      throw new BadRequestException('仅「单项采购」类型的采购任务可使用成交报告模块');
    }
    if (task.stage < resultReportStageIndex(task)) {
      throw new BadRequestException('请先发布采购文件（采购文件已完成）后再导入响应单位情况汇总表');
    }

    // 解析表头（第 1 行）之后的所有行。不再按行号硬性跳过第 2 行示例行，
    // 否则用户在示例行直接填写真实数据（高频用法）时该行会被丢弃，表现为「第二行导入失败」。
    const rawRows = await this.excel.parse(buffer, []);
    if (!rawRows.length)
      throw new BadRequestException('导入文件无有效数据行（请从第 3 行起填写，或直接在示例行填入真实数据）');

    const str = (v: any): string => String(v ?? '').trim();

    // 识别并跳过模板自带的示例行（第 2 行）：仅当其字段与模板示例完全一致时才视为示例行；
    // 用户若在示例行填入真实数据，则视为数据行，从而避免漏导。
    const isExampleRow = (r: any): boolean =>
      str(r['参与响应单位名称']) === '某某建材有限公司' &&
      num(r['第一轮报价不含税总额']) === 985000 &&
      num(r['第一轮报价税金']) === 128050 &&
      num(r['第二轮报价不含税总额']) === 960000 &&
      num(r['第二轮报价税金']) === 124800;

    const rows = rawRows.filter((r) => !isExampleRow(r));
    if (!rows.length)
      throw new BadRequestException('导入文件无有效数据行（识别到的行均为模板示例行，请填写真实数据）');

    const suppliers = rows.map((r, i) => ({
      seq: num(r['序号']) ?? i + 1,
      name: str(r['参与响应单位名称']),
      depositPaid: str(r['响应保证金是否缴纳']),
      sealed: str(r['响应文件密封是否完整']),
      passedFirst: str(r['是否通过第一轮报价']),
      firstPreTaxTotal: num(r['第一轮报价不含税总额']),
      firstTax: num(r['第一轮报价税金']),
      secondPreTaxTotal: num(r['第二轮报价不含税总额']),
      secondTax: num(r['第二轮报价税金']),
      remark: str(r['备注']),
    }));
    const invalid = suppliers.filter((s) => !s.name);
    if (invalid.length) {
      throw new BadRequestException(
        `导入校验失败：第 ${invalid.map((s) => s.seq).join('、')} 行缺少「参与响应单位名称」`,
      );
    }

    const saved = await this.prisma.$transaction(async (tx) => {
      const rec = await tx.procurementResultReport.upsert({
        where: { taskId },
        create: { projectId: task.projectId, taskId, suppliers },
        update: { suppliers },
      });
      // 招标域结构化（下一期）：同一事务内双写结构化投标单位——
      // JSON 快照照旧（发布文档与既有数据口径不变），结构化行成为查询/评标/定标衔接的事实源。
      await this.syncBiddersFromSuppliers(
        tx,
        { id: task.id, projectId: task.projectId },
        suppliers,
        user?.userId ?? null,
      );
      return rec;
    });
    return {
      imported: suppliers.length,
      created: suppliers.length,
      ...this.serializeResultReport(saved),
    };
  }

  /* ---------------- 招标域：结构化投标单位 + 评标记录 ---------------- */

  /**
   * 把导入的响应单位写入/更新结构化表（**双写**的另一半）。
   * - 唯一键 `(taskId, bidderName)`：重名单位在同一任务内视为同一家（与导入表语义一致）；
   * - 只更新**导入来的列**，保留用户维护的 `status` / `bidFileUrl` / `finalPreTaxTotal`
   *   （重新导入不该清掉「已定标」「已上传投标文件」这类人工结果）；
   * - 导入表里**已不存在**的单位会被删除，但**有评标记录的拒绝删除并报错**——
   *   静默丢掉用户填的评标数据比报错更糟，让用户先显式处理。
   */
  private async syncBiddersFromSuppliers(
    tx: Prisma.TransactionClient,
    task: { id: string; projectId: string },
    suppliers: Array<Record<string, any>>,
    createdBy: string | null = null,
  ): Promise<void> {
    const names = suppliers.map((s) => String(s?.name ?? '').trim()).filter(Boolean);

    const stale = await tx.procurementBidder.findMany({
      where: { taskId: task.id, bidderName: { notIn: names } },
      select: { id: true, bidderName: true, _count: { select: { evaluations: true } } },
    });
    const guarded = stale.filter((b) => b._count.evaluations > 0);
    if (guarded.length) {
      throw new BadRequestException(
        `以下响应单位已有评标记录，重新导入不会删除它们：${guarded
          .map((b) => b.bidderName)
          .join('、')}。请先在评标记录中删除，或把该单位保留在导入表中。`,
      );
    }
    if (stale.length) {
      await tx.procurementBidder.deleteMany({ where: { id: { in: stale.map((b) => b.id) } } });
    }

    for (const s of suppliers) {
      const bidderName = String(s?.name ?? '').trim();
      if (!bidderName) continue;
      const imported = {
        seq: s?.seq ?? null,
        depositPaid: textOf(s?.depositPaid),
        sealed: textOf(s?.sealed),
        passedFirst: textOf(s?.passedFirst),
        firstPreTaxTotal: s?.firstPreTaxTotal ?? null,
        firstTax: s?.firstTax ?? null,
        secondPreTaxTotal: s?.secondPreTaxTotal ?? null,
        secondTax: s?.secondTax ?? null,
        remark: textOf(s?.remark),
        supplierId: await resolveSupplierId(this.prisma, bidderName),
      };
      await tx.procurementBidder.upsert({
        where: { taskId_bidderName: { taskId: task.id, bidderName } },
        create: { projectId: task.projectId, taskId: task.id, bidderName, createdBy, ...imported },
        update: imported,
      });
    }
  }

  /**
   * 存量回填（幂等）：成交报告只有 JSON 快照、结构化行还没建立的采购任务，在**首次读取或生成合同**时补齐。
   * 之所以不做成一次性迁移脚本：空库、存量库、重复执行三种情况同一套逻辑即可覆盖，
   * 也不会因历史数据形态差异（缺字段/名称重复）让迁移半途失败。
   */
  async ensureBiddersFromSnapshot(task: { id: string; projectId: string }, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    const existing = await db.procurementBidder.count({ where: { taskId: task.id } });
    if (existing > 0) return;
    const report = await db.procurementResultReport.findUnique({ where: { taskId: task.id } });
    const suppliers = parseJsonArray<Record<string, any>>(report?.suppliers);
    if (!suppliers.length) return; // 无快照可回填（尚未导入）
    // 同名单位在导入表里重复时唯一键会撞：按名称去重，保留首行（与前端展示口径一致）
    const seen = new Set<string>();
    const deduped = suppliers.filter((s) => {
      const n = String(s?.name ?? '').trim();
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
    /**
     * 回填 + 定标状态同步在同一事务：外传 tx 时沿用（保存成交报告路径），
     * 否则自开事务（读取时幂等回填路径）。
     */
    const applyAll = async (t: Prisma.TransactionClient) => {
      await this.syncBiddersFromSuppliers(t, task, deduped);
      await this.applyCandidateStatuses(
        task.id,
        parseJsonArray<Record<string, any>>(report?.candidates),
        t,
      );
    };
    if (tx) await applyAll(tx);
    else await this.prisma.$transaction(applyAll);
  }

  /**
   * 定标结果 → 结构化状态（在保存成交报告 / 存量回填后调用）：
   * - 勾选中的候选人 → `WON` + 写入最终确认不含税价格（生成合同的取价来源）；
   * - 原先 `WON` 但已取消勾选 → 回落「入围 / 已递交」（纯函数 `bidderStatusWhenNotWon()`）并清空确认价；
   * - **其它状态（弃权/未中标等）不动**——那是用户在手维度的结果，服务端不覆盖。
   */
  private async applyCandidateStatuses(
    taskId: string,
    candidates: Array<Record<string, any>>,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const rows = await db.procurementBidder.findMany({ where: { taskId } });
    if (!rows.length) return;
    const byName = new Map(rows.map((r) => [r.bidderName, r]));
    const won = new Set<string>();

    for (const c of candidates) {
      const name = String(c?.name ?? '').trim();
      if (!name) continue;
      const row = byName.get(name);
      if (!row) continue; // 候选人不在导入表内：不静默新建结构化行（正常流程不会出现）
      won.add(name);
      // 存量快照里的价格可能是历史脏数据（非数字）：这里兜成 null 而不是把 NaN 写进 Decimal 列
      const rawPrice = c?.finalPreTaxPrice == null || c.finalPreTaxPrice === '' ? null : Number(c.finalPreTaxPrice);
      const price = rawPrice !== null && Number.isFinite(rawPrice) ? rawPrice : null;
      const current = row.finalPreTaxTotal == null ? null : Number(row.finalPreTaxTotal);
      if (row.status !== BIDDER_STATUS.WON || current !== price) {
        await db.procurementBidder.update({
          where: { id: row.id },
          data: { status: BIDDER_STATUS.WON, finalPreTaxTotal: price },
        });
      }
    }

    for (const row of rows) {
      if (row.status === BIDDER_STATUS.WON && !won.has(row.bidderName)) {
        await db.procurementBidder.update({
          where: { id: row.id },
          data: { status: bidderStatusWhenNotWon(row.passedFirst), finalPreTaxTotal: null },
        });
      }
    }
  }

  /** 结构化投标单位 + 评标记录（成交报告页「结构化面板」的数据源；读取时顺带幂等回填存量） */
  async bidders(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    await this.ensureBiddersFromSnapshot({ id: task.id, projectId: task.projectId });
    const [rows, evaluations] = await Promise.all([
      this.prisma.procurementBidder.findMany({
        where: { taskId },
        orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.procurementEvaluation.findMany({
        where: { taskId },
        orderBy: [{ evaluatedAt: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return {
      taskId,
      bidders: rows.map((r) => this.serializeBidder(r)),
      evaluations: evaluations.map((r) => this.serializeEvaluation(r)),
    };
  }

  /**
   * 保存结构化投标单位（只改用户手维的四个字段：状态 / 投标文件 / 最终确认价 / 备注）。
   * 单位本身（名称、两轮报价）来自导入表，不在这里改，避免与 JSON 快照口径分叉。
   */
  async saveBidders(taskId: string, body: any) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    const list: Array<Record<string, any>> = Array.isArray(body?.bidders) ? body.bidders : [];
    const rows = await this.prisma.procurementBidder.findMany({ where: { taskId }, select: { id: true } });
    const ids = new Set(rows.map((r) => r.id));
    const price = numOf('最终确认不含税价格', { min: 0 });

    for (const item of list) {
      const id = String(item?.id ?? '').trim();
      if (!id) continue;
      // 项目/任务隔离：id 必须属于本任务，否则视为越权（不静默跳过）
      if (!ids.has(id)) throw new BadRequestException('投标单位不属于该采购任务');
      const status = await this.dict.validate(DICT_TYPES.BIDDER_STATUS, item?.status, true);
      await this.prisma.procurementBidder.update({
        where: { id },
        data: {
          status: status as string,
          bidFileUrl: textOf(item?.bidFileUrl),
          finalPreTaxTotal: price(item?.finalPreTaxTotal),
          remark: textOf(item?.remark),
        },
      });
    }
    return this.bidders(taskId);
  }

  /**
   * 保存评标记录（**全量替换**：先按任务清空再写入，与「响应单位/候选人」的覆盖式保存同一口径）。
   * 校验：评委必填、结论走字典、单位必须属于本任务（防跨任务写入）。
   */
  async saveEvaluations(taskId: string, body: any) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    const list: Array<Record<string, any>> = Array.isArray(body?.evaluations) ? body.evaluations : [];
    const rows = await this.prisma.procurementBidder.findMany({ where: { taskId }, select: { id: true } });
    const ids = new Set(rows.map((r) => r.id));
    const score = numOf('评标得分', { min: 0 });
    const rank = intOf('评标排名', { min: 1 });
    const at = dateOf('评标时间');

    const data: Prisma.ProcurementEvaluationUncheckedCreateInput[] = [];
    for (const item of list) {
      const bidderId = String(item?.bidderId ?? '').trim();
      if (!bidderId) throw new BadRequestException('评标记录必须选择响应单位');
      if (!ids.has(bidderId)) throw new BadRequestException('评标单位的响应单位不属于该采购任务');
      const evaluator = textOf(item?.evaluator);
      if (!evaluator) throw new BadRequestException('评标记录的「评委」必填');
      data.push({
        projectId: task.projectId,
        taskId,
        bidderId,
        evaluator,
        score: score(item?.score),
        rank: rank(item?.rank),
        conclusion: await this.dict.validate(DICT_TYPES.EVALUATION_CONCLUSION, item?.conclusion),
        comment: textOf(item?.comment),
        evaluatedAt: at(item?.evaluatedAt),
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.procurementEvaluation.deleteMany({ where: { taskId } });
      for (const d of data) await tx.procurementEvaluation.create({ data: d });
    });
    return this.bidders(taskId);
  }

  private serializeBidder(b: any) {
    return {
      id: b.id,
      taskId: b.taskId,
      supplierId: b.supplierId ?? null,
      bidderName: b.bidderName,
      seq: b.seq,
      depositPaid: b.depositPaid ?? '',
      sealed: b.sealed ?? '',
      passedFirst: b.passedFirst ?? '',
      firstPreTaxTotal: b.firstPreTaxTotal == null ? null : Number(b.firstPreTaxTotal),
      firstTax: b.firstTax == null ? null : Number(b.firstTax),
      secondPreTaxTotal: b.secondPreTaxTotal == null ? null : Number(b.secondPreTaxTotal),
      secondTax: b.secondTax == null ? null : Number(b.secondTax),
      finalPreTaxTotal: b.finalPreTaxTotal == null ? null : Number(b.finalPreTaxTotal),
      status: b.status,
      bidFileUrl: b.bidFileUrl ?? '',
      remark: b.remark ?? '',
      updatedAt: b.updatedAt,
    };
  }

  private serializeEvaluation(e: any) {
    return {
      id: e.id,
      taskId: e.taskId,
      bidderId: e.bidderId,
      evaluator: e.evaluator,
      score: e.score == null ? null : Number(e.score),
      rank: e.rank,
      conclusion: e.conclusion ?? '',
      comment: e.comment ?? '',
      evaluatedAt: e.evaluatedAt,
    };
  }

  /** 「响应单位情况汇总表」导入模板（表头与导入解析列名一致） */
  async resultReportTemplate() {
    const yesNo = ['是', '否'];
    const columns: TemplateColumn[] = [
      { label: '序号', key: 'seq', type: 'int', width: 8, example: 1, desc: '可留空，系统按行序自动编号' },
      { label: '参与响应单位名称', key: 'name', required: true, type: 'text', width: 30, example: '某某建材有限公司' },
      { label: '响应保证金是否缴纳', key: 'depositPaid', type: 'select', width: 20, example: '是', options: yesNo },
      { label: '响应文件密封是否完整', key: 'sealed', type: 'select', width: 22, example: '是', options: yesNo },
      {
        label: '是否通过第一轮报价',
        key: 'passedFirst',
        type: 'select',
        width: 20,
        example: '是',
        options: yesNo,
        desc: '为「否」的单位不参与第二轮报价情况表',
      },
      {
        label: '第一轮报价不含税总额',
        key: 'firstPreTaxTotal',
        type: 'money',
        width: 22,
        example: 985000,
        desc: '单位：元；开启报价情况表按此列由小到大排名',
      },
      { label: '第一轮报价税金', key: 'firstTax', type: 'money', width: 18, example: 128050 },
      {
        label: '第二轮报价不含税总额',
        key: 'secondPreTaxTotal',
        type: 'money',
        width: 22,
        example: 960000,
        desc: '单位：元；第二轮报价情况表按此列由小到大排名',
      },
      { label: '第二轮报价税金', key: 'secondTax', type: 'money', width: 18, example: 124800 },
      { label: '备注', key: 'remark', type: 'text', width: 24, example: '' },
    ];
    return this.tpl.buildTemplate({
      moduleName: '响应单位情况汇总表',
      sheetName: '数据',
      columns,
      extraNotes: [
        '说明：导入后自动生成「响应单位情况汇总表 / 开启报价情况表 / 第二轮报价情况表 / 拟推荐成交候选人表」四张表。',
        '说明：重复导入将覆盖已有的响应单位明细，不影响手工填写的成交报告基本信息。',
      ],
    });
  }

  /**
   * 采购价格对比表（批次二 · 任务 3.6，仅「单项采购」任务）。
   * 入口条件：成交报告已完成（stage > 成交报告阶段下标）；本阶段编辑中 ⇔ stage === 价格对比表下标。
   *
   * 明细表列（共 15 列）：
   * - 序号 / 采购名称 / 规格型号 / 单位 / 数量 / 清单收入不含税单价 / 标准成本不含税单价 /
   *   控制价不含税单价 / 信息价不含税单价 —— 全部来自总采购清单（ProcurementTotalItem），
   *   只读派生、不落库；
   * - 成交价不含税单价 / 备注 —— 用户录入，落库于 items（按 materialBaseId 归位）；
   * - 各价格合价与「采购成本降低率 / 采购成交价下浮率 / 信息价下浮率」由前端计算。
   */
  async priceCompare(taskId: string) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE' && task.type !== 'FRAMEWORK') {
      throw new BadRequestException('仅「单项采购 / 引用框架协议」类型的采购任务可使用采购价格对比表模块');
    }
    const reportIndex = resultReportStageIndex(task);
    const stageIndex = priceCompareStageIndex(task);
    const reached = task.stage >= stageIndex;
    const published = task.stage > stageIndex;
    const record = await this.prisma.procurementPriceCompare.findUnique({ where: { taskId } });
    const notice = await this.prisma.procurementNotice.findUnique({ where: { taskId } });
    const totals = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });

    // 已保存行按 materialBaseId 归位（兼容早期按下标保存的数据）
    const savedRows = parseJsonArray<Record<string, any>>(record?.items);
    const savedMap = new Map<string, Record<string, any>>();
    savedRows.forEach((r, i) => {
      const k = String(r?.materialBaseId ?? '');
      if (k) savedMap.set(k, r);
      else if (totals[i]) savedMap.set(totals[i].id, r);
    });

    // 明细行 = 总采购清单派生 + 叠加已保存的「成交价 / 备注」
    const items = totals.map((t) => {
      const saved = savedMap.get(t.id) ?? {};
      return {
        materialBaseId: t.id,
        materialName: t.materialName,
        spec: t.spec,
        unit: t.unit,
        qty: t.qty,
        incomePrice: t.incomePrice,
        stdCost: t.stdCost,
        planPrice: t.planPrice,
        infoPrice: t.infoPrice,
        dealPrice: saved.dealPrice ?? null,
        remark: String(saved.remark ?? ''),
      };
    });

    return {
      task: serializeTask(task),
      stageIndex,
      resultReportStageIndex: reportIndex,
      /** 成交报告是否已完成（价格对比表的入口条件） */
      resultReportCompleted: task.stage > reportIndex,
      reached,
      editable: reached && !published,
      ...this.statusBlock(published),
      /** 采购内容（默认取采购公告内容，其次取采购任务内容） */
      content: notice?.content ?? task.content ?? '',
      /** 明细表行（派生 + 已保存的成交价/备注） */
      items,
      data: record ? { ...this.serializePriceCompare(record), items } : null,
    };
  }

  /** 保存采购价格对比表（编辑中/已完成均可保存；发布后重新编辑保留 publishedAt） */
  async savePriceCompare(taskId: string, body: any) {
    const task = await taskOf(this.prisma, taskId);
    if (!task) throw new NotFoundException('采购任务不存在');
    if (task.type !== 'SINGLE' && task.type !== 'FRAMEWORK') {
      throw new BadRequestException('仅「单项采购 / 引用框架协议」类型的采购任务可使用采购价格对比表模块');
    }
    if (task.stage < priceCompareStageIndex(task)) {
      throw new BadRequestException('请先发布上一阶段（总采购清单）后再编制采购价格对比表');
    }

    const text = textOf;
    const num = (v: any, label: string): number | null => numOf(label, { min: 0 })(v);

    const method = text(body?.pricingMethod);
    if (method && !['FIXED', 'FLOATING'].includes(method)) {
      throw new BadRequestException('计价方式仅支持「固定价」或「浮动价」');
    }

    // 明细行：仅接受「成交价 / 备注」为用户输入，其余列以总采购清单为准回填，防止前端篡改；
    // 行序与总采购清单保持一致，未提交的行补齐为空白行。
    const totals = await this.prisma.procurementTotalItem.findMany({
      where: { taskId },
      orderBy: { sortOrder: 'asc' },
    });
    const submitted = new Map<string, any>();
    (Array.isArray(body?.items) ? body.items : []).forEach((r: any) => {
      const k = String(r?.materialBaseId ?? '').trim();
      if (k) submitted.set(k, r);
    });
    const items = totals.map((t) => {
      const r = submitted.get(t.id) ?? {};
      return {
        materialBaseId: t.id,
        materialName: t.materialName,
        spec: t.spec,
        unit: t.unit,
        qty: t.qty,
        incomePrice: t.incomePrice,
        stdCost: t.stdCost,
        planPrice: t.planPrice,
        infoPrice: t.infoPrice,
        dealPrice: num(r?.dealPrice, '成交价不含税单价'),
        remark: String(r?.remark ?? '').trim(),
      };
    });

    const payload = {
      pricingMethod: method,
      benefitAnalysis: text(body?.benefitAnalysis),
      items: JSON.stringify(items),
    };
    const saved = await this.upsertStageRecord(
      this.prisma.procurementPriceCompare as any,
      taskId,
      task.projectId,
      payload,
      body?.version,
    );
    return this.serializePriceCompare(saved);
  }

  private serializePriceCompare(r: {
    id: string;
    taskId: string;
    pricingMethod: string | null;
    benefitAnalysis: string | null;
    items: string | null;
    publishedAt: Date | null;
    version?: number;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      taskId: r.taskId,
      version: r.version ?? 0,
      pricingMethod: r.pricingMethod ?? '',
      benefitAnalysis: r.benefitAnalysis ?? '',
      items: parseJsonArray<Record<string, any>>(r.items),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }

  private serializeResultReport(r: {
    id: string;
    taskId: string;
    unitCount: number | null;
    openTime: Date | null;
    openPlace: string | null;
    reviewMembers: string | null;
    approvedCount: number | null;
    participantCount: number | null;
    abstainCount: number | null;
    validFileCount: number | null;
    suppliers: JsonValue | null;
    candidates: JsonValue | null;
    publishedAt: Date | null;
    version?: number;
    updatedAt: Date;
  }) {
    return {
      id: r.id,
      taskId: r.taskId,
      version: r.version ?? 0,
      unitCount: r.unitCount,
      openTime: r.openTime,
      openPlace: r.openPlace ?? '',
      reviewMembers: r.reviewMembers ?? '',
      approvedCount: r.approvedCount,
      participantCount: r.participantCount,
      abstainCount: r.abstainCount,
      validFileCount: r.validFileCount,
      suppliers: parseJsonArray(r.suppliers),
      candidates: parseJsonArray(r.candidates),
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    };
  }
}

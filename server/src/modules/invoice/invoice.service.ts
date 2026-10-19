import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion, IMPORT_MAX_ROWS } from '../../common/utils/helpers';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { DICT_TYPES, INVOICE_REVIEW_STATUS, INVOICE_STATUS } from '../../constants/statuses';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { recognizeInvoiceImage } from './invoice-recognizer';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { SettlementService } from '../settlement/settlement.service';
import { periodMonthKey } from '../../common/utils/settlement-period';

const INVOICE_FIELD_LABEL: Record<string, string> = { amountBeforeTax: '税前金额', amountWithTax: '含税金额' };
const INVOICE_FIELDS = [
  'projectId', 'contractId', 'settlementId', 'goodsCategory', 'settlePeriod', 'invoiceCode', 'invoiceNo',
  'typeCode', 'invoiceDate', 'issuer', 'receiver', 'amountBeforeTax', 'taxRate',
  'amountWithTax', 'receiveDate', 'reviewStatus', 'responsiblePerson', 'financeTransferStatus',
  'imageUrl', 'statusCode', 'remark',
];

@Injectable()
export class InvoiceService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private styled: StyledExcelService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
    private settlement: SettlementService,
  ) {}

  async findAll(query: any = {}, projectId: string, maxPageSize = 500) {
    const { skip, take } = paginate(query, maxPageSize);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.reviewStatus) where.reviewStatus = query.reviewStatus;
    if (query.goodsCategory) where.goodsCategory = query.goodsCategory;
    if (query.invoiceNo) where.invoiceNo = { contains: query.invoiceNo };
    if (query.keyword) where.OR = [{ invoiceNo: { contains: query.keyword } }, { issuer: { contains: query.keyword } }];
    const [list, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: {
          contract: { select: { id: true, code: true, name: true, supplierId: true, supplier: { select: { id: true, name: true } } } },
          settlement: { select: { id: true, code: true, settleDate: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string, projectId?: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: { contract: true, settlement: { select: { id: true, code: true, settleDate: true } } },
    });
    if (!inv) throw new NotFoundException('发票不存在');
    // 防御纵深：路由层已按项目校验成员关系，这里再核一次归属，避免按 id 直读跨项目发票
    if (projectId && (inv as any).contract?.projectId !== projectId) throw new NotFoundException('发票不存在');
    return inv;
  }

  /** 发票号码查重（同一项目内唯一） */
  async checkNo(invoiceNo: string, projectId: string, excludeId?: string) {
    if (!invoiceNo) return { exists: false };
    const where: any = { projectId, invoiceNo };
    if (excludeId) where.id = { not: excludeId };
    const exist = await this.prisma.invoice.findFirst({ where });
    return { exists: !!exist };
  }

  private async validate(data: any) {
    await this.dict.validate('invoice_type', data.typeCode);
    await this.dict.validate(DICT_TYPES.INVOICE_STATUS, data.statusCode);
    await this.dict.validate(DICT_TYPES.INVOICE_REVIEW_STATUS, data.reviewStatus);
    await this.dict.validate('finance_transfer_status', data.financeTransferStatus);
    await this.dict.validate('goods_category', data.goodsCategory);
  }

  /**
   * 结算单关联（业务口径 2026-10-16「发票与结算单对应，一张结算单可对多张发票」）：
   *
   * - 请求里**明确带了** `settlementId`（含显式 `null` 解绑）→ 当人工指定处理，
   *   先校验「同项目 / 同合同 / 同月份」（见 `SettlementService.assertLinkable`）再落库；
   * - **没带**且该发票原本也没关联 → **自动匹配**同合同同月的结算单
   *   （发票的月份取「结算账期」文本，认不出就用开票日期，与台账口径一致）；
   * - 已有关联且请求没带 → **保持不动**（不覆盖人工选择）。
   *
   * 返回值 `undefined` 表示"不改动"（`pickFields` 里没有这个键就不会写库）。
   */
  private async resolveSettlementId(
    payload: any,
    projectId: string,
    before?: any,
  ): Promise<string | null | undefined> {
    /**
     * 这张发票的「日期」——结算期归属用。
     * `结算账期` 只精确到月，故取该月 1 日作为代表日期（与台账按账期归集同口径）；
     * 账期认不出时才用开票日期。⚠️ 与 `SettlementService.linkOrphansForContract` 同一口径。
     */
    const period = payload.settlePeriod ?? before?.settlePeriod;
    const key = periodMonthKey(period);
    const date = key ? new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1) : (payload.invoiceDate ?? before?.invoiceDate);
    const contractId = payload.contractId !== undefined ? payload.contractId : before?.contractId;
    if (payload.settlementId !== undefined) {
      if (!payload.settlementId) return null; // 显式解绑
      await this.settlement.assertLinkable(payload.settlementId, projectId, { contractId, date, label: '发票' });
      return payload.settlementId;
    }
    if (before?.settlementId) return undefined;
    return this.settlement.findSettlementIdFor(contractId, date);
  }

  /**
   * 发票变化后刷新结算台账的「本月开票额」。
   * 改造前发票是**独立**于台账的（改发票要等人工点「刷新台账」才同步），
   * 现在发票与结算单相挂，台账那一列必须跟着动，否则关联了也看不出效果。
   * ⚠️ 只在**交互式写入**（无事务）时调用：`syncLedgerByContract` 走事务外连接，
   *   事务内读不到未提交的数据（同 `SettlementService.create` 的说明）。
   */
  private async syncLedger(contractId: string | null | undefined, tx?: TxClient) {
    if (tx || !contractId) return;
    await this.settlement.linkOrphansForContract(contractId);
    await this.settlement.syncLedgerByContract(contractId);
  }

  /** 负金额是录入错误（与导入路径同一口径，2026-10-18 审计）；create/update 共用 */
  private assertNoNegativeAmounts(payload: Record<string, any>) {
    for (const f of ['amountBeforeTax', 'amountWithTax'] as const) {
      if (payload[f] != null && payload[f] < 0) throw new BadRequestException(`${INVOICE_FIELD_LABEL[f]}不能为负数`);
    }
  }

  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.validate(data);
    if (data.invoiceNo) {
      const { exists } = await this.checkNo(data.invoiceNo, projectId);
      if (exists) throw new BadRequestException(`发票号码 ${data.invoiceNo} 在当前项目中已存在`);
    }
    const payload: any = { ...pickFields(data, INVOICE_FIELDS, { label: '发票' }), projectId };
    ['amountBeforeTax', 'taxRate', 'amountWithTax'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    // 负金额是录入错误（与导入路径同一口径，2026-10-18 审计）
    this.assertNoNegativeAmounts(payload);
    if (data.invoiceDate) payload.invoiceDate = toDate(data.invoiceDate);
    if (data.receiveDate) payload.receiveDate = toDate(data.receiveDate);
    // 开票单位可通过合同关联供应商库自动带出
    if (!payload.issuer && payload.contractId) {
      const c = await this.prisma.contract.findUnique({ where: { id: payload.contractId }, include: { supplier: true } });
      payload.issuer = (c as any)?.supplier?.name;
    }
    const link = await this.resolveSettlementId(payload, projectId);
    if (link !== undefined) payload.settlementId = link;
    const created = await db.invoice.create({ data: payload });
    await this.syncLedger(payload.contractId, tx);
    return created;
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    await this.validate({ ...before, ...data });
    if (data.invoiceNo && data.invoiceNo !== before.invoiceNo) {
      const { exists } = await this.checkNo(data.invoiceNo, before.projectId, id);
      if (exists) throw new BadRequestException(`发票号码 ${data.invoiceNo} 在当前项目中已存在`);
    }
    const payload: any = pickFields(data, INVOICE_FIELDS, { label: '发票' });
    ['amountBeforeTax', 'taxRate', 'amountWithTax'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    this.assertNoNegativeAmounts(payload);
    if (data.invoiceDate) payload.invoiceDate = toDate(data.invoiceDate);
    if (data.receiveDate) payload.receiveDate = toDate(data.receiveDate);
    delete payload.version;
    const link = await this.resolveSettlementId(payload, before.projectId, before);
    if (link !== undefined) payload.settlementId = link;
    const updated = await this.prisma.invoice.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
    // 合同可能被改到别的合同上 → 两个合同的开票额都要重算
    for (const cid of new Set([before.contractId, payload.contractId ?? before.contractId].filter(Boolean))) {
      await this.syncLedger(cid as string);
    }
    return updated;
  }

  async remove(id: string) {
    const before: any = await this.findOne(id);
    await this.prisma.invoice.delete({ where: { id } });
    await this.syncLedger(before.contractId);
    return true;
  }

  /**
   * 发票「查验」：把「待查验」置为「已查验」——用于**登记核对**
   * （业务口径：录入/核对该发票的信息后标记为已查验）。
   *
   * ⚠️ **不做验真**，也不接第三方查验服务（如航信/百望）——业务侧明确不需要。
   * 发票信息采集走 `POST /invoices/recognize`（二维码/OCR 识别）+ 人工补录。
   */
  async verify(id: string) {
    const inv = await this.findOne(id);
    return this.prisma.invoice.update({
      where: { id },
      data: {
        statusCode:
          inv.statusCode === INVOICE_STATUS.WAIT_VERIFY ? INVOICE_STATUS.VERIFIED : inv.statusCode,
      },
    });
  }

  // ---------------- 批量识别 ----------------
  /** 上传发票图片，解码左上角二维码提取发票代码/号码/日期/金额 */
  recognize(files: any[]) {
    return files.map((f) => {
      const r = recognizeInvoiceImage(f.buffer);
      return r.ok
        ? { filename: f.originalname, ok: true as const, data: r.data }
        : { filename: f.originalname, ok: false as const, error: (r as any).error };
    });
  }

  /** 批量写入发票台账（识别结果由用户匹配合同、补全税率后提交） */
  async batchCreate(items: any[], projectId: string, user: any) {
    let created = 0;
    const errors: string[] = [];
    for (const [i, it] of items.entries()) {
      try {
        if (!String(it.invoiceNo || '').trim()) throw new Error('发票号码为空');
        const dup = await this.prisma.invoice.findFirst({ where: { projectId, invoiceNo: String(it.invoiceNo) } });
        if (dup) throw new Error(`发票号码 ${it.invoiceNo} 已存在`);
        const contract = it.contractId ? await this.prisma.contract.findUnique({ where: { id: it.contractId } }) : null;
        if (it.contractId && !contract) throw new Error('关联合同不存在');
        const rate = num(it.taxRate);
        const beforeTax = num(it.amountBeforeTax);
        const withTax = rate !== null && beforeTax !== null
          ? Number((beforeTax * (1 + rate)).toFixed(2))
          : (num(it.amountWithTax) ?? null);
        const invoiceDate = it.invoiceDate ? new Date(it.invoiceDate) : null;
        const d = invoiceDate && !isNaN(invoiceDate.getTime()) ? invoiceDate : null;
        await this.prisma.invoice.create({
          data: {
            projectId,
            contractId: contract?.id ?? null,
            goodsCategory: it.goodsCategory || null,
            settlePeriod: d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : null,
            invoiceCode: it.invoiceCode || null,
            invoiceNo: String(it.invoiceNo),
            typeCode: it.typeCode || 'VAT_SPECIAL',
            invoiceDate: d,
            issuer: it.issuer || null,
            amountBeforeTax: beforeTax,
            taxRate: rate,
            amountWithTax: withTax,
            receiveDate: new Date(),
            reviewStatus: INVOICE_REVIEW_STATUS.PENDING,
            financeTransferStatus: 'NOT_TRANSFERRED',
            statusCode: INVOICE_STATUS.WAIT_VERIFY,
            remark: it.remark || '批量识别导入',
          },
        });
        created += 1;
      } catch (e: any) {
        errors.push(`第 ${i + 1} 条：${e.message}`);
      }
    }
    return { created, errors };
  }

  // ---------------- Excel ----------------
  async export(projectId: string) {
    const res = await this.findAll({ pageSize: 2000 }, projectId, IMPORT_MAX_ROWS);
    const [goods, review, finance] = await Promise.all([
      this.dict.nameMap('goods_category'), this.dict.nameMap('invoice_review_status'),
      this.dict.nameMap('finance_transfer_status'),
    ]);
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const rows = (res.list as any[]).map((i, idx) => ({
      index: idx + 1,
      goodsCategoryName: goods[i.goodsCategory]?.name || '',
      settlePeriod: i.settlePeriod, issuer: i.issuer, invoiceDate: fmt(i.invoiceDate),
      invoiceCode: i.invoiceCode, invoiceNo: i.invoiceNo, amountBeforeTax: num(i.amountBeforeTax),
      taxRate: num(i.taxRate), amountWithTax: num(i.amountWithTax), receiveDate: fmt(i.receiveDate),
      reviewStatusName: review[i.reviewStatus]?.name || '', responsiblePerson: i.responsiblePerson,
      financeTransferName: finance[i.financeTransferStatus]?.name || '', remark: i.remark,
    }));
    const [goodsOpts, financeOpts] = await Promise.all([
      this.dict.options('goods_category'), this.dict.options('finance_transfer_status'),
    ]);
    const names = (list: any[]) => list.map((x: any) => x.itemName).filter(Boolean);
    return this.styled.exportTable({
      sheetName: '发票台账',
      logoColumn: true,
      title: `发票台账（${project?.name || ''}）`,
      columns: [
        { header: '序号', key: 'index', width: 60, type: 'int' },
        { header: '商品类别', key: 'goodsCategoryName', width: 120, type: 'center' },
        { header: '结算账期', key: 'settlePeriod', width: 110, type: 'center' },
        { header: '开票单位', key: 'issuer', width: 180 },
        { header: '开票日期', key: 'invoiceDate', width: 110, type: 'center' },
        { header: '发票代码', key: 'invoiceCode', width: 140, type: 'center' },
        { header: '发票号码', key: 'invoiceNo', width: 140, type: 'center' },
        { header: '税前金额', key: 'amountBeforeTax', width: 140, type: 'money' },
        { header: '税率', key: 'taxRate', width: 80, type: 'pct' },
        { header: '含税金额', key: 'amountWithTax', width: 140, type: 'money' },
        { header: '发票收取时间', key: 'receiveDate', width: 120, type: 'center' },
        { header: '发票信息审核', key: 'reviewStatusName', width: 110, type: 'center' },
        { header: '责任人', key: 'responsiblePerson', width: 90, type: 'center' },
        { header: '财务移交情况', key: 'financeTransferName', width: 120, type: 'center' },
        { header: '备注', key: 'remark', width: 160 },
      ],
      rows,
      totalsKeys: ['amountBeforeTax', 'amountWithTax'],
      totalsLabel: '累计发票金额',
      dropdowns: {
        goodsCategoryName: names(goodsOpts),
        financeTransferName: names(financeOpts),
      },
    });
  }

  /** 发票台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async import(buffer: Buffer, projectId: string, meta?: { fileName?: string; user?: any; validateOnly?: boolean }) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const [goods, review, finance, status, types] = await Promise.all([
      this.dict.options('goods_category'), this.dict.options('invoice_review_status'),
      this.dict.options('finance_transfer_status'), this.dict.options('invoice_status'), this.dict.options('invoice_type'),
    ]);
    const codeOf = (items: any[], name: string) => items.find((i: any) => i.itemName === name || i.itemCode === name)?.itemCode || null;
    /** 本批涉及到的合同：提交后要按这些合同重挂结算单关联并刷新台账 */
    const affected = new Set<string>();
    return this.tasks.submit<any>({ module: 'invoice', moduleName: '发票台账', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        affected.add(contract.id);
        // 税率统一取自合同台账（需求 2.4）：子表未填时继承合同税率
        const taxRaw = num(r['税率(%)']) ?? num(r['税率']);
        let taxRate = taxRaw !== null && taxRaw > 1 ? taxRaw / 100 : taxRaw;
        if (taxRate === null && (contract as any).taxRate != null) {
          const ct = Number((contract as any).taxRate);
          taxRate = ct > 1 ? ct / 100 : ct;
        }
        const amtBefore = num(r['税前金额']);
        const amtWith = num(r['含税金额']);
        if (amtBefore !== null && amtBefore < 0) throw new RowError('税前金额不能为负数', '税前金额');
        if (amtWith !== null && amtWith < 0) throw new RowError('含税金额不能为负数', '含税金额');
        return {
          data: {
            contractId: contract.id,
            goodsCategory: codeOf(goods, r['商品类别']),
            settlePeriod: r['结算账期'] || null,
            issuer: r['开票单位'] || null,
            invoiceDate: r['开票日期'] ? new Date(r['开票日期']) : null,
            invoiceCode: r['发票代码'] || null,
            invoiceNo: r['发票号码'] || null,
            amountBeforeTax: amtBefore,
            taxRate,
            amountWithTax: amtWith,
            receiveDate: r['发票收取时间'] ? new Date(r['发票收取时间']) : null,
            reviewStatus: codeOf(review, r['发票信息审核']),
            responsiblePerson: r['责任人'] || null,
            financeTransferStatus: codeOf(finance, r['财务移交情况']),
            typeCode: codeOf(types, r['发票类型']),
            statusCode: codeOf(status, r['状态']),
            remark: r['备注'] || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.create(p.data, projectId, tx);
        return { created: plans.length };
      },
      /**
       * 提交后收尾：新导入的发票要挂到同月结算单上、并刷新台账的「本月开票额」。
       * ⚠️ 必须在**事务外**做（`write` 里读不到自己刚写的行，且刷新会去读发票/结算单），
       * 故走 runner 的 `afterCommit`；它同时覆盖**异步导入**（>1000 行）路径。
       */
      afterCommit: async () => {
        for (const cid of affected) {
          await this.settlement.linkOrphansForContract(cid);
          await this.settlement.syncLedgerByContract(cid);
        }
      },
    }, meta?.validateOnly ?? false);
  }

  /** 发票台账填写模板（需求 3.3，实际字段口径） */
  async template(projectId: string) {
    const [goods, review, finance, status, types] = await Promise.all([
      this.dict.options('goods_category'), this.dict.options('invoice_review_status'),
      this.dict.options('finance_transfer_status'), this.dict.options('invoice_status'), this.dict.options('invoice_type'),
    ]);
    const names = (list: any[]) => list.map((i: any) => i.itemName).filter(Boolean);
    const columns: TemplateColumn[] = [
      { label: '合同编号', key: 'contractCode', required: true, width: 20, example: 'HT-2026-0001', desc: '须为合同台账中已存在的合同编号' },
      { label: '发票类型', key: 'typeCode', type: 'select', width: 16, example: '增值税专用发票', options: names(types) },
      { label: '商品类别', key: 'goodsCategory', type: 'select', width: 16, example: '工程物资', options: names(goods) },
      { label: '结算账期', key: 'settlePeriod', type: 'text', width: 14, example: '2026-09', desc: '格式 YYYY-MM' },
      { label: '开票单位', key: 'issuer', type: 'text', width: 26, example: '某某钢铁贸易有限公司' },
      { label: '开票日期', key: 'invoiceDate', type: 'date', width: 14, example: '2026-09-01' },
      { label: '发票代码', key: 'invoiceCode', type: 'text', width: 18, example: '5110231140', desc: '全电发票可留空' },
      { label: '发票号码', key: 'invoiceNo', required: true, type: 'text', width: 18, example: '26358871', desc: '同项目内唯一' },
      { label: '税前金额', key: 'amountBeforeTax', type: 'money', width: 14, example: 12345.67 },
      { label: '税率(%)', key: 'taxRatePct', type: 'number', width: 10, example: 13, desc: '百分比数字，如 13 表示 13%' },
      { label: '含税金额', key: 'amountWithTax', type: 'money', width: 14, example: 13950.61 },
      { label: '发票收取时间', key: 'receiveDate', type: 'date', width: 14, example: '2026-09-05' },
      { label: '发票信息审核', key: 'reviewStatus', type: 'select', width: 16, example: '待审核', options: names(review) },
      { label: '责任人', key: 'responsiblePerson', type: 'text', width: 12, example: '王强' },
      { label: '财务移交情况', key: 'financeTransferStatus', type: 'select', width: 16, example: '未移交', options: names(finance) },
      { label: '状态', key: 'statusCode', type: 'select', width: 14, example: '待查验', options: names(status) },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '发票台账', sheetName: '数据', columns });
  }
}

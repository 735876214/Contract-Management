import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '../../common/calc/numeric';
import { toDate, localDayKey } from '../../common/calc/time';
import { IMPORT_MAX_ROWS, assertInProject, assertVersion, buildResult, paginate } from '../../common/utils/helpers';
import { pagedAll } from '../../common/utils/paged';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import {
  DICT_TYPES,
  INVOICE_REVIEW_STATUS,
  INVOICE_STATUS,
  countedInvoiceWhere,
  isInvoiceTerminalStatus,
} from '../../constants/statuses';
import { DictService } from '../dict';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { recognizeInvoiceImage } from './invoice-recognizer';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { SettlementService } from '../settlement';
import { ProjectScopeService } from '../../common/services/project-scope.service';
import { periodMonthKey } from '../../common/utils/settlement-period';
import { parseImportDate, pickDictCode } from '../../common/utils/import-parse';
import { calcAmount, taxAmountDiff } from '../../common/calc/amounts';
import { isFilledNumber } from '../../common/utils/ledger-derived';
import { keywordWhere } from '../../common/utils/list-where';

const INVOICE_FIELD_LABEL: Record<string, string> = { amountBeforeTax: '税前金额', amountWithTax: '含税金额' };
const INVOICE_FIELDS = [
  'projectId', 'contractId', 'settlementId', 'goodsCategory', 'settlePeriod', 'invoiceCode', 'invoiceNo',
  'typeCode', 'invoiceDate', 'issuer', 'receiver', 'amountBeforeTax', 'taxRatePct',
  'amountWithTax', 'receiveDate', 'reviewStatus', 'responsiblePerson', 'financeTransferStatus',
  'imageUrl', 'statusCode', 'redOfInvoiceId', 'remark',
];
/**
 * update 白名单：**不含 projectId**。
 *
 * 归属只能由 create 决定：前端表单种子来自 GET 详情、会整包回传，若 update 也吃 projectId，
 * `PUT /invoices/:id` 带一个别的项目 id 就能把发票搬到别的项目（随后 syncLedger 只按 contractId
 * 重刷，原项目台账的「本月开票额」会停在旧值）。与 contract.service.ts 的
 * CONTRACT_UPDATE_FIELDS 同一处理。
 */
const INVOICE_UPDATE_FIELDS = INVOICE_FIELDS.filter((f) => f !== 'projectId');

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
    private scope: ProjectScopeService,
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
    const kw = keywordWhere(['invoiceNo', 'issuer'], query.keyword);
    if (kw) where.OR = kw.OR;
    // 红冲原票候选：只要有效票（终态票不能再作为红冲对象）。用 AND 包住上面可能已有的 OR
    if (query.excludeTerminal) where.AND = [...(where.AND ?? []), countedInvoiceWhere()];
    const [list, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          contract: { select: { id: true, code: true, name: true, supplierId: true, supplier: { select: { id: true, name: true } } } },
          settlement: { select: { id: true, code: true, settleDate: true } },
          redOf: { select: { id: true, invoiceNo: true } },
          redInvoices: { select: { id: true, invoiceNo: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string, projectId?: string) {
    const inv = await this.prisma.invoice.findUnique({
      where: { id },
      include: {
        contract: true,
        settlement: { select: { id: true, code: true, settleDate: true } },
        redOf: { select: { id: true, invoiceNo: true, statusCode: true } },
        redInvoices: { select: { id: true, invoiceNo: true, statusCode: true } },
      },
    });
    // 防御纵深：路由层已按项目校验成员关系，这里再核一次归属，避免按 id 直读跨项目发票。
    // 用发票自身的 projectId 判定：contractId 可空（无合同的发票审批/编辑同样要能打开），
    // 走 contract.projectId 会把合法的无合同发票误判成「不存在」。
    return assertInProject(inv, projectId, '发票不存在');
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
    // 2026-11-12 复审：改了合同 / 结算账期 / 开票日期时，旧的自动匹配可能已违反
    // 「同合同同期」——与 receipt-order 的同名逻辑保持一致，按新值重算；三者都没变才保留原关联。
    const contractChanged =
      payload.contractId !== undefined && payload.contractId !== before?.contractId;
    const periodChanged =
      (payload.settlePeriod !== undefined && payload.settlePeriod !== before?.settlePeriod) ||
      (payload.invoiceDate !== undefined &&
        new Date(payload.invoiceDate ?? 0).getTime() !== new Date(before?.invoiceDate ?? 0).getTime());
    if (payload.settlementId !== undefined) {
      if (!payload.settlementId) return null; // 显式解绑
      /**
       * 关联没动、合同与账期也没动 → **保持原关联**，不再重新校验：
       * 历史/导入发票可能 `contractId` 为空却已挂在某合同结算单上（台账读侧专门容忍这类票），
       * 重新跑严格同合同校验会 400，导致这张发票编辑任何字段都存不了。
       */
      if (before?.settlementId === payload.settlementId && !contractChanged && !periodChanged) return undefined;
      await this.settlement.assertLinkable(payload.settlementId, projectId, { contractId, date, label: '发票' });
      return payload.settlementId;
    }
    if (before?.settlementId && !contractChanged && !periodChanged) return undefined;
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

  /**
   * 税前金额为必填项（业务口径 2026-11-18）：合同台账的「开累发票税前金额 / 进项税额」改由发票派生，
   * 一张票缺税前就既算不出税前也算不出进项税，故**新增时**必须填写（显式 0 是合法值）。
   * 编辑时只在「把已填的税前清空」时拦截——历史票保留原状，编辑其他字段不受阻。
   */
  private assertBeforeTaxRequired(amountBeforeTax: unknown) {
    if (!isFilledNumber(amountBeforeTax)) throw new BadRequestException('税前金额为必填项，不能为空');
  }

  /**
   * 票面金额自洽：`含税 ≈ 税前 × (1 + 税率)`（容差 1 分）。
   *
   * 税前/税率/含税是三个自由输入字段，服务端此前只校验「税前必填 + 非负」，任一被手改就会
   * 落库一张自身不自洽的票（第 24 轮审计：08812678 税前 661,846.13 × 1.13 = 747,886.13，
   * 含税却记成 748,485.12，差 598.99 → 台账「开累发票进项税额 = 含税 − 税前」随之多算 598.99）。
   *
   * 口径：**只报错不改数**——票面哪个数是准的只有财务知道，静默重算等于替用户改账。
   * 无法判定（缺税率或缺含税：历史票、导入票常见）时放行，不臆造错误。
   */
  private assertAmountConsistent(amountBeforeTax: unknown, taxRatePct: unknown, amountWithTax: unknown) {
    const diff = taxAmountDiff(amountBeforeTax, taxRatePct, amountWithTax);
    if (diff === null || Math.abs(diff) <= 0.01) return;
    const before = num(amountBeforeTax) ?? 0;
    const pct = num(taxRatePct) ?? 0;
    const withT = num(amountWithTax) ?? 0;
    const expect = calcAmount(before, 1 + pct / 100, 2);
    throw new BadRequestException(
      `票面金额不自洽：税前 ¥${before.toFixed(2)} × (1 + ${pct}%) = ¥${expect.toFixed(2)}，` +
        `与含税 ¥${withT.toFixed(2)} 相差 ¥${diff.toFixed(2)}。` +
        '请核对税前金额、税率、含税金额三者中哪一个录错（三者必须自洽，否则台账的进项税额会跟着错）。',
    );
  }

  /**
   * 新建发票。⚠️ `create` / `batchCreate` / `import` **有意不收紧终态**：
   * 历史数据/导入允许直接落 `CANCELLED`/`RED`（导入路径还经 `tx` 复用本方法）；
   * 只有交互式 `PUT` 被 `assertStatusTransition` 拦在终态之外。别把这里的宽松当漏网收紧。
   */
  async create(data: any, projectId: string, tx?: TxClient) {
    await this.validate(data);
    // 引用合同必须属于当前项目（防跨项目串数据）。导入路径的合同由 plan 阶段按项目解析，故只兜交互式写入。
    if (!tx) await this.scope.assertContractInProject(data.contractId, projectId, '关联合同');
    if (data.invoiceNo) {
      const { exists } = await this.checkNo(data.invoiceNo, projectId);
      if (exists) throw new BadRequestException(`发票号码 ${data.invoiceNo} 在当前项目中已存在`);
    }
    const payload: any = { ...pickFields(data, INVOICE_FIELDS, { label: '发票' }), projectId };
    // 空串不是合法的原票外键：归一为 null（否则落库触发外键错误 → 500）
    if (payload.redOfInvoiceId === '') payload.redOfInvoiceId = null;
    ['amountBeforeTax', 'taxRatePct', 'amountWithTax'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    // 负金额是录入错误（与导入路径同一口径，2026-10-18 审计）
    this.assertNoNegativeAmounts(payload);
    // 税前金额必填（台账「开累发票税前金额/进项税额」由发票派生，缺税前就算不出来）
    this.assertBeforeTaxRequired(payload.amountBeforeTax);
    // 三字段自洽（税前 × (1+税率) 必须等于含税，容差 1 分）
    this.assertAmountConsistent(payload.amountBeforeTax, payload.taxRatePct, payload.amountWithTax);
    if (data.invoiceDate) payload.invoiceDate = toDate(data.invoiceDate);
    if (data.receiveDate) payload.receiveDate = toDate(data.receiveDate);
    // 开票单位可通过合同关联供应商库自动带出
    if (!payload.issuer && payload.contractId) {
      const c = await this.prisma.contract.findUnique({ where: { id: payload.contractId }, include: { supplier: true } });
      payload.issuer = (c as any)?.supplier?.name;
    }
    const link = await this.resolveSettlementId(payload, projectId);
    if (link !== undefined) payload.settlementId = link;
    /**
     * 业务口径 2026-11-12：录红冲票时**原票同步作废**。
     * 红冲票（状态 RED）可指定原发票；创建红冲票与作废原票必须在同一事务里，
     * 否则会出现「红冲票已入库、原票仍有效」的半成功状态（两张票都会计入金额口径）。
     */
    const redLink = await this.resolveRedLink(payload, projectId);
    if (redLink) payload.redOfInvoiceId = redLink.id;
    const createAndVoid = async (exec: TxClient | PrismaClient) => {
      const created = await exec.invoice.create({ data: payload });
      if (redLink) await this.voidOriginal(exec, redLink.id);
      return created;
    };
    const created = tx
      ? await createAndVoid(tx)
      : redLink
        ? await this.prisma.$transaction(createAndVoid, { timeout: 30000 })
        : await createAndVoid(this.prisma);
    // 红冲票与原票可能只有一方挂了合同（API 允许 contractId 为空）：两边台账都要刷
    for (const cid of new Set([payload.contractId, redLink?.contractId].filter(Boolean))) {
      await this.syncLedger(cid as string, tx);
    }
    return created;
  }

  /**
   * 红冲票 ↔ 原票（业务口径 2026-11-12：录红冲票时原票同步作废）。
   *
   * 返回需要联动作废的原票行；未指定 / 未变化时返回 `null`。
   * 规则：
   * - 只有红冲票（`statusCode = RED`）才能关联原票；
   * - 原票必须仍有效（未作废/未红冲），且与红冲票同项目（有合同时同合同）；
   * - 关联创建后**不可修改/解绑**（换原票会让「谁作废了谁」失去审计意义）。
   */
  private async resolveRedLink(payload: any, projectId: string, before?: any): Promise<any | null> {
    const beforeId = before?.redOfInvoiceId ?? null;
    // 未传字段 = 沿用原关联（编辑保存不一定整包回传）；空串归一为 null
    const nextId = payload.redOfInvoiceId !== undefined ? (payload.redOfInvoiceId || null) : beforeId;
    if (before && beforeId && nextId !== beforeId) {
      throw new BadRequestException('红冲关联创建后不可修改');
    }
    // 已有关联：不再次触发作废（原票此时已是 CANCELLED），但**无论请求是否带该字段**
    // 都要守住「同合同」不变量——否则 `PUT { contractId }`（省略 redOfInvoiceId）就能把红冲票换到别的合同。
    if (before && beforeId) {
      const linked = await this.prisma.invoice.findFirst({ where: { id: beforeId, projectId } });
      if (!linked) throw new NotFoundException('原发票不存在');
      const nextContractId = payload.contractId !== undefined ? payload.contractId : (before?.contractId ?? null);
      this.assertRedSameContract(linked, nextContractId);
      return null;
    }
    if (!nextId) return null;
    const effectiveStatus = payload.statusCode !== undefined ? payload.statusCode : (before?.statusCode ?? null);
    if (effectiveStatus !== INVOICE_STATUS.RED) {
      throw new BadRequestException('只有红冲票（状态为红冲）才能关联原发票');
    }
    const original = await this.prisma.invoice.findFirst({ where: { id: nextId, projectId } });
    if (!original) throw new NotFoundException('原发票不存在');
    if (before && original.id === before.id) throw new BadRequestException('红冲票不能指向自身');
    if (isInvoiceTerminalStatus(original.statusCode)) {
      throw new BadRequestException('原发票已作废/红冲，不能再作为红冲对象');
    }
    const nextContractId = payload.contractId !== undefined ? payload.contractId : (before?.contractId ?? null);
    this.assertRedSameContract(original, nextContractId);
    return original;
  }

  /** 红冲票与原票必须同合同（任一方未挂合同时不拦） */
  private assertRedSameContract(linked: any, contractId: string | null): void {
    if (linked.contractId && contractId && linked.contractId !== contractId) {
      throw new BadRequestException('红冲票与原发票必须属于同一合同');
    }
  }

  /**
   * 在事务客户端里**原子作废原票**：条件更新校验「原票仍有效」。
   * 校验与写入之间存在并发窗口（两个用户同时录红冲票 / 另一人先作废原票），
   * 无条件 update 会让同一张原票被红冲两次；count 不为 1 时抛错由事务整体回滚。
   */
  private async voidOriginal(exec: TxClient | PrismaClient, originalId: string): Promise<void> {
    const voided = await exec.invoice.updateMany({
      where: { id: originalId, ...countedInvoiceWhere() },
      data: { statusCode: INVOICE_STATUS.CANCELLED, version: { increment: 1 } },
    });
    if (voided.count !== 1) {
      throw new BadRequestException('原发票已作废/红冲，不能再作为红冲对象');
    }
  }

  /**
   * 通用 PUT 不允许把状态**改入/改出**终态（作废/红冲）：
   * 终态必须走列表行上的专用操作（`cancel()` / `red()`），它们会带台账联动与合法校验。
   * 前端编辑表单会整包回传原 `statusCode`——与原值相等不算变更，照常放行。
   * （红冲票与原票的关联只在**新建**时建立；编辑态前端已排除 RED，PUT 不再放行「非终态 → 红冲」。）
   */
  private assertStatusTransition(beforeStatus: string | null, nextStatus: string | null) {
    if (nextStatus === beforeStatus) return;
    if (isInvoiceTerminalStatus(beforeStatus)) {
      throw new BadRequestException('该发票已处于终态（作废/红冲），不能通过编辑修改状态');
    }
    if (isInvoiceTerminalStatus(nextStatus)) {
      throw new BadRequestException('作废/红冲请使用发票列表行上的专用操作');
    }
  }

  async update(id: string, data: any, projectId?: string) {
    const before = await this.findOne(id, projectId);
    assertVersion(before, data);
    // 原票侧同合同不变量：已被红冲的原票不能换合同（红冲票仍指向它，换了就跨合同）
    if (
      (before.redInvoices?.length ?? 0) > 0 &&
      data.contractId !== undefined &&
      (data.contractId ?? null) !== (before.contractId ?? null)
    ) {
      throw new BadRequestException('该发票已被红冲，不能更换合同（红冲票与原发票必须同合同）');
    }
    const nextStatus = data.statusCode !== undefined ? (data.statusCode ?? null) : (before.statusCode ?? null);
    this.assertStatusTransition(before.statusCode ?? null, nextStatus);
    /**
     * 红冲关联**只能在新建红冲票时建立**（计划 §4）。编辑态允许改关联，等于
     * 「PUT 一条 RED 记录 + redOfInvoiceId」就能把任意同合同有效票作废，且没有二次确认。
     */
    const nextRedOfId = data.redOfInvoiceId !== undefined ? (data.redOfInvoiceId || null) : (before.redOfInvoiceId ?? null);
    if (nextRedOfId !== (before.redOfInvoiceId ?? null)) {
      throw new BadRequestException('红冲关联只能在新建红冲票时建立，创建后不可修改');
    }
    await this.validate({ ...before, ...data });
    if (data.contractId !== undefined) {
      await this.scope.assertContractInProject(data.contractId, projectId ?? before.projectId, '关联合同');
    }
    if (data.invoiceNo && data.invoiceNo !== before.invoiceNo) {
      const { exists } = await this.checkNo(data.invoiceNo, before.projectId, id);
      if (exists) throw new BadRequestException(`发票号码 ${data.invoiceNo} 在当前项目中已存在`);
    }
    const payload: any = pickFields(data, INVOICE_UPDATE_FIELDS, { label: '发票' });
    // 空串不是合法的原票外键：归一为 null（否则落库触发外键错误 → 500）
    if (payload.redOfInvoiceId === '') payload.redOfInvoiceId = null;
    ['amountBeforeTax', 'taxRatePct', 'amountWithTax'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    this.assertNoNegativeAmounts(payload);
    // 编辑时**把已填的税前金额清空** → 拦下；历史票本就为空时编辑其他字段不受阻（税前必填只约束新增）
    if (payload.amountBeforeTax !== undefined && isFilledNumber(before.amountBeforeTax)) {
      this.assertBeforeTaxRequired(payload.amountBeforeTax);
    }
    /**
     * 票面金额自洽：**只在本次请求动了金额三件套时校验**（与「税前必填」同一思路）。
     * 历史票本身可能就不自洽（如审计发现的 08812678），只改备注/状态不该被它拦住——
     * 那会让人连备注都存不了；要改就得连带把金额改对。
     */
    if (['amountBeforeTax', 'taxRatePct', 'amountWithTax'].some((f) => payload[f] !== undefined)) {
      this.assertAmountConsistent(
        payload.amountBeforeTax ?? before.amountBeforeTax,
        payload.taxRatePct ?? before.taxRatePct,
        payload.amountWithTax ?? before.amountWithTax,
      );
    }
    if (data.invoiceDate) payload.invoiceDate = toDate(data.invoiceDate);
    if (data.receiveDate) payload.receiveDate = toDate(data.receiveDate);
    delete payload.version;
    const link = await this.resolveSettlementId(payload, before.projectId, before);
    if (link !== undefined) payload.settlementId = link;
    // 关联不可变（上面已拦）：这里只校验「已有关联仍在同合同」，不再触发作废原票
    await this.resolveRedLink(payload, before.projectId, before);
    const updated = await this.prisma.invoice.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
    // 合同可能被改到别的合同上 → 两个合同的开票额都要重算
    for (const cid of new Set([before.contractId, payload.contractId ?? before.contractId].filter(Boolean))) {
      await this.syncLedger(cid as string);
    }
    return updated;
  }

  async remove(id: string, projectId?: string) {
    const before: any = await this.findOne(id, projectId);
    // 原票被红冲后是两张票的审计关系：删掉原票会让红冲票指向空，拒绝（先处理红冲票再删原票）
    if ((before.redInvoices?.length ?? 0) > 0) {
      throw new BadRequestException('该发票已有红冲票，不能删除原发票');
    }
    await this.prisma.invoice.delete({ where: { id } });
    await this.syncLedger(before.contractId);
    return true;
  }

  /**
   * 作废 / 红冲：把发票置为**终态**（业务口径 2026-11-12）。
   *
   * 终态票不计入任何金额口径（`countedInvoiceWhere()`）：结算台账「本月开票额」、合同台账
   * 「开累发票金额」、履约开票比例、工作台与 AI 统计。**保留 `settlementId` 关联**（审计可追溯），
   * 只刷新该合同台账，不调用 `linkOrphansForContract`（状态变更不改归属，也不该顺带重挂其它孤儿票）。
   *
   * 合法规则：非终态（含历史空状态）均可作废/红冲；终态不可重复、不可互转、不可经通用 PUT 改出。
   */
  async cancel(id: string, projectId?: string) {
    return this.markTerminal(id, INVOICE_STATUS.CANCELLED, projectId);
  }

  async red(id: string, projectId?: string) {
    return this.markTerminal(id, INVOICE_STATUS.RED, projectId);
  }

  /** 终态重复/互转的统一报错（预检与并发条件更新失败共用，避免同一文案两处维护） */
  private throwTerminalConflict(current: string | null, target: string): never {
    if (current === target) {
      throw new BadRequestException(
        target === INVOICE_STATUS.CANCELLED ? '该发票已作废，不能重复作废' : '该发票已红冲，不能重复红冲',
      );
    }
    throw new BadRequestException('该发票已处于终态（作废/红冲），不能再变更状态');
  }

  private async markTerminal(id: string, target: string, projectId?: string) {
    const inv: any = await this.findOne(id, projectId);
    const current = inv.statusCode ?? null;
    if (isInvoiceTerminalStatus(current)) this.throwTerminalConflict(current, target);
    /**
     * 条件更新：并发下（如一人作废、一人红冲同时点击）只有第一个请求能改成功，
     * 后者按最新状态报错，避免「响应说已作废、库里却是红冲」的假成功。
     */
    const res = await this.prisma.invoice.updateMany({
      where: { id, ...countedInvoiceWhere() },
      data: { statusCode: target, version: { increment: 1 } },
    });
    if (res.count !== 1) {
      const latest: any = await this.findOne(id, projectId);
      this.throwTerminalConflict(latest.statusCode ?? null, target);
    }
    const updated = await this.prisma.invoice.findUnique({ where: { id } });
    await this.settlement.syncLedgerByContract(inv.contractId);
    return updated;
  }

  /**
   * 发票「查验」：把「待查验」置为「已查验」——用于**登记核对**
   * （业务口径：录入/核对该发票的信息后标记为已查验）。
   *
   * ⚠️ **不做验真**，也不接第三方查验服务（如航信/百望）——业务侧明确不需要。
   * 发票信息采集走 `POST /invoices/recognize`（二维码/OCR 识别）+ 人工补录。
   */
  async verify(id: string, projectId?: string) {
    const inv = await this.findOne(id, projectId);
    if (isInvoiceTerminalStatus(inv.statusCode)) {
      throw new BadRequestException('已作废/红冲的发票不能查验');
    }
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
        // 合同归属校验：不校验的话可把别项目的合同挂到本项目发票上，
        // 之后按合同汇总的开票额、台账同步都会串到别的项目
        if (contract && (contract as any).projectId !== projectId) throw new Error('关联合同不属于当前项目');
        const ratePct = num(it.taxRatePct);
        const beforeTax = num(it.amountBeforeTax);
        // 税前金额必填（与 create/import 同一口径：台账「开累发票税前金额/进项税额」由发票派生）
        if (beforeTax === null) throw new Error('税前金额为空（必填）');
        // 含税金额 = 税前金额 × (1 + 税率百分数/100)，单轨百分数口径
        const withTax = ratePct !== null && beforeTax !== null
          ? calcAmount(beforeTax, 1 + ratePct / 100, 2)
          : (num(it.amountWithTax) ?? null);
        const invoiceDate = it.invoiceDate ? new Date(it.invoiceDate) : null;
        const d = invoiceDate && !isNaN(invoiceDate.getTime()) ? invoiceDate : null;
        const row = await this.prisma.invoice.create({
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
            taxRatePct: ratePct,
            amountWithTax: withTax,
            receiveDate: new Date(),
            reviewStatus: INVOICE_REVIEW_STATUS.PENDING,
            financeTransferStatus: 'NOT_TRANSFERRED',
            statusCode: INVOICE_STATUS.WAIT_VERIFY,
            remark: it.remark || '批量识别导入',
          },
        });
        // 与 create/import 同一收尾：挂同月结算单 + 刷合同开票台账。
        // 漏这两步时批量识别进来的发票 settlementId 恒为 null、台账「本月开票额」停在旧值，
        // 直到以后对同一合同再做一次单条写入才被动纠正。
        const link = await this.resolveSettlementId(row as any, projectId);
        if (link !== undefined) {
          await this.prisma.invoice.update({ where: { id: row.id }, data: { settlementId: link } });
        }
        await this.syncLedger(row.contractId);
        created += 1;
      } catch (e: any) {
        errors.push(`第 ${i + 1} 条：${e.message}`);
      }
    }
    return { created, errors };
  }

  // ---------------- Excel ----------------
  /**
   * 导出用全量发票：`findAll({ pageSize: 2000 })` 会被单页上限截断，
   * 发票数超过上限时导出文件**静默**少行（与台账/还款协议导出同一坑）。
   */
  private allInvoices(projectId: string): Promise<any[]> {
    return pagedAll((page, pageSize) => this.findAll({ page, pageSize }, projectId, pageSize));
  }

  async export(projectId: string) {
    const all = await this.allInvoices(projectId);
    const res: any = { list: all, total: all.length };
    const [goods, review, finance] = await Promise.all([
      this.dict.nameMap('goods_category'), this.dict.nameMap('invoice_review_status'),
      this.dict.nameMap('finance_transfer_status'),
    ]);
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const fmt = (d: any) => (d ? localDayKey(d) : ''); // 本地日期：UTC 会早一天（第 22 轮审计 P1-6）
    const rows = (res.list as any[]).map((i: any, idx: number) => ({
      index: idx + 1,
      goodsCategoryName: goods[i.goodsCategory]?.name || '',
      settlePeriod: i.settlePeriod, issuer: i.issuer, invoiceDate: fmt(i.invoiceDate),
      invoiceCode: i.invoiceCode, invoiceNo: i.invoiceNo, amountBeforeTax: num(i.amountBeforeTax),
      // 红冲票指向的原发票号码（业务口径 2026-11-12：录红冲票时原票同步作废）
      redOfInvoiceNo: i.redOf?.invoiceNo || '',
      taxRatePct: num(i.taxRatePct), amountWithTax: num(i.amountWithTax), receiveDate: fmt(i.receiveDate),
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
        { header: '红冲原发票', key: 'redOfInvoiceNo', width: 140, type: 'center' },
        { header: '税前金额', key: 'amountBeforeTax', width: 140, type: 'money' },
        { header: '税率', key: 'taxRatePct', width: 80, type: 'pctVal' },
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
    /**
     * 第 9 轮审计：字典项名称没命中就静默写 NULL（单据类别/状态丢失但提示导入成功），
     * 日期用裸 `new Date(...)`（非法值整批回滚、Excel 序列号静默变成 1970）。
     * 统一走 import-parse 的严格解析，坏值抛 RowError 带列名。
     */
    const codeOf = (items: any[], value: unknown, field: string) => {
      const code = pickDictCode(items, value);
      if (code === null && String(value ?? '').trim()) {
        throw new RowError(`「${field}」填的「${String(value).trim()}」在字典里找不到（可能写错或已停用），请从下拉选项里选`, field);
      }
      return code;
    };
    const dateOf = (value: unknown, field: string) => {
      const parsed = parseImportDate(value, field);
      if (parsed.error) throw new RowError(parsed.error, field);
      return parsed.date;
    };
    /**
     * 批内去重 + 库内查重放在 **plan 阶段**：发票号有 DB 唯一约束
     * （`@@unique([projectId, invoiceNo])`），原实现不预检，重复号会在 write 的事务里
     * 撞 P2002 → 整批回滚，用户只看到一行原始约束错误，不知道是第几行、哪个号重复。
     */
    const notDup = this.runner.batchDup();
    /** 本批涉及到的合同：提交后要按这些合同重挂结算单关联并刷新台账 */
    const affected = new Set<string>();
    return this.tasks.submit<any>({ module: 'invoice', moduleName: '发票台账', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        affected.add(contract.id);
        // 发票号码：模板标为必填、前端表单也必填；导入同样要求，并给出可定位到行的重复提示
        const invoiceNo = String(r['发票号码'] ?? '').trim();
        if (!invoiceNo) throw new RowError('发票号码为必填项', '发票号码');
        notDup(invoiceNo, `发票号码「${invoiceNo}」在本次导入中重复`, '发票号码');
        const dupNo = await this.prisma.invoice.findFirst({ where: { projectId, invoiceNo }, select: { id: true } });
        if (dupNo) throw new RowError(`发票号码「${invoiceNo}」在当前项目中已存在`, '发票号码');
        // 税率单轨百分数（13 = 13%）：模板列「税率(%)」直接落库，不再解析小数双轨入口；
        // 子表未填时继承合同台账税率（合同字段同为百分数口径）。
        let taxRatePct = num(r['税率(%)']);
        if (taxRatePct === null && contract?.taxRatePct != null) {
          taxRatePct = num(contract.taxRatePct);
        }
        const amtBefore = num(r['税前金额']);
        const amtWith = num(r['含税金额']);
        // 税前金额必填（与交互式 create 同一口径）；缺了台账「开累发票税前金额/进项税额」就算不出来
        if (amtBefore === null) throw new RowError('税前金额为必填项（请填票面不含税金额）', '税前金额');
        if (amtBefore < 0) throw new RowError('税前金额不能为负数', '税前金额');
        if (amtWith !== null && amtWith < 0) throw new RowError('含税金额不能为负数', '含税金额');
        return {
          data: {
            contractId: contract.id,
            goodsCategory: codeOf(goods, r['商品类别'], '商品类别'),
            settlePeriod: r['结算账期'] || null,
            issuer: r['开票单位'] || null,
            invoiceDate: dateOf(r['开票日期'], '开票日期'),
            invoiceCode: r['发票代码'] || null,
            invoiceNo,
            amountBeforeTax: amtBefore,
            taxRatePct,
            amountWithTax: amtWith,
            receiveDate: dateOf(r['发票收取时间'], '发票收取时间'),
            reviewStatus: codeOf(review, r['发票信息审核'], '发票信息审核'),
            responsiblePerson: r['责任人'] || null,
            financeTransferStatus: codeOf(finance, r['财务移交情况'], '财务移交情况'),
            typeCode: codeOf(types, r['发票类型'], '发票类型'),
            statusCode: codeOf(status, r['状态'], '状态'),
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
      { label: '税前金额', key: 'amountBeforeTax', required: true, type: 'money', width: 14, example: 12345.67, desc: '票面不含税金额，必填' },
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

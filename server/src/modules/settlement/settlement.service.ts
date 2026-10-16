import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion, IMPORT_MAX_ROWS } from '../../common/utils/helpers';
import { round2 } from '../../common/utils/money';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { assertSettlementRejectable, SETTLEMENT_STATUS } from '../../constants/workflowGuards';
import { SysParamService } from '../../common/services/sys-param.service';
import { normalizePolicy, checkOverAmount } from '../../common/utils/amount-guard';
// 链口径（合同当前金额 / 累计结算 / 累计付款）统一在 contract-chain：防超结的上限与
// 业务口径「合同当前金额 = 主合同 + 补充协议增量」必须是同一个实现
import { contractChainAmount, chainSettledTotal } from '../../common/utils/contract-chain';

const SETTLE_FIELDS = [
  'projectId', 'contractId', 'code', 'typeCode', 'amount', 'deductAmount', 'actualAmount',
  'settleDate', 'statusCode', 'remark',
];
const LEDGER_FIELDS = [
  'projectId', 'contractId', 'settleMonth', 'monthSettleAmount', 'monthInvoiceAmount', 'settleCount',
  'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount', 'monthActualPurchase',
  'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome', 'isOnAccount', 'remark',
];

@Injectable()
export class SettlementService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private styled: StyledExcelService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
    private sysParam: SysParamService,
  ) {}

  // ---------------- 结算单 ----------------

  /**
   * 防超结校验（口径见 .claude/rules/backend-conventions.md「金额上限」）：累计结算（含补充协议链、排除草稿与自身）+ 本次 ≤ 合同链金额。
   * 策略取系统参数 `settlement.over_amount_policy`（BLOCK 拦截 / WARN 仅提示 / OFF 不校验，默认 WARN）。
   *
   * ⚠️ 仅在**交互式写入**（无 tx）且结果状态非草稿时执行：事务内不得调用 `sysParam`
   *    （它用事务外的 PrismaClient 连接，连接池耗尽会挂起，见 receipt-order.service 同款说明）；
   *    草稿只是暂存，不构成已发生结算，故不计入上限。
   */
  private async checkOverSettlement(
    contractId: string | null | undefined,
    currentAmount: number,
    excludeId?: string,
  ): Promise<{ overAmountWarning?: string }> {
    if (!contractId) return {};
    const policy = normalizePolicy(await this.sysParam.get('settlement.over_amount_policy', 'WARN'));
    if (policy === 'OFF') return {};
    const [limit, used] = await Promise.all([
      contractChainAmount(this.prisma, contractId),
      chainSettledTotal(this.prisma, contractId, excludeId),
    ]);
    const res = checkOverAmount({ limit, used, current: currentAmount, label: '结算' });
    if (!res.exceeded) return {};
    if (policy === 'BLOCK') throw new BadRequestException(res.message);
    console.warn('[结算/防超结]', res.message);
    return { overAmountWarning: res.message };
  }

  /** 结果状态是否为草稿（草稿不参与防超结校验） */
  private isDraft(statusCode: any): boolean {
    return String(statusCode ?? SETTLEMENT_STATUS.DRAFT) === SETTLEMENT_STATUS.DRAFT;
  }
  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { contract: { name: { contains: query.keyword } } }];
    const [list, total] = await Promise.all([
      this.prisma.settlement.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { contract: { select: { id: true, code: true, name: true, supplierId: true, supplier: { select: { id: true, name: true } } } } },
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const s = await this.prisma.settlement.findUnique({ where: { id }, include: { contract: true } });
    if (!s) throw new NotFoundException('结算单不存在');
    return s;
  }

  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.dict.validate('settlement_type', data.typeCode);
    await this.dict.validate('settlement_status', data.statusCode);
    // 同合同同月唯一（业务口径 2026-10-16，见 assertMonthUniqueForContract 的说明）
    await this.assertMonthUniqueForContract(data.contractId, data.settleDate);
    const actual = data.actualAmount ?? (num(data.amount) || 0) - (num(data.deductAmount) || 0);
    // 防超结：仅交互式写入（非事务）且非草稿时校验
    const warn =
      tx || this.isDraft(data.statusCode)
        ? {}
        : await this.checkOverSettlement(data.contractId, num(actual));
    const created: any = await db.settlement.create({
      data: {
        ...pickFields(data, SETTLE_FIELDS, { label: '结算单' }), projectId,
        amount: num(data.amount), deductAmount: num(data.deductAmount), actualAmount: num(actual),
        settleDate: toDate(data.settleDate),
      },
    });
    /**
     * 结算单 → 台账（业务口径 2026-10-16：一结算单对应一行台账）。
     * ⚠️ 只在**无外部事务**时刷新：`computeLedgerAutoFields` 走 `this.prisma`（事务外连接），
     * 在事务里读不到尚未提交的结算单。事务内的调用方（如导入）需在提交后自行
     * 调 `refreshLedger(projectId)` 或 `syncLedgerByContract()`——导入路径已如此处理。
     */
    if (!tx && created?.contractId) await this.syncLedgerByContract(created.contractId);
    return { ...created, ...warn };
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    await this.dict.validate('settlement_type', data.typeCode);
    await this.dict.validate('settlement_status', data.statusCode);
    // 同合同同月唯一（改日期/改合同都要校验，排除自身）
    await this.assertMonthUniqueForContract(
      data.contractId ?? before.contractId,
      data.settleDate ?? before.settleDate,
      id,
    );
    const payload: any = pickFields(data, SETTLE_FIELDS, { label: '结算单' });
    ['amount', 'deductAmount', 'actualAmount'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (data.settleDate) payload.settleDate = toDate(data.settleDate);
    delete payload.version;
    // 防超结：按「更新后」的状态与金额校验（草稿不校验）
    const resultingStatus = payload.statusCode ?? before.statusCode;
    const resultingActual =
      payload.actualAmount !== undefined
        ? num(payload.actualAmount)
        : payload.amount !== undefined || payload.deductAmount !== undefined
          ? (num(payload.amount ?? before.amount) || 0) - (num(payload.deductAmount ?? before.deductAmount) || 0)
          : num(before.actualAmount);
    const warn = this.isDraft(resultingStatus)
      ? {}
      : await this.checkOverSettlement(payload.contractId ?? before.contractId, resultingActual, id);
    const updated: any = await this.prisma.settlement.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
    // 结算单 → 台账：改了日期/合同会影响两个月（旧月要解除关联并重算、新月要建行），故两边都刷
    const affected = new Set<string>([before.contractId, updated.contractId].filter(Boolean) as string[]);
    for (const cid of affected) await this.syncLedgerByContract(cid);
    return { ...updated, ...warn };
  }

  async remove(id: string) {
    const before: any = await this.findOne(id);
    await this.prisma.settlement.delete({ where: { id } });
    // 台账行上的 settlementId 由 DB 级 `SET NULL` 解除，随后重算该合同的台账
    // （该行会退回"仅费用行"形态：monthSettleAmount=0、settleCount=0）
    if (before?.contractId) await this.syncLedgerByContract(before.contractId);
    return true;
  }

  /**
   * 任务 7：结算驳回 → 回填（回退到「草稿」状态，可重新编辑提交）。
   * 纯状态回退；仅「已确认 / 已开票 / 已付款 / 已完成」等已提交状态可驳回。
   */
  async reject(id: string) {
    const before: any = await this.findOne(id);
    // 状态机守卫（单一事实源）：仅已提交（待确认及之后）可驳回回填，草稿不可重复驳回
    assertSettlementRejectable(before.statusCode);
    await this.dict.validate('settlement_status', SETTLEMENT_STATUS.DRAFT);
    await this.prisma.settlement.update({
      where: { id },
      data: { statusCode: SETTLEMENT_STATUS.DRAFT, version: { increment: 1 } },
    });
    return this.findOne(id);
  }

  // ---------------- 结算台账 ----------------

  /** 日期 → YYYY-MM */
  private monthOf(d: any): string | null {
    if (!d) return null;
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return null;
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * 结算台账自动抓取字段（数据自动生成，不依赖手工录入）：
   * - 本月结算额 / 结算次数：按结算月份从结算单（Settlement.settleDate）抓取实结金额
   * - 本月开票额：从发票管理收票登记（Invoice）按结算账期抓取，无账期时回落到开票日期月份
   * - 保理贴息：从资金费用台账保理费用（FactoringCost，融资利息 + 手续费）按结算月份抓取
   * - 逾期利息：从资金费用台账逾期利息（OverdueInterest，未减免行）按结算月份抓取
   */
  async computeLedgerAutoFields(contractId: string, settleMonth: string) {
    const [y, m] = settleMonth.split('-').map(Number);
    let start: Date | null = null;
    let end: Date | null = null;
    if (y && m) {
      start = new Date(y, m - 1, 1);
      end = new Date(y, m, 1);
    }
    const [settlements, invoices, factoring, overdue] = await Promise.all([
      start && end
        ? this.prisma.settlement.findMany({ where: { contractId, settleDate: { gte: start, lt: end } } })
        : Promise.resolve([] as any[]),
      this.prisma.invoice.findMany({ where: { contractId } }),
      this.prisma.factoringCost.findMany({ where: { contractId, settlementMonth: settleMonth } }),
      this.prisma.overdueInterest.findMany({ where: { contractId, settlementMonth: settleMonth } }),
    ]);
    const monthSettleAmount = round2(settlements.reduce((s: number, r: any) => s + (num(r.actualAmount ?? r.amount) || 0), 0));
    /** 该行对应的结算单数：同合同同月唯一 → 恒为 0（仅费用行）或 1（字段保留兼容导出/列定义） */
    const settleCount = settlements.length;
    const monthInvoiceAmount = round2(
      invoices
        .filter((i: any) => (i.settlePeriod || this.monthOf(i.invoiceDate)) === settleMonth)
        .reduce((s: number, i: any) => s + (num(i.amountWithTax) || 0), 0),
    );
    const factoringDiscount = round2(
      factoring.reduce((s: number, r: any) => {
        const cost = num(r.totalCost) ?? (num(r.financingInterest) || 0) + (num(r.handlingFee) || 0);
        return s + (cost || 0);
      }, 0),
    );
    const overdueSum = round2(overdue.reduce((s: number, r: any) => (r.waived ? s : s + (num(r.overdueInterest) || 0)), 0));
    /**
     * `settlementId`：该月的结算单（业务口径 2026-10-16：**一结算单对应一行台账**，
     * 且同合同同月只允许一张结算单，故取首张即可）。返回它是为了让调用方把它落进台账行；
     * 当月**只有资金费用/逾期利息、没有结算单**时为 `null`（"仅费用行"，行照样要生成）。
     */
    return {
      monthSettleAmount,
      monthInvoiceAmount,
      settleCount,
      factoringDiscount,
      overdueInterest: overdueSum,
      settlementId: settlements[0]?.id ?? null,
    };
  }

  /**
   * **同合同同月只允许一张结算单**（业务口径 2026-10-16）。
   *
   * 起因：台账已改为"一结算单对应一行台账"（`SettlementLedger.settlementId`），
   * 而同月里该行的结算额、发票额、资金费用都是按**月**归集的——同月两张结算单会让
   * 这些口径无法归属（要么重复计入，要么得引入分摊规则）。业务确认"不存在这种情况"，
   * 故在登记时就**报错拦住**，而不是静默合并。
   */
  private async assertMonthUniqueForContract(
    contractId: string | null | undefined,
    settleDate: unknown,
    excludeId?: string,
  ) {
    if (!contractId || !settleDate) return;
    const month = this.monthOf(settleDate);
    if (!month) return;
    const [y, m] = month.split('-').map(Number);
    const dup = await this.prisma.settlement.findFirst({
      where: {
        contractId,
        settleDate: { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, code: true },
    });
    if (dup) {
      throw new BadRequestException(
        `该合同 ${month} 已有结算单${dup.code ? `（${dup.code}）` : ''}：同一合同同一月份只允许一张结算单。`,
      );
    }
  }

  /**
   * 生成/刷新**一行**台账（按 合同 + 月份 upsert），并把 `settlementId` 一并落库。
   * 这是"结算单驱动台账"与"仅费用行"两条路径的**同一个汇合点**——
   * 自动字段（含 `settlementId`）全部来自 `computeLedgerAutoFields()`，不要在别处手拼。
   */
  private async upsertLedgerRow(
    contractId: string,
    projectId: string,
    settleMonth: string,
    tx?: TxClient,
  ) {
    const db: any = tx || this.prisma;
    const auto = await this.computeLedgerAutoFields(contractId, settleMonth);
    const exist = await db.settlementLedger.findFirst({ where: { projectId, contractId, settleMonth } });
    if (exist) {
      return db.settlementLedger.update({
        where: { id: exist.id },
        data: { ...auto, version: { increment: 1 } },
      });
    }
    return db.settlementLedger.create({ data: { projectId, contractId, settleMonth, ...auto } });
  }

  /**
   * 需求 2.3：合同物资/金额变更时，自动重新派生该合同下全部结算台账的自动抓取字段
   * （本月结算额、本月开票额、结算次数、保理贴息、逾期利息、对应结算单）。
   *
   * 2026-10-16 起它**同时负责建行**：该合同每张结算单所在的月份都必须有台账行并挂上
   * `settlementId`（此前它只刷新"已存在的行"，而全仓又没有调用点 —— 这正是
   * "台账与结算单看不出关联"的根因）。仅费用行（无结算单）也一并重算。
   */
  async syncLedgerByContract(contractId: string, tx?: TxClient) {
    if (!contractId) return 0;
    const db: any = tx || this.prisma;
    const contract = await db.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    if (!contract) return 0;
    const projectId: string = contract.projectId;

    const months = new Set<string>();
    // (a) 该合同所有结算单所在的月份
    const settlements = await db.settlement.findMany({
      where: { contractId },
      select: { settleDate: true },
    });
    for (const s of settlements) {
      const m = this.monthOf(s.settleDate);
      if (m) months.add(m);
    }
    // (b) 已有台账行的月份（含**仅费用行**：无结算单但有资金费用/逾期利息）
    const rows = await db.settlementLedger.findMany({
      where: { contractId },
      select: { settleMonth: true },
    });
    for (const r of rows) if (r.settleMonth) months.add(r.settleMonth);

    const run = async (exec: any) => {
      /**
       * ① **先清后挂**：`settlementId` 是唯一键，结算单改了月份时，
       * 旧月份的行上仍挂着它——不先清掉，新月份建行时就会撞唯一约束
       * （真库实测：这正是"改月份"用例暴露的问题）。
       */
      await exec.settlementLedger.updateMany({
        where: { contractId, settlementId: { not: null } },
        data: { settlementId: null },
      });
      // ② 再逐月 upsert：每行重新挂上它**当月**的那张结算单（或保持 null = 仅费用行）
      for (const m of months) await this.upsertLedgerRow(contractId, projectId, m, exec);
    };
    // 整体放在一个事务里：清空与重挂之间不能有窗口（否则中途失败会留下"全部无关联"的台账）
    if (tx) await run(tx);
    else await this.prisma.$transaction(async (t) => run(t), { timeout: 30000 });

    return months.size;
  }

  /** 一键自动生成/刷新台账：扫描结算单、收票登记、资金费用台账中的合同+月份组合，自动生成缺失行并刷新自动字段 */
  async refreshLedger(projectId: string) {
    const [settlements, invoices, factoring, overdue, contracts] = await Promise.all([
      this.prisma.settlement.findMany({ where: { projectId }, select: { contractId: true, settleDate: true } }),
      this.prisma.invoice.findMany({ where: { projectId }, select: { contractId: true, settlePeriod: true, invoiceDate: true } }),
      this.prisma.factoringCost.findMany({ select: { contractId: true, settlementMonth: true } }),
      this.prisma.overdueInterest.findMany({ select: { contractId: true, settlementMonth: true } }),
      this.prisma.contract.findMany({ where: { projectId }, select: { id: true } }),
    ]);
    const contractIds = new Set(contracts.map((c: any) => c.id));
    const combos = new Set<string>();
    const add = (contractId: string | null, month: string | null) => {
      if (contractId && month) combos.add(`${contractId}|${month}`);
    };
    for (const s of settlements) add(s.contractId, this.monthOf(s.settleDate));
    for (const i of invoices) add(i.contractId, i.settlePeriod || this.monthOf(i.invoiceDate));
    for (const f of factoring) if (contractIds.has(f.contractId)) add(f.contractId, f.settlementMonth);
    for (const o of overdue) if (contractIds.has(o.contractId)) add(o.contractId, o.settlementMonth);
    let created = 0;
    let updated = 0;
    for (const combo of combos) {
      const [contractId, settleMonth] = combo.split('|');
      const exist = await this.prisma.settlementLedger.findFirst({
        where: { projectId, contractId, settleMonth },
        select: { id: true },
      });
      // 与「结算单驱动」共用同一个 upsert（自动字段 + settlementId 都在那里落）
      await this.upsertLedgerRow(contractId, projectId, settleMonth);
      if (exist) updated++;
      else created++;
    }
    return { created, updated };
  }

  async findLedger(query: any = {}, projectId: string, maxPageSize = 500) {
    const { skip, take } = paginate(query, maxPageSize);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.settleMonth) where.settleMonth = query.settleMonth;
    if (query.isOnAccount) where.isOnAccount = query.isOnAccount;
    const [list, total] = await Promise.all([
      this.prisma.settlementLedger.findMany({
        where, skip, take, orderBy: [{ settleMonth: 'desc' }, { createdAt: 'desc' }],
        include: { contract: { select: { id: true, code: true, name: true, supplier: { select: { id: true, name: true } } } } },
      }),
      this.prisma.settlementLedger.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async ledgerOne(id: string) {
    const l = await this.prisma.settlementLedger.findUnique({ where: { id } });
    if (!l) throw new NotFoundException('结算台账记录不存在');
    return l;
  }

  /**
   * 台账里的**只读派生字段**（业务口径 2026-10-16："资金费用在结算台账中只读，若修改需要从资金费用台账中修改"）。
   *
   * 两者都来自**别的台账**：`factoringDiscount ← 资金费用台账（FactoringCost）`、
   * `overdueInterest ← 逾期利息台账（OverdueInterest）`。它们本来就会被 `computeLedgerAutoFields()`
   * 在每次刷新时覆盖——与其"改了没用"，不如**明确报错**并把人引到正确的入口
   * （静默忽略会让人以为改成功了，那比报错更糟）。
   */
  private static readonly READONLY_LEDGER_FIELDS = ['factoringDiscount', 'overdueInterest'] as const;

  private assertLedgerWritable(data: any) {
    const bad = SettlementService.READONLY_LEDGER_FIELDS.filter((f) => data?.[f] !== undefined);
    if (bad.length) {
      throw new BadRequestException(
        `结算台账的「${bad.join('、')}」是**只读**派生字段：` +
          '资金费用请到「资金费用台账」修改、逾期利息请到「逾期利息」处修改，保存后结算台账会自动同步。',
      );
    }
  }

  /**
   * @param opts.fromImport 仅**台账导入**路径传 true：导入模板里仍带着「保理贴息/逾期利息」两列，
   *   且改造前它们同样会被 `computeLedgerAutoFields()` 覆盖（"从业务数据自动抓取，忽略手工传入"）——
   *   行为不变，只是不再被只读断言拦下。**接口调用方一律不给这个开关**。
   */
  async createLedger(data: any, projectId: string, tx?: TxClient, opts?: { fromImport?: boolean }) {
    const db: any = tx || this.prisma;
    if (!opts?.fromImport) this.assertLedgerWritable(data);
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = { ...pickFields(data, LEDGER_FIELDS, { label: '结算台账' }), projectId };
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    // 自动生成：本月结算额/本月开票额/结算次数/保理贴息/逾期利息 从业务数据自动抓取，忽略手工传入
    if (payload.contractId && payload.settleMonth) {
      Object.assign(payload, await this.computeLedgerAutoFields(payload.contractId, payload.settleMonth));
    }
    return db.settlementLedger.create({ data: payload });
  }

  async updateLedger(id: string, data: any) {
    const old = await this.ledgerOne(id);
    assertVersion(old, data);
    await this.assertLedgerWritable(data);
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = pickFields(data, LEDGER_FIELDS, { label: '结算台账' });
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    // 自动生成：以本次变更后的合同+月份为准重新抓取
    const contractId = payload.contractId ?? old.contractId;
    const settleMonth = payload.settleMonth ?? old.settleMonth;
    if (contractId && settleMonth) {
      Object.assign(payload, await this.computeLedgerAutoFields(contractId, settleMonth));
    }
    delete payload.version;
    return this.prisma.settlementLedger.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async removeLedger(id: string) {
    await this.ledgerOne(id);
    await this.prisma.settlementLedger.delete({ where: { id } });
    return true;
  }

  /** 月度结算单合规性检查表（需求 2.7）：表头信息 + 检查项清单 + 签字区 */
  async exportComplianceSheet(contractId: string, projectId: string, year?: number, month?: number) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { name: true } }, project: { select: { name: true } } },
    });
    if (!contract) throw new NotFoundException('合同不存在');
    const project = contract.project || (await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }));
    const info = [
      ['项目名称', project?.name || ''],
      ['分供方名称', contract.supplier?.name || ''],
      ['合同名称', contract.name],
      ['年度 / 月份', `${year || '____'} 年 ${month || '__'} 月`],
    ];
    /**
     * 结算额占合同额比例的**自动档位**。
     *
     * 口径与台账/工作台一致（业务口径 2026-10-15）：
     * - 分子 = 链上累计结算额（`actualAmount` 回退 `amount`，**排除草稿**）
     * - 分母 = **合同当前金额** = 主合同 + Σ 补充协议带符号增量（**不是**本合同的 amount）
     *
     * 分母未知（合同未填金额）时保持空白 □ 并注明"金额未填，无法判定"——
     * 这与"未填 ≠ 0"的既定口径一致，不臆造一个档位。
     */
    const [chainAmount, chainSettled] = await Promise.all([
      contractChainAmount(this.prisma, contractId),
      chainSettledTotal(this.prisma, contractId),
    ]);
    const ratioPct = chainAmount && chainAmount > 0 ? Number(((chainSettled / chainAmount) * 100).toFixed(2)) : null;
    const TIERS: [string, (pct: number) => boolean][] = [
      ['未超100%', (p) => p <= 100],
      ['100%-110%', (p) => p > 100 && p <= 110],
      ['110%-130%', (p) => p > 110 && p <= 130],
      ['130%以上', (p) => p > 130],
    ];
    const ratioTierText =
      ratioPct === null
        ? '结算额占合同额比例（未超100% □　100%-110% □　110%-130% □　130%以上 □）' +
          '　实际比例：合同当前金额未填，无法判定'
        : '结算额占合同额比例（' +
          TIERS.map(([label, hit]) => `${label} ${hit(ratioPct) ? '☑' : '□'}`).join('　') +
          `）　实际比例：${ratioPct}%（已结算 ¥${chainSettled.toFixed(2)} ÷ 合同当前金额 ¥${chainAmount!.toFixed(2)}）`;

    const CHECKS: [string, string][] = [
      ['进场依据（首期月度结算填报）', '开始招标时间'],
      ['', '首次进场时间'],
      ['', '是否为先进场后招标（是 □　否 □）'],
      ['', '定标时间'],
      ['', '是否为先进场后定标（是 □　否 □）'],
      ['', '合同签订时间'],
      ['', '是否为先进场后签合同（是 □　否 □）'],
      ['结算增项情况', '结算清单未超合同清单（是 □　否 □）'],
      ['收验货系统', '是否为上传收验货系统物资（是 □　否 □）'],
      ['', '上传收验货系统数量'],
      ['', '上传收验货系统数量占比'],
      ['', '未传收验货系统数量'],
      ['', '未传收验货系统数量占比'],
      // 该行由下方按「已结算 ÷ 合同当前金额」**自动带出**（业务口径 2026-10-15）：
      // 这是本表里唯一能由系统判定的勾选项，其余（签字盖章、是否先进场后招标…）仍需人工勾
      ['结算增量情况', ratioTierText],
      ['签字盖章合规性', '供应商签字为法人或授权委托人签字（是 □　否 □）'],
      ['', '（分包）收料人员签字有材料员授权委托书（是 □　否 □）'],
      ['', '盖章为公章或公章授权章（是 □　否 □）'],
      ['对账周期', '按对账周期结算（是 □　否 □）'],
      ['结算支撑材料', '结算依据充足准确（是 □　否 □）'],
      ['结算办理严谨性', '物资名称、规格型号与合同清单相同（是 □　否 □）'],
      ['', '基本信息无漏填（是 □　否 □）'],
      ['', '资料格式美观整洁（是 □　否 □）'],
    ];
    let lastGroup = '';
    const rows = CHECKS.map(([g, item]) => {
      if (g) lastGroup = g;
      return { group: lastGroup, item, result: '', note: '' };
    });
    return this.styled.withWorkbook(async (wb) => {
      const ws = wb.addWorksheet('合规性检查表', { views: [{ state: 'frozen', ySplit: 8 }] });
      const colCount = 4;
      // 品牌行 + 标题行
      ws.mergeCells(1, 1, 1, colCount);
      const brand = ws.getCell(1, 1);
      brand.value = '〖中国建筑〗中国建筑土木建设有限公司物资管理表格';
      brand.font = { bold: true, size: 14, name: '微软雅黑' };
      brand.alignment = { horizontal: 'left', vertical: 'middle' };
      ws.getRow(1).height = 26;
      ws.mergeCells(2, 1, 2, colCount);
      const title = ws.getCell(2, 1);
      title.value = '月度结算单合规性检查表';
      title.font = { bold: true, size: 13, name: '微软雅黑' };
      title.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(2).height = 24;
      // 表头信息区
      info.forEach(([label, value], i) => {
        const r = 3 + i;
        ws.getCell(r, 1).value = label;
        ws.getCell(r, 1).font = { bold: true, size: 10.5, name: '微软雅黑' };
        ws.mergeCells(r, 2, r, colCount);
        ws.getCell(r, 2).value = value;
        ws.getCell(r, 2).font = { size: 10.5, name: '微软雅黑' };
        for (let c = 1; c <= colCount; c++) ws.getCell(r, c).border = {
          top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' },
        };
      });
      // 检查项表头
      const headerRowIdx = 3 + info.length;
      const header = ws.getRow(headerRowIdx);
      ['检查分组', '检查项', '检查结果', '备注说明'].forEach((h, i) => {
        const cell = header.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, size: 11, name: '微软雅黑' };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      header.height = 22;
      // 检查项行
      rows.forEach((r, ri) => {
        const row = ws.getRow(headerRowIdx + 1 + ri);
        [r.group, r.item, r.result, r.note].forEach((v, ci) => {
          const cell = row.getCell(ci + 1);
          cell.value = v || null;
          cell.font = { size: 10.5, name: '微软雅黑' };
          cell.alignment = { horizontal: ci === 1 ? 'left' : 'center', vertical: 'middle', wrapText: ci === 1 };
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
      });
      // 签字区
      const signRow = headerRowIdx + rows.length + 2;
      ws.getCell(signRow, 1).value = '项目经办人签字：____________';
      ws.getCell(signRow, 3).value = '物资部负责人复核：____________';
      ws.getCell(signRow, 1).font = { size: 10.5, name: '微软雅黑' };
      ws.getCell(signRow, 3).font = { size: 10.5, name: '微软雅黑' };
      ws.getColumn(1).width = 24;
      ws.getColumn(2).width = 56;
      ws.getColumn(3).width = 22;
      ws.getColumn(4).width = 20;
      ws.pageSetup = {
        paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        printTitlesRow: `1:${headerRowIdx}`, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 },
      };
    });
  }

  async exportLedger(projectId: string) {
    const res = await this.findLedger({ pageSize: 2000 }, projectId, IMPORT_MAX_ROWS);
    const yesNo = await this.dict.nameMap('yes_no');
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const rows = (res.list as any[]).map((r) => ({
      projectName: project?.name || '',
      supplierName: r.contract?.supplier?.name, contractName: r.contract?.name, contractCode: r.contract?.code,
      settleMonth: r.settleMonth, monthSettleAmount: num(r.monthSettleAmount), monthInvoiceAmount: num(r.monthInvoiceAmount),
      settleCount: r.settleCount, yearSettleAmount: num(r.yearSettleAmount), monthActualPurchaseReview: num(r.monthActualPurchase),
      cumPurchaseAmount: num(r.cumPurchaseAmount),
      startSettleAmount: num(r.startSettleAmount), monthActualPurchase: num(r.monthActualPurchase),
      factoringDiscount: num(r.factoringDiscount), overdueInterest: num(r.overdueInterest),
      yearSettleIncome: num(r.yearSettleIncome), cumSettleIncome: num(r.cumSettleIncome),
      isOnAccountName: yesNo[r.isOnAccount]?.name || '',
    }));
    return this.styled.exportTable({
      sheetName: '结算台账',
      logoColumn: true,
      title: `结算台账（${project?.name || ''}）`,
      columns: [
        { header: '项目', key: 'projectName', width: 140, type: 'center' },
        { header: '供应商名称', key: 'supplierName', width: 180 },
        { header: '合同名称', key: 'contractName', width: 200 },
        { header: '合同编号', key: 'contractCode', width: 180 },
        { header: '结算月份', key: 'settleMonth', width: 100, type: 'center' },
        { header: '本月结算额 a', key: 'monthSettleAmount', width: 140, type: 'money' },
        { header: '本月开票额', key: 'monthInvoiceAmount', width: 130, type: 'money' },
        { header: '结算次数', key: 'settleCount', width: 80, type: 'int' },
        { header: '本年结算额', key: 'yearSettleAmount', width: 140, type: 'money' },
        { header: '本月采购额（公式复核）', key: 'monthActualPurchaseReview', width: 160, type: 'money' },
        { header: '截止当月开累采购额', key: 'cumPurchaseAmount', width: 160, type: 'money' },
        { header: '开工结算额', key: 'startSettleAmount', width: 130, type: 'money' },
        { header: '当月实际采购额 b', key: 'monthActualPurchase', width: 140, type: 'money' },
        { header: '保理贴息 c', key: 'factoringDiscount', width: 110, type: 'money' },
        { header: '逾期利息 d', key: 'overdueInterest', width: 110, type: 'money' },
        { header: '本年结算对应收入（含税）', key: 'yearSettleIncome', width: 180, type: 'money' },
        { header: '开累结算对应收入（含税）', key: 'cumSettleIncome', width: 180, type: 'money' },
        { header: '是否挂账', key: 'isOnAccountName', width: 90, type: 'center' },
      ],
      rows,
      totalsKeys: ['monthSettleAmount', 'monthInvoiceAmount', 'monthActualPurchase', 'factoringDiscount', 'overdueInterest'],
      totalsLabel: '汇总',
    });
  }

  /** 结算台账填写模板（需求 3.3，实际字段口径） */
  async templateLedger(projectId: string) {
    const yesNo = await this.dict.options('yes_no');
    const columns: TemplateColumn[] = [
      { label: '合同编号', key: 'contractCode', required: true, width: 20, example: 'HT-2026-0001', desc: '须为合同台账中已存在的合同编号' },
      { label: '结算月份', key: 'settleMonth', required: true, type: 'text', width: 14, example: '2026-08', desc: '格式 YYYY-MM' },
      { label: '本月结算额', key: 'monthSettleAmount', type: 'money', width: 16, example: 1234567.89 },
      { label: '本月开票额', key: 'monthInvoiceAmount', type: 'money', width: 16, example: 1396621.72 },
      { label: '结算次数', key: 'settleCount', type: 'int', width: 10, example: 2 },
      { label: '开累采购额', key: 'cumPurchaseAmount', type: 'money', width: 16, example: 50000000 },
      { label: '开工结算额', key: 'startSettleAmount', type: 'money', width: 16, example: 1000000 },
      { label: '本月实际采购额', key: 'monthActualPurchase', type: 'money', width: 16, example: 1180000 },
      { label: '保理贴息', key: 'factoringDiscount', type: 'money', width: 14, example: 12345.67 },
      { label: '逾期利息', key: 'overdueInterest', type: 'money', width: 14, example: 0 },
      { label: '本年结算收入', key: 'yearSettleIncome', type: 'money', width: 16, example: 8000000 },
      { label: '开累结算收入', key: 'cumSettleIncome', type: 'money', width: 16, example: 9000000 },
      { label: '是否挂账', key: 'isOnAccount', type: 'select', width: 10, example: '否', options: yesNo.map((i: any) => i.itemName).filter(Boolean) },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '结算台账', sheetName: '数据', columns });
  }

  /** 结算台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importLedger(buffer: Buffer, projectId: string, meta?: { fileName?: string; user?: any }) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'settlement-ledger', moduleName: '结算台账', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const month = String(r['结算月份'] ?? '').trim();
        if (!/^\d{4}-\d{2}$/.test(month)) throw new RowError('结算月份为必填项，格式 YYYY-MM（如 2026-08）', '结算月份');
        notDup(`${contract.id}|${month}`, `唯一性校验失败：该合同 ${month} 的记录在本次导入中重复`, '结算月份');
        const dup = await this.prisma.settlementLedger.findFirst({
          where: { projectId, contractId: contract.id, settleMonth: month },
        });
        if (dup) throw new RowError(`唯一性校验失败：该合同 ${month} 的结算台账已存在，导入不覆盖已有数据`, '结算月份');
        const isOnAccount = String(r['是否挂账'] ?? '').trim();
        return {
          data: {
            contractId: contract.id,
            settleMonth: month,
            monthSettleAmount: num(r['本月结算额']),
            monthInvoiceAmount: num(r['本月开票额']),
            settleCount: num(r['结算次数']),
            cumPurchaseAmount: num(r['开累采购额']),
            startSettleAmount: num(r['开工结算额']),
            monthActualPurchase: num(r['本月实际采购额']),
            factoringDiscount: num(r['保理贴息']),
            overdueInterest: num(r['逾期利息']),
            yearSettleIncome: num(r['本年结算收入']),
            cumSettleIncome: num(r['开累结算收入']),
            isOnAccount: isOnAccount || null,
            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.createLedger(p.data, projectId, tx, { fromImport: true });
        return { created: plans.length };
      },
    });
  }
}

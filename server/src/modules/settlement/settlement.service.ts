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
// 月份归集口径（`YYYY-MM`）与结算期纯函数：台账、发票/收领单自动匹配、月度结算期三处**共用**，
// 不要在各服务里各写一份 `getFullYear/getMonth` 拼接
import {
  monthKey,
  periodMonthKey,
  periodKeyOf,
  startDayOf,
  formatDay,
  previousSettlementPeriod,
} from '../../common/utils/settlement-period';

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
    if (!tx && created?.contractId) {
      // 先补挂该合同本月尚未关联的发票/收领单（它们会进台账的「本月开票额」），再刷新台账
      await this.linkOrphansForContract(created.contractId);
      await this.syncLedgerByContract(created.contractId);
    }
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
    // 结算单 → 台账：改了日期/合同会影响两个月（旧月要解除关联并重算、新月要建行），故两边都刷。
    // 同理也要**重算发票/收领单的关联**（改了月份后，旧关联按新月份解绑、当月未关联的补挂）。
    const affected = new Set<string>([before.contractId, updated.contractId].filter(Boolean) as string[]);
    for (const cid of affected) {
      await this.linkOrphansForContract(cid);
      await this.syncLedgerByContract(cid);
    }
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

  /**
   * 结算台账自动抓取字段（数据自动生成，不依赖手工录入）：
   * - 本月结算额 / 结算次数：按结算月份从结算单（Settlement.settleDate）抓取实结金额
   * - 本月开票额：**优先按 `settlementId` 精确归集**（发票与结算单对应），未关联的退回按「合同 + 月份」
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
    const settlements =
      start && end
        ? await this.prisma.settlement.findMany({ where: { contractId, settleDate: { gte: start, lt: end } } })
        : [];
    /** 该行对应的结算单（同合同同月唯一 → 至多一张）；无则 null = 「仅费用行」 */
    const settlementId = (settlements[0] as any)?.id ?? null;
    const [invoices, factoring, overdue] = await Promise.all([
      /**
       * 发票按月归集（业务口径 2026-10-16「发票与结算单对应」）：
       * ① **已挂到本行结算单**的发票全算 —— 精确到单据，与「结算账期」那串自由文本怎么写无关；
       * ② **未挂任何结算单**的，退回按「合同 + 月份」归集（兼容存量数据，也支撑"当月无结算单"的仅费用行）；
       * ⚠️ 已挂到**别的**结算单的发票一律不算 —— 它属于那一行的口径，两边都计会重复。
       */
      this.prisma.invoice.findMany({
        where: settlementId
          ? { OR: [{ settlementId }, { contractId, settlementId: null }] }
          : { contractId, settlementId: null },
        select: { id: true, settlementId: true, settlePeriod: true, invoiceDate: true, amountWithTax: true },
      }),
      this.prisma.factoringCost.findMany({ where: { contractId, settlementMonth: settleMonth } }),
      this.prisma.overdueInterest.findMany({ where: { contractId, settlementMonth: settleMonth } }),
    ]);
    const monthSettleAmount = round2(settlements.reduce((s: number, r: any) => s + (num(r.actualAmount ?? r.amount) || 0), 0));
    /** 该行对应的结算单数：同合同同月唯一 → 恒为 0（仅费用行）或 1（字段保留兼容导出/列定义） */
    const settleCount = settlements.length;
    const monthInvoiceAmount = round2(
      invoices
        .filter(
          (i: any) =>
            (settlementId && i.settlementId === settlementId) ||
            (periodMonthKey(i.settlePeriod) ?? monthKey(i.invoiceDate)) === settleMonth,
        )
        .reduce((s: number, i: any) => s + (num(i.amountWithTax) || 0), 0),
    );
    const factoringDiscount = round2(
      factoring.reduce((s: number, r: any) => {
        const cost = num(r.totalCost) ?? (num(r.financingInterest) || 0) + (num(r.handlingFee) || 0);
        return s + (cost || 0);
      }, 0),
    );
    const overdueSum = round2(overdue.reduce((s: number, r: any) => (r.waived ? s : s + (num(r.overdueInterest) || 0)), 0));
    return {
      monthSettleAmount,
      monthInvoiceAmount,
      settleCount,
      factoringDiscount,
      overdueInterest: overdueSum,
      settlementId,
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
    const month = monthKey(settleDate);
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
      const m = monthKey(s.settleDate);
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
    for (const s of settlements) add(s.contractId, monthKey(s.settleDate));
    for (const i of invoices) add(i.contractId, periodMonthKey(i.settlePeriod) ?? monthKey(i.invoiceDate));
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

  // ---------------- 发票 / 收领单 ↔ 结算单 的关联（业务口径 2026-10-16） ----------------

  /** 项目的**月度结算起始日**（未设置 → 1，即自然月）；关联归属与生成结算都按它算期 */
  private async startDayOf(projectId: string, db: any = this.prisma): Promise<number> {
    const p = await db.project.findUnique({ where: { id: projectId }, select: { settlementStartDate: true } });
    return startDayOf(p?.settlementStartDate);
  }

  /**
   * 同合同 + **同一结算期**的那张结算单 id（没有 → `null`）—— 发票/收领单**自动匹配**的口径。
   *
   * 「同一结算期」而不是「同一自然月」：起始日不是 1 日时两者会错开
   * （起始日 26 日 → 期 9/26–10/25 属于 10 月），9/28 的单据就该归到期末 10/25 的那张结算单上。
   * 起始日 = 1 日时（业务给的例子）两者等价。判据本身在 `periodKeyOf()`。
   */
  async findSettlementIdFor(
    contractId: string | null | undefined,
    date: unknown,
  ): Promise<string | null> {
    if (!contractId || !monthKey(date)) return null;
    const c = await this.prisma.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    if (!c) return null;
    const startDay = await this.startDayOf(c.projectId);
    const want = periodKeyOf(startDay, date);
    if (!want) return null;
    const list: any[] = await this.prisma.settlement.findMany({
      where: { contractId },
      select: { id: true, settleDate: true },
      orderBy: { createdAt: 'asc' },
    });
    return list.find((s) => periodKeyOf(startDay, s.settleDate) === want)?.id ?? null;
  }

  /**
   * 发票/收领单与结算单的关联**必须同项目、同合同、同结算期**。
   *
   * 为什么强制同期：台账的「本月开票额」是按**行**（合同 + 结算期）汇总的，跨期关联会让一张发票
   * 出现在它并不属于的那一行上，口径就散了。同合同的判断在 `contractId` 两边都有值时才做
   * （收领单用的是 `materialContractId`，可能为空）；日期两边都能解析出期时才比期。
   *
   * 返回该结算单，供调用方直接落 `settlementId`。
   */
  async assertLinkable(
    settlementId: string,
    projectId: string,
    opts: { contractId?: string | null; date?: unknown; label: string },
  ) {
    const s = await this.prisma.settlement.findUnique({
      where: { id: settlementId },
      select: { id: true, projectId: true, contractId: true, settleDate: true, code: true },
    });
    if (!s || s.projectId !== projectId) throw new NotFoundException('结算单不存在');
    if (opts.contractId && s.contractId && s.contractId !== opts.contractId) {
      throw new BadRequestException(`该结算单不属于本${opts.label}的合同，无法关联。`);
    }
    const startDay = await this.startDayOf(projectId);
    const own = periodKeyOf(startDay, s.settleDate);
    const mine = periodKeyOf(startDay, opts.date);
    if (own && mine && own !== mine) {
      throw new BadRequestException(
        `该结算单的结算期是 ${own}（期末 ${monthKey(s.settleDate)}），` +
          `与本${opts.label}的日期不在同一个结算期：结算台账按「合同 + 结算期」汇总，只能关联同期的结算单。`,
      );
    }
    return s;
  }

  /**
   * **自动匹配**：把该合同**尚未关联**的发票/收领单挂到同期那张结算单上，
   * 并把已经挂在某张结算单上、却**不在它的结算期内**的行解绑（改了结算日期或项目起算日之后要重算）。
   *
   * - 发票的日期：`结算账期` 文本优先（解析得出月份时），否则用开票日期；
   * - 收领单的日期：下单日期；合同取 `materialContractId`（物资合同）；
   * - **只动未关联的行**：人工指定的关联不会被自动改（除非它与结算期矛盾，那属于脏数据，
   *   由第二遍「解绑」纠正 —— 与台账刷新「先清后挂」同一个道理）。
   *
   * 关联变化会影响台账的「本月开票额」，调用方随后要 `syncLedgerByContract()`。
   */
  async linkOrphansForContract(contractId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    const empty = { invoices: 0, receiptOrders: 0, detached: 0 };
    if (!contractId) return empty;
    const contract = await db.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    if (!contract) return empty;
    const settlements: any[] = await db.settlement.findMany({
      where: { contractId },
      select: { id: true, settleDate: true },
    });
    if (!settlements.length) return empty;

    const startDay = await this.startDayOf(contract.projectId, db);
    /** 结算单 id → 它所属的结算期（标签）；算不出期的结算单（没填日期）不参与关联 */
    const periodOf = new Map<string, string>();
    for (const s of settlements) {
      const key = periodKeyOf(startDay, s.settleDate);
      if (key && !periodOf.has(key)) periodOf.set(key, s.id);
    }
    if (!periodOf.size) return empty;

    /**
     * 单据日期：发票优先用「结算账期」文本（它才是账期口径），认不出才退回开票日期；
     * 收领单只有下单日期。⚠️ 两处都必须与 `computeLedgerAutoFields()` 同口径。
     */
    const invoiceDate = (i: any) => periodMonthKey(i.settlePeriod) ?? i.invoiceDate;

    const linkedIds = [...periodOf.values()];
    // ① 解绑：挂在某张结算单上、但不在它的结算期内的行（改过 settleDate 之后会留下这种）
    const linkedInv: any[] = await db.invoice.findMany({
      where: { settlementId: { in: linkedIds } },
      select: { id: true, settlementId: true, settlePeriod: true, invoiceDate: true },
    });
    const staleInv = linkedInv
      .filter((i: any) => {
        const sid = i.settlementId;
        const period = [...periodOf.entries()].find(([, id]) => id === sid)?.[0];
        const own = periodKeyOf(startDay, invoiceDate(i));
        return period && own && own !== period;
      })
      .map((i: any) => i.id);
    let detached = 0;
    if (staleInv.length) {
      detached += (await db.invoice.updateMany({ where: { id: { in: staleInv } }, data: { settlementId: null } })).count;
    }
    const linkedRo: any[] = await db.receiptOrder.findMany({
      where: { settlementId: { in: linkedIds } },
      select: { id: true, settlementId: true, orderDate: true },
    });
    const staleRo = linkedRo
      .filter((r: any) => {
        const sid = r.settlementId;
        const period = [...periodOf.entries()].find(([, id]) => id === sid)?.[0];
        const own = periodKeyOf(startDay, r.orderDate);
        return period && own && own !== period;
      })
      .map((r: any) => r.id);
    if (staleRo.length) {
      detached += (await db.receiptOrder.updateMany({ where: { id: { in: staleRo } }, data: { settlementId: null } })).count;
    }

    // ② 挂载：未关联 + 与本合同同期
    let invoices = 0;
    let receiptOrders = 0;
    const orphanInv: any[] = await db.invoice.findMany({
      where: { settlementId: null, contractId },
      select: { id: true, settlePeriod: true, invoiceDate: true },
    });
    const orphanRo: any[] = await db.receiptOrder.findMany({
      where: { settlementId: null, materialContractId: contractId },
      select: { id: true, orderDate: true },
    });
    for (const [period, settlementId] of periodOf) {
      const invIds = orphanInv
        .filter((i: any) => periodKeyOf(startDay, invoiceDate(i)) === period)
        .map((i: any) => i.id);
      if (invIds.length) {
        invoices += (await db.invoice.updateMany({ where: { id: { in: invIds } }, data: { settlementId } })).count;
      }
      const roIds = orphanRo.filter((r: any) => periodKeyOf(startDay, r.orderDate) === period).map((r: any) => r.id);
      if (roIds.length) {
        receiptOrders += (await db.receiptOrder.updateMany({ where: { id: { in: roIds } }, data: { settlementId } })).count;
      }
    }
    return { invoices, receiptOrders, detached };
  }

  // ---------------- 月度结算自动生成（业务口径 2026-10-16） ----------------

  /**
   * 预览「上一期」的抓取情况（结算单页顶部提示用）：
   * 该期有几张**未挂结算单**的收领单、涉及几个合同 —— 有值就说明该生成结算了。
   *
   * 期间算法见 `common/utils/settlement-period.ts`（期 = 起始日 → 下月同日的前一日；
   * 起始日取项目的「月度结算起始日期」，未设置按自然月）。
   */
  async previewPreviousPeriod(projectId: string, refDate?: string) {
    const startDay = await this.startDayOf(projectId);
    const period = previousSettlementPeriod(startDay, refDate ? new Date(refDate) : new Date());
    const orders = await this.prisma.receiptOrder.findMany({
      where: {
        projectId,
        settlementId: null,
        materialContractId: { not: null },
        orderDate: { gte: period.start, lt: period.endExclusive },
      },
      select: { id: true, materialContractId: true },
    });
    const contractIds = [...new Set(orders.map((o: any) => o.materialContractId))];
    // 已有结算单的合同不算"待生成"（同合同同期唯一，重跑会跳过）
    const existing = await this.prisma.settlement.findMany({
      where: { projectId, contractId: { in: contractIds }, settleDate: { gte: period.start, lt: period.endExclusive } },
      select: { contractId: true },
    });
    const done = new Set(existing.map((s: any) => s.contractId));
    const pending = contractIds.filter((id) => !done.has(id));
    return {
      month: period.month,
      startDate: formatDay(period.start),
      endDate: formatDay(period.end),
      startDay,
      /** 期间内未挂结算单的收领单张数 */
      orderCount: orders.length,
      /** 还需要生成结算单的合同数 */
      pendingContracts: pending.length,
      /** 期间内完全没有收领单（前端据此提示"本期无可结算数据"而不是"去生成"） */
      empty: orders.length === 0,
    };
  }

  /**
   * **生成本期（默认上一期）结算单**（业务口径 2026-10-16）。
   *
   * 抓取来源 = 该期间内**未挂结算单**的收领单（`orderDate` 在期内、`settlementId` 为空），
   * 按**物资合同**（`ReceiptOrder.materialContractId`）分组：每个合同生成**一张草稿**结算单，
   * 金额 = Σ(实收数量 × 含税单价)，`settleDate` = **期末**（台账的 `settleMonth` 由它派生，
   * 两边必须同口径），并把参与的收领单回挂到这张结算单上。
   *
   * **幂等**：同一合同同一期已有结算单 → 跳过（`skipped` 计数），并把该合同本期**尚未挂单**的
   * 收领单补挂到那张已有结算单上（补关联、**不改金额**；金额定稿后不由服务端擅自改动）。
   * 重跑不会重复生成结算单；并发下即使两个请求同时通过预检，`create()` 的同期唯一校验也会拦下后一个，
   * 这里把它算作"跳过"。
   *
   * ⚠️ 收领单的回挂**不**走 `linkOrphansForContract()`：那个函数按"结算期"匹配，
   * 而这里我们已知每张收领单属于本期的哪一张结算单 —— 直接按 id 回挂更准且更快。
   */
  async generateForPeriod(
    projectId: string,
    opts: { refDate?: string; contractId?: string | null; user?: any } = {},
  ) {
    const startDay = await this.startDayOf(projectId);
    const period = previousSettlementPeriod(startDay, opts.refDate ? new Date(opts.refDate) : new Date());
    const orders = await this.prisma.receiptOrder.findMany({
      where: {
        projectId,
        settlementId: null,
        materialContractId: { not: null },
        ...(opts.contractId ? { materialContractId: opts.contractId } : {}),
        orderDate: { gte: period.start, lt: period.endExclusive },
      },
      include: { details: { select: { receivedQty: true, priceWithTax: true } } },
    });

    const byContract = new Map<string, any[]>();
    for (const o of orders) {
      const cid = o.materialContractId as string;
      const list = byContract.get(cid) ?? [];
      list.push(o);
      byContract.set(cid, list);
    }

    const contracts: any[] = byContract.size
      ? await this.prisma.contract.findMany({
          where: { id: { in: [...byContract.keys()] } },
          select: { id: true, code: true },
        })
      : [];
    const codeOf = new Map(contracts.map((c: any) => [c.id, c.code]));

    let created = 0;
    let skipped = 0;
    const createdItems: any[] = [];
    for (const [contractId, list] of byContract) {
      const existing = await this.findSettlementIdFor(contractId, period.end);
      if (existing) {
        /**
         * 该合同本期**已有结算单** → 不重复生成，但把这些尚未挂单的收领单**补挂**上去
         * （否则它们会一直悬空：本期再也不会被"抓取"到了）。
         * ⚠️ 只补关联、**不动结算单金额** —— 金额可能已按当时的收领单定稿甚至已提交，
         * 服务端不该悄悄改它；要改由人在结算单上改。
         */
        await this.prisma.receiptOrder.updateMany({
          where: { id: { in: list.map((o: any) => o.id) } },
          data: { settlementId: existing },
        });
        skipped++;
        continue;
      }
      const amount = round2(
        list.reduce(
          (s, o) =>
            s +
            (o.details || []).reduce(
              (t: number, d: any) => t + (num(d.receivedQty) || 0) * (num(d.priceWithTax) || 0),
              0,
            ),
          0,
        ),
      );
      try {
        const settlement: any = await this.create(
          {
            contractId,
            code: `JS${period.month.replace('-', '')}-${codeOf.get(contractId) || ''}`,
            typeCode: 'PROGRESS', // 月度结算按「进度款」记；如有异议可在结算单上改
            statusCode: SETTLEMENT_STATUS.DRAFT,
            amount,
            actualAmount: amount,
            settleDate: period.end,
            remark: `按月度结算期自动生成（${monthKey(period.start)}-${String(period.start.getDate()).padStart(2, '0')} ~ ${monthKey(period.end)}-${String(period.end.getDate()).padStart(2, '0')}，含 ${list.length} 张收领单）`,
          },
          projectId,
        );
        await this.prisma.receiptOrder.updateMany({
          where: { id: { in: list.map((o: any) => o.id) } },
          data: { settlementId: settlement.id },
        });
        // 回挂收领单后重刷台账（本期结算额/开票额都以结算单为准）
        await this.syncLedgerByContract(contractId);
        created++;
        createdItems.push({
          id: settlement.id,
          code: settlement.code,
          contractId,
          amount,
          receiptOrders: list.length,
        });
      } catch (e: any) {
        // 并发下撞上"同合同同期唯一"：这与"已有结算单"是同一类结果，算跳过而不是报错
        const isDup = e instanceof BadRequestException || e?.status === 400 || e?.getStatus?.() === 400;
        if (isDup) {
          skipped++;
          continue;
        }
        throw e;
      }
    }

    return {
      month: period.month,
      startDate: formatDay(period.start),
      endDate: formatDay(period.end),
      startDay,
      receiptOrders: orders.length,
      created,
      skipped,
      /**
       * 金额为 0 的生成张数：收领单**明细没有含税单价**时（数据没录全）就会算出 0 元。
       * 这不是错误（照常生成草稿，由人补金额），但**必须提示**——否则 0 元结算单会被直接提交。
       */
      zeroAmount: createdItems.filter((i) => !i.amount).length,
      contracts: createdItems,
    };
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

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '@cms/calc/numeric';
import { assertInProject, assertVersion, assertYearMonth, buildResult, paginate, versionedUpdate } from '../../common/utils/helpers';
import { pagedAll } from '../../common/utils/paged';
import { round2 } from '@cms/calc/money';
import { canonicalMonthKey, compareMonthKey, settlementAmountOf, sumAmounts } from '@cms/calc';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { ContractLockService } from '../../common/services/contract-lock.service';
import { ProjectScopeService } from '../../common/services/project-scope.service';
import { countedInvoiceWhere } from '../../constants/statuses';
import { contractChainAmount, chainSettledTotal } from '../../query';
// 账期/月份归集与结算期纯函数（与结算单侧同口径）
import { periodKeyOf, periodMonthKey, startDayOf } from '../../domain/settlement-period';

/**
 * 导出件末尾的合计行标记（`styled.exportTable({ totalsLabel: '汇总' })` 写进「项目」列）。
 * 回流时这一行不是数据行，必须跳过，否则「合同编号为必填项」整批报错（第 22 轮审计 P1-2 跟进）。
 */
const LEDGER_TOTALS_MARKERS = new Set(['汇总', '合计', '总计']);

/** 取表格里的第一个非空值：兼容模板列名与导出表头（导出件带 a/b/c/d 角标） */
const pickAny = (r: any, ...labels: string[]): any => {
  for (const label of labels) {
    const v = r[label];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};

const LEDGER_FIELDS = [
  'projectId', 'contractId', 'settleMonth', 'monthSettleAmount', 'monthInvoiceAmount', 'settleCount',
  'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount', 'monthActualPurchase',
  'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome', 'isOnAccount', 'remark',
];
/** update 白名单：不含 projectId —— 台账归属只能由 create 决定 */
const LEDGER_UPDATE_FIELDS = LEDGER_FIELDS.filter((f) => f !== 'projectId');

/**
 * 结算台账域（从 SettlementService 拆出，P1-3 大服务拆分）。
 *
 * 覆盖 SettlementLedger 表的全部读写：自动抓取字段、按合同/项目刷新、台账 CRUD、
 * 合规性检查表与台账 Excel 导出/模板/导入。
 *
 * 设计约束：只依赖 prisma / 字典 / 锁 / 项目作用域 / Excel 与导入服务；
 * **不回调 SettlementService**（期锁与同月唯一守卫留在结算单侧）。
 * SettlementService 保留同名转发方法，控制器与 finance / invoice / receipt-order / archive
 * 等外部调用点不变。
 */
@Injectable()
export class SettlementLedgerService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private styled: StyledExcelService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
    private lock: ContractLockService,
    private scope: ProjectScopeService,
  ) {}

  /** 项目的月度结算起始日（未设置 → 1，即自然月）；台账自动字段按它算期（独立一份，避免反回调结算单侧） */
  private async startDayOf(projectId: string, db: any = this.prisma): Promise<number> {
    const p = await db.project.findUnique({ where: { id: projectId }, select: { settlementStartDate: true } });
    return startDayOf(p?.settlementStartDate);
  }
  /**
   * 结算台账自动抓取字段（数据自动生成，不依赖手工录入）：
   * - 本月结算额 / 结算次数：按结算月份从结算单（Settlement.settleDate）抓取实结金额
   * - 本月开票额：**优先按 `settlementId` 精确归集**（发票与结算单对应），未关联的退回按「合同 + 月份」
   * - 保理贴息：从资金费用台账保理费用（FactoringCost，融资利息 + 手续费）按结算月份抓取
   * - 逾期利息：从资金费用台账逾期利息（OverduePayable，未减免行）按结算月份抓取
   * - 截止当月开累采购额 / 开工结算额 / 当月实际采购额：按 Excel 源表公式、用本项目实际结算单重算（用户 2026-11-19 口径）
   */
  async computeLedgerAutoFields(contractId: string, settleMonth: string, db: any = this.prisma) {
    /**
     * 结算单按**账期**筛选（第 21 轮审计）：原来用「自然月窗口」`[M-01, M+1-01)` 查 settleDate，
     * 起始日不是 1 日时，一张落在期初（如前一个月月末几天）的结算单会被算到相邻月份的行上，
     * 结果「本月结算额」在本月缺失、在邻月凭空多出。账期标签由 `periodKeyOf` 给出（期末所在月）。
     */
    // 账期统一归一为 `YYYY-MM`（历史/导入行可能是 `2026-9` 这类非零补齐格式，
    // 直接字符串比较会把它排在 `2026-10` 之后，导致「截止当月开累采购额」多算一期）。
    const period = canonicalMonthKey(settleMonth) ?? settleMonth;
    // 台账「本月结算额」**包含草稿**（有意与 contract-chain 的 notDraft 不同——
    // 见 backend-conventions.md「累计结算有两个口径」：台账回答“这条链的账现在是多少”，
    // 自动生成的草稿也是账面数据；防超结/履约才排除草稿）。
    // 按 settleDate 倒序取单：同月多张（历史数据）时稳定取最近一张作为关联目标。
    const owner = await db.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    const startDay = owner ? await this.startDayOf(owner.projectId, db) : 1;
    const allSettlements = await db.settlement.findMany({
      where: { contractId },
      // 同一账期多张结算单（历史数据）时取「最近一张」，并带 id 兜底保证与 linkOrphansForContract 完全同一张（第 22 轮审计 P1-4）
      orderBy: [{ settleDate: 'desc' }, { id: 'desc' }],
    });
    const settlements = allSettlements.filter((r: any) => periodKeyOf(startDay, r.settleDate) === period);
    /** 该行对应的结算单（同合同同月唯一 → 至多一张）；无则 null = 「仅费用行」 */
    const settlementId = (settlements[0] as any)?.id ?? null;
    const [invoices, factoring, overdue] = await Promise.all([
      /**
       * 发票按月归集（业务口径 2026-10-16「发票与结算单对应」）：
       * ① **已挂到本行结算单**的发票全算 —— 精确到单据，与「结算账期」那串自由文本怎么写无关；
       * ② **未挂任何结算单**的，退回按「合同 + 月份」归集（兼容存量数据，也支撑"当月无结算单"的仅费用行）；
       * ⚠️ 已挂到**别的**结算单的发票一律不算 —— 它属于那一行的口径，两边都计会重复。
       * ⚠️ 业务口径 2026-11-12：作废/红冲发票不计入「本月开票额」（`countedInvoiceWhere()`）；
       * 历史/导入的空状态发票仍计入。这里必须用 `AND` 包裹：原条件本身就是 `OR`，
       * 直接展开 `{ OR }` 会把两个条件互相覆盖。
       */
      db.invoice.findMany({
        where: {
          AND: [
            settlementId
              ? // 已挂本行的发票必须同时属于本合同（或历史数据里**未挂合同**、但已挂在结算单上的发票——
                // `assertLinkable` 现已要求合同完全一致，这类只可能是改造前的存量关联，不能静默漏计）；
                // 结算单改过合同后遗留的旧关联不能算进新合同的「本月开票额」（解绑由 linkOrphansForContract 兜底）
                { OR: [{ settlementId, OR: [{ contractId }, { contractId: null }] }, { contractId, settlementId: null }] }
              : { contractId, settlementId: null },
            countedInvoiceWhere(),
          ],
        },
        select: { id: true, settlementId: true, settlePeriod: true, invoiceDate: true, amountWithTax: true },
      }),
      db.factoringCost.findMany({ where: { contractId } }), // @no-limit: 单合同保理费用行（按 contractId 有界）
      db.overduePayable.findMany({ where: { contractId } }), // @no-limit: 单合同逾期利息行（按 contractId 有界）
    ]);
    // 审定口径（actualAmount ?? amount）统一走共享原语，避免台账/合同链各写一次 ??
    const monthSettleAmount = sumAmounts(settlements, (r: any) => settlementAmountOf(r, 'actual'));

    /**
     * 结算次数：该合同按结算期（账期/自然月）**时间顺序的第几次结算**（1、2、3…），供导出/列定义展示；
     * 当期无结算单（仅费用行）→ 0。序号依据本合同全部结算单去重后的结算期升序确定，
     * 与 Excel 源表「结算次数」以时间顺序编号的口径一致（用户 2026-11-18 口径）。
     */
    const settlementPeriods = Array.from(
      new Set(
        allSettlements
          .map((r: any) => periodKeyOf(startDay, r.settleDate))
          .filter((k: string | null): k is string => Boolean(k)),
      ),
    ).sort();
    const settleCount = settlements.length ? settlementPeriods.indexOf(period) + 1 : 0;
    /**
     * 本年结算额：该合同**同一自然年内**各结算期「本月结算额」之和（业务口径 2026-11-19，用户确认，
     * 与 Excel 源表 col9 的 `SUMIFS(本月结算额, 合同=本, 结算月份∈本行同一年)` 一致）。
     * 按账期分月汇总后再按年（YYYY）累加；当期无结算单（仅费用行）不影响——它只贡献本年其他月份的合计。
     */
    const settleAmountByPeriod = new Map<string, number>();
    for (const r of allSettlements) {
      const k = periodKeyOf(startDay, r.settleDate);
      if (!k) continue;
      settleAmountByPeriod.set(k, round2((settleAmountByPeriod.get(k) || 0) + (settlementAmountOf(r, 'actual') || 0)));
    }
    const targetYear = String(canonicalMonthKey(settleMonth) ?? settleMonth).slice(0, 4);
    let yearSettleAmount = 0;
    for (const [k, v] of settleAmountByPeriod) {
      if (k.slice(0, 4) === targetYear) yearSettleAmount += v;
    }
    yearSettleAmount = round2(yearSettleAmount);
    const monthInvoiceAmount = round2(
      invoices
        .filter(
          (i: any) =>
            (settlementId && i.settlementId === settlementId) ||
            (periodMonthKey(i.settlePeriod) ?? periodKeyOf(startDay, i.invoiceDate)) === period,
        )
        .reduce((s: number, i: any) => s + (num(i.amountWithTax) || 0), 0),
    );
    // 保理贴息 / 逾期利息按**账期**归集（settlementMonth 可能非零补齐，统一 canonical）：
    // 既取本行当月值（c、d），也供「截止当月开累采购额 = Σ当月实际采购额 b」按历史各期累计。
    const costOf = (r: any) => num(r.totalCost) ?? (num(r.financingInterest) || 0) + (num(r.handlingFee) || 0);
    const factoringByPeriod = new Map<string, number>();
    for (const r of factoring) {
      const k = canonicalMonthKey(r.settlementMonth);
      if (!k) continue;
      factoringByPeriod.set(k, round2((factoringByPeriod.get(k) || 0) + (costOf(r) || 0)));
    }
    const overdueByPeriod = new Map<string, number>();
    for (const r of overdue) {
      const k = canonicalMonthKey(r.settlementMonth);
      if (!k) continue;
      // waived 行按 0 排除，与逾期汇总 interestOf 同口径
      const v = r.waived ? 0 : (num(r.overdueInterest) || 0);
      overdueByPeriod.set(k, round2((overdueByPeriod.get(k) || 0) + v));
    }
    const factoringDiscount = round2(factoringByPeriod.get(period) || 0);
    const overdueSum = round2(overdueByPeriod.get(period) || 0);

    /**
     * 截止当月开累采购额 / 开工结算额 / 当月实际采购额：按 Excel 源表公式、用本项目实际结算单重算（用户 2026-11-19 口径）：
     * - 开工结算额 = Σ 该合同**全部结算期**「本月结算额」（= 合同累计结算额，各行相同）；
     *   对应 Excel `SUMIFS(本月结算额, 合同=本)`。
     * - 截止当月开累采购额 = Σ **结算期 ≤ 本行** 的「当月实际采购额 b」(= a − c − d)
     *   （用户 2026-11-19 修正口径：不再按「本月结算额 a」累计，而是按 b 累计）。
     * - 当月实际采购额 b = 本月结算额 a − 保理贴息 c − 逾期利息 d（对应 `b = a - c - d`）。
     */
    // 汇总期集合 = 结算期 ∪ 保理期 ∪ 逾期期（仅费用、无结算单的账期也要计入 b 的累计，b 可能为负）
    const allPeriods = new Set<string>([
      ...settleAmountByPeriod.keys(),
      ...factoringByPeriod.keys(),
      ...overdueByPeriod.keys(),
    ]);
    let startSettleAmount = 0;
    let cumPurchaseAmount = 0;
    for (const k of allPeriods) {
      const a = settleAmountByPeriod.get(k) || 0;
      startSettleAmount += a; // 开工结算额 = Σ 全部期「本月结算额」a
      if (compareMonthKey(k, period) <= 0) {
        // 截止当月开累采购额 = Σ 结算期≤本行的「当月实际采购额」b = a − c − d
        const bPeriod = a - (factoringByPeriod.get(k) || 0) - (overdueByPeriod.get(k) || 0);
        cumPurchaseAmount += bPeriod;
      }
    }
    startSettleAmount = round2(startSettleAmount);
    cumPurchaseAmount = round2(cumPurchaseAmount);
    const monthActualPurchase = round2(monthSettleAmount - factoringDiscount - overdueSum);

    return {
      monthSettleAmount,
      monthInvoiceAmount,
      settleCount,
      yearSettleAmount,
      cumPurchaseAmount,
      startSettleAmount,
      monthActualPurchase,
      factoringDiscount,
      overdueInterest: overdueSum,
      settlementId,
    };
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
    const auto = await this.computeLedgerAutoFields(contractId, settleMonth, db);
    const exist = await db.settlementLedger.findFirst({ where: { projectId, contractId, settleMonth } });
    if (exist) {
      return db.settlementLedger.update({
        where: { id: exist.id },
        data: { ...auto, version: { increment: 1 } },
      });
    }
    try {
      return await db.settlementLedger.create({ data: { projectId, contractId, settleMonth, ...auto } });
    } catch (e: any) {
      // 先查后建在并发下必然有竞态：两个「刷新台账」、或导入发票的 afterCommit 与保存结算单同时到达，
      // 后到者撞 @@unique([projectId, contractId, settleMonth]) 抛 P2002 → 整个事务回滚变 500。
      // 这里退化为更新已有行，让并发两侧都成功（幂等）。
      if (e?.code !== 'P2002') throw e;
      const row = await db.settlementLedger.findFirst({ where: { projectId, contractId, settleMonth } });
      if (!row) throw e;
      return db.settlementLedger.update({
        where: { id: row.id },
        data: { ...auto, version: { increment: 1 } },
      });
    }
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
    const startDay = await this.startDayOf(projectId, db);
    // (a) 该合同所有结算单所在的**账期**（期末所在月），不是自然月（第 21 轮审计）
    // @no-limit: 单个合同的全部结算单（按 contractId，天然有界）
    const settlements = await db.settlement.findMany({
      where: { contractId },
      select: { settleDate: true },
    });
    for (const s of settlements) {
      const m = periodKeyOf(startDay, s.settleDate);
      if (m) months.add(m);
    }
    // (b) 已有台账行的月份（含**仅费用行**：无结算单但有资金费用/逾期利息）
    // @no-limit: 单个合同的全部台账行（按 contractId，天然有界）
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
      // ③ 收尾：把「只由发票撑起来、现已归零」的空行剪掉（作废/红冲后月份不该留 0 元行）
      await this.pruneEmptyLedgerRows(exec, contractId);
    };
    // 整体放在一个事务里：清空与重挂之间不能有窗口（否则中途失败会留下"全部无关联"的台账）
    /**
     * 超时口径（2026-11-23）：原为 `timeout: 30000`，没有理由说明。
     * 事务体是"清关联 → 逐月 upsert → 剪空行"，语句数随该合同的**月份数**线性增长（实测个位数月份），
     * 默认 5s 足够；收紧到 15s + `maxWait` 5s，避免单连接长事务长期占连接。
     * 若将来出现月份数极多的合同导致超时，应改为分批（每批一个事务）而不是把超时调回去。
     */
    if (tx) await run(tx);
    else await this.prisma.$transaction(async (t) => run(t), { maxWait: 5000, timeout: 15000 });

    return months.size;
  }

  /**
   * 剪除「空行」：无结算单、四个自动金额列全 0/空、且没有任何手填内容的台账行。
   *
   * 场景：某月原本只有一张有效发票 → 发票作废/红冲后，该行自动字段归 0，但
   * `syncLedgerByContract()` 只 upsert 不删行；而「先作废再刷新」又不会建行 →
   * 同一业务状态出现两种库形（有 0 元行 / 无行）。这里在同一个事务里收口。
   * ⚠️ 只删**纯自动**行：任一手填列（挂账/备注/盘点量/年度收入…）非空都保留。
   * ⚠️ 判空**只能用行内派生列**（monthSettleAmount/monthInvoiceAmount/factoringDiscount/
   *   overdueInterest/settleCount/monthActualPurchase）。**不可**把 `yearSettleAmount`、
   *   `startSettleAmount`、`cumPurchaseAmount` 这 3 个**合同级/年度级汇总列**放进条件——
   *   它们对该合同恒为合同合计（非 0），混进来会让空行永远剪不掉，与「剪除空行」目标相反
   *   （第 23 轮审计 P2，2026-11-19）。
   */
  private async pruneEmptyLedgerRows(exec: any, contractId: string) {
    const zeroOrNull = (field: string) => ({ OR: [{ [field]: null }, { [field]: 0 }] });
    await exec.settlementLedger.deleteMany({
      where: {
        contractId,
        settlementId: null,
        AND: [
          zeroOrNull('monthSettleAmount'),
          zeroOrNull('monthInvoiceAmount'),
          zeroOrNull('factoringDiscount'),
          zeroOrNull('overdueInterest'),
          // settleCount 由自动派生写入 0（当期无结算单时；有结算单则为时间顺序序号），手填列一律要求 null 才算「纯自动空行」
          zeroOrNull('settleCount'),
          // 当月实际采购额 = a−c−d，行内派生（不引入合同级汇总，见上）
          zeroOrNull('monthActualPurchase'),
        ],
        isOnAccount: null,
        remark: null,
        yearSettleIncome: null,
        cumSettleIncome: null,
      },
    });
  }

  /** 一键自动生成/刷新台账：扫描结算单、收票登记、资金费用台账中的合同+月份组合，自动生成缺失行并刷新自动字段 */
  async refreshLedger(projectId: string) {
    // 资金费用两张表没有 projectId 列（只挂 contractId），先取本项目合同再按 id 过滤：
    // 原先 `findMany({ select })` 全表读，再在内存里用 contractIds 过筛——
    // 表一大就整表进内存，且与「查询必须自带项目过滤」的铁律相悖。
    const contracts = await this.prisma.contract.findMany({ where: { projectId }, select: { id: true } });
    const contractIdList = contracts.map((c: any) => c.id);
    const [settlements, invoices, factoring, overdue] = await Promise.all([
      this.prisma.settlement.findMany({ where: { projectId }, select: { contractId: true, settleDate: true } }),
      // 作废/红冲发票不参与「合同 + 月份」组合发现：否则会凭空建出一个 0 金额的台账行
      this.prisma.invoice.findMany({
        where: { projectId, ...countedInvoiceWhere() },
        select: { contractId: true, settlePeriod: true, invoiceDate: true },
      }),
      contractIdList.length
        ? this.prisma.factoringCost.findMany({ where: { contractId: { in: contractIdList } }, select: { contractId: true, settlementMonth: true } })
        : [],
      contractIdList.length
        ? this.prisma.overduePayable.findMany({ where: { contractId: { in: contractIdList } }, select: { contractId: true, settlementMonth: true } })
        : [],
    ]);
    const contractIds = new Set(contracts.map((c: any) => c.id));
    const combos = new Set<string>();
    const add = (contractId: string | null, month: string | null) => {
      if (contractId && month) combos.add(`${contractId}|${month}`);
    };
    // 结算单 → 台账月份必须按**账期**（期末所在月），不能用自然月：起始日不是 1 日时
    // 一张 10/28 的结算单属于 10/26–11/25 这一期，台账行应落在「2026-11」（第 21 轮审计）
    const startDay = await this.startDayOf(projectId);
    for (const s of settlements) add(s.contractId, periodKeyOf(startDay, s.settleDate));
    for (const i of invoices) add(i.contractId, periodMonthKey(i.settlePeriod) ?? periodKeyOf(startDay, i.invoiceDate));
    for (const f of factoring) if (contractIds.has(f.contractId)) add(f.contractId, f.settlementMonth);
    for (const o of overdue) if (contractIds.has(o.contractId)) add(o.contractId, o.settlementMonth);
    let created = 0;
    let updated = 0;
    /**
     * 第 15/16 轮审计：原来每个「合同 × 月份」组合先 `findFirst` 再 `upsertLedgerRow`
     * （组合数 × 7 次串行往返），100 合同 × 12 个活跃月 ≈ 8400 次串行 SQL，
     * 同步 HTTP 必然超网关超时，期间还占着连接池。
     *
     * 现在：① 一次性把本项目已有台账行的 (contractId, settleMonth) 读回来定位「新增/更新」，
     * 省掉每个组合的一次点查；② 按 8 并发分批跑 upsert，把往返从「串行 N」压成「N/8」。
     * 单行 upsert 内部仍是原来的节奏（自动字段、settlementId 都在那里落），不改语义。
     */
    const existing = await this.prisma.settlementLedger.findMany({
      where: { projectId },
      select: { contractId: true, settleMonth: true },
    });
    const existed = new Set(existing.map((r: any) => `${r.contractId}|${r.settleMonth}`));
    const combosArr = Array.from(combos);
    const CONCURRENCY = 8;
    for (let i = 0; i < combosArr.length; i += CONCURRENCY) {
      const slice = combosArr.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (combo) => {
          const [contractId, settleMonth] = combo.split('|');
          // 与「结算单驱动」共用同一个 upsert（自动字段 + settlementId 都在那里落）
          await this.upsertLedgerRow(contractId, projectId, settleMonth);
        }),
      );
      for (const combo of slice) {
        if (existed.has(combo)) updated++;
        else created++;
      }
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
    return buildResult(list, total, query, maxPageSize);
  }

  async ledgerOne(id: string, projectId?: string) {
    const l = await this.prisma.settlementLedger.findUnique({ where: { id } });
    // 与 findOne 相同的防御纵深：台账行按 id 直读同样要核归属
    return assertInProject(l, projectId, '结算台账记录不存在');
  }

  /**
   * 台账里的**只读派生字段**：这些列全部由 `computeLedgerAutoFields()` 在每次保存/刷新时
   * 覆盖写入，手工传值本就不生效。与其"改了没用"，不如**明确 400 报错**并把人引到正确入口
   * （静默忽略会让人以为改成功了，那比报错更糟）。
   * - `factoringDiscount ← 资金费用台账（FactoringCost）`
   * - `overdueInterest ← 逾期利息台账（OverduePayable）`
   * - `monthSettleAmount / settleCount / yearSettleAmount ← 结算单（Settlement）`
   * - `cumPurchaseAmount / startSettleAmount / monthActualPurchase ← 结算单（按 Excel 公式派生）`
   */
  private static readonly READONLY_LEDGER_FIELDS = [
    'factoringDiscount',
    'overdueInterest',
    'monthSettleAmount',
    'settleCount',
    'yearSettleAmount',
    'cumPurchaseAmount',
    'startSettleAmount',
    'monthActualPurchase',
  ] as const;

  private assertLedgerWritable(data: any) {
    const bad = SettlementLedgerService.READONLY_LEDGER_FIELDS.filter((f) => data?.[f] !== undefined);
    if (bad.length) {
      throw new BadRequestException(
        `结算台账的「${bad.join('、')}」是**只读派生列**：` +
          '「保理贴息/逾期利息」请分别到「资金费用台账」「逾期利息」处修改；' +
          '「本月结算额/结算次数/本年结算额/开累采购额/开工结算额/当月实际采购额」由结算单与发票自动派生，不可手工写入。' +
          '保存后结算台账会自动同步。',
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
    // 归档锁定：台账也是结算域的写入口（与结算单 create/update/remove 同口径）
    await this.lock.assertWritable(data.contractId, '新增结算台账');
    if (!opts?.fromImport) this.assertLedgerWritable(data);
    // 结算月份同样按字符串精确匹配（台账按月列、自动抓取结算单/开票额都按它），格式错会静默对不上
    assertYearMonth(data.settleMonth, '结算月份');
    // 引用合同必须属于当前项目（导入路径的合同由 plan 阶段按项目解析，此处只兜交互式写入）
    if (!tx) await this.scope.assertContractInProject(data.contractId, projectId, '合同');
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = { ...pickFields(data, LEDGER_FIELDS, { label: '结算台账' }), projectId };
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    if (payload.contractId && payload.settleMonth) {
      const auto: any = await this.computeLedgerAutoFields(payload.contractId, payload.settleMonth, db);
      /**
       * **填充式**合并（第 22 轮审计 P1-1）：自动抓取只补空值，不再无条件覆盖。
       * 原来 `Object.assign(payload, auto)` 有两个后果：
       * ① 当月没有结算单/发票时，用户填的「本月结算额」「本月开票额」被抹成 null —— 数据凭空消失；
       * ② 模板里这几列照旧让人填，填了既不生效也不提示。
       * 现在的口径：有业务单据 → 以系统抓取值为准（台账是派生视图，口径不能被人手改歪）；
       * 系统算不出来（当月无结算单/发票/资金费用）→ 保留手工填写值，不再清空。
       */
      for (const [k, v] of Object.entries(auto)) {
        if (payload[k] === undefined || payload[k] === null) payload[k] = v;
      }
      /**
       * 「本月结算额」「结算次数」是**纯派生**列（业务口径 2026-10-22）：
       * 只有一个来源 —— 该账期内的结算单（没有结算单就是 0 / 0），任何手填值一律无效。
       * 其余自动列保留上面的「填充式」：系统算不出来时不抹掉用户填的值。
       */
      payload.monthSettleAmount = auto.monthSettleAmount;
      payload.settleCount = auto.settleCount;
      payload.yearSettleAmount = auto.yearSettleAmount;
      payload.cumPurchaseAmount = auto.cumPurchaseAmount;
      payload.startSettleAmount = auto.startSettleAmount;
      payload.monthActualPurchase = auto.monthActualPurchase;
      payload.settlementId = auto.settlementId;
    }
    // 唯一键预检（@@unique([projectId, contractId, settleMonth])）：直接 create 撞键会抛未捕获的
    // P2002 变成 500，这里先给出可读的 400
    await this.assertLedgerMonthUnique(projectId, payload.contractId ?? null, payload.settleMonth ?? null);
    try {
      return await db.settlementLedger.create({ data: payload });
    } catch (e: any) {
      // 预检与写入之间仍有窗口（同一个用户双击「新增」、或两个标签页同时提交）：
      // P2002 说明这一行刚好被别人建了，转成与预检一致的可读 400，而不是未捕获的 500
      if (e?.code !== 'P2002') throw e;
      throw new BadRequestException(
        `该合同 ${payload.settleMonth ?? ''} 的结算台账已存在，请勿重复新增`,
      );
    }
  }

  async updateLedger(id: string, data: any, projectId?: string) {
    const old = await this.ledgerOne(id, projectId);
    // 归档锁定：与原合同、目标合同都要校验（改合同时两边都受影响）
    await this.lock.assertWritable(old.contractId, '修改结算台账');
    if (data.contractId && data.contractId !== old.contractId) {
      await this.lock.assertWritable(data.contractId, '修改结算台账');
    }
    /**
     * 已挂结算单的行是**自动维护的 1:1 行**：改它的合同/月份会让结算单失去 `ledgerEntry`、
     * 旧合同该月行不再刷新（与 removeLedger 的 400 同一个理由）。要调整先处理结算单。
     */
    if (old.settlementId && (data.contractId !== undefined || data.settleMonth !== undefined)) {
      const changingContract = data.contractId !== undefined && data.contractId !== old.contractId;
      const changingMonth = data.settleMonth !== undefined && data.settleMonth !== old.settleMonth;
      if (changingContract || changingMonth) {
        throw new BadRequestException(
          '该台账行由结算单自动维护（台账行与结算单 1:1），不能改合同或结算月份；请先处理对应结算单，或使用「刷新台账」重算。',
        );
      }
    }
    assertVersion(old, data);
    await this.assertLedgerWritable(data);
    assertYearMonth(data.settleMonth, '结算月份');
    if (data.contractId !== undefined) {
      await this.scope.assertContractInProject(data.contractId, projectId ?? old.projectId, '合同');
    }
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = pickFields(data, LEDGER_UPDATE_FIELDS, { label: '结算台账' });
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    // 自动生成：以本次变更后的合同+月份为准重新抓取
    const contractId = payload.contractId ?? old.contractId;
    const settleMonth = payload.settleMonth ?? old.settleMonth;
    if (contractId && settleMonth) {
      const auto: any = await this.computeLedgerAutoFields(contractId, settleMonth);
      const monthChanged = contractId !== old.contractId || settleMonth !== old.settleMonth;
      for (const [k, v] of Object.entries(auto)) {
        /**
         * 与 `createLedger` 同口径：**只补空值**，不无条件覆盖。
         * 原实现 `Object.assign(payload, auto)` 会在「本月无发票」时把历史/导入数据里
         * 手填的「本月开票额」抹成 0 —— 用户只改个备注，开票额就静默归零（与第 22 轮审计
         * 在 create 上修过的是同一个坑，update 漏了）。
         * 例外：三个纯派生列始终取系统值；改合同/改月份时旧月份的自动值不再适用，也一律取系统值。
         */
        const forced = k === 'monthSettleAmount' || k === 'settleCount' || k === 'yearSettleAmount'
          || k === 'cumPurchaseAmount' || k === 'startSettleAmount' || k === 'monthActualPurchase'
          || k === 'settlementId' || monthChanged;
        if (forced || payload[k] === undefined || payload[k] === null) payload[k] = v;
      }
    }
    delete payload.version;
    // 唯一键预检：把月份/合同改成已存在的组合时，前端的 update 会撞 P2002 → 500，这里统一转 400
    await this.assertLedgerMonthUnique(old.projectId, contractId ?? null, settleMonth ?? null, id);
    return versionedUpdate(this.prisma.settlementLedger, id, old.version, payload);
  }

  /** 台账「合同 + 结算月」项目内唯一（DB 有 @@unique，这里提前给出可读错误） */
  private async assertLedgerMonthUnique(projectId: string, contractId: string | null, settleMonth: string | null, excludeId?: string) {
    if (!contractId || !settleMonth) return;
    const dup = await this.prisma.settlementLedger.findFirst({
      where: { projectId, contractId, settleMonth, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (dup) throw new BadRequestException(`该合同 ${settleMonth} 的结算台账已存在，请勿重复新增`);
  }

  async removeLedger(id: string, projectId?: string) {
    const row = await this.ledgerOne(id, projectId);
    // 归档锁定：台账删除同样属于结算域的写操作
    await this.lock.assertWritable(row.contractId, '删除结算台账');
    /**
     * 已关联结算单的行由 `syncLedgerByContract()` 自动维护（台账行与结算单 1:1）：
     * 直接删掉会让结算单丢了 `ledgerEntry`，下次刷新又被重建——"删了又回来"比报错更让人困惑。
     * 仅费用行（`settlementId = null`）仍可手工删除。
     */
    if (row.settlementId) {
      throw new BadRequestException(
        '该台账行对应的结算单仍在（台账行与结算单 1:1），不能直接删除；请先处理结算单，或使用「刷新台账」重算。',
      );
    }
    await this.prisma.settlementLedger.delete({ where: { id } });
    return true;
  }

  /** 月度结算单合规性检查表（需求 2.7）：表头信息 + 检查项清单 + 签字区 */
  async exportComplianceSheet(contractId: string, projectId: string, year?: number, month?: number) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { name: true } }, project: { select: { name: true } } },
    });
    // 项目隔离（结算模块审计 P1-1）：合同必须属于当前项目，否则按 id 直达可导出别的项目的合规表
    if (!contract || contract.projectId !== projectId) throw new NotFoundException('合同不存在');
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
    const ratioPct = chainAmount && chainAmount > 0 ? round2((chainSettled / chainAmount) * 100) : null;
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

  /**
   * 导出用全量台账行：`findLedger({ pageSize: 2000 })` 受单页上限（默认 500）截断，
   * 台账行超过上限时导出文件**静默**少行、合计偏小。按页拉全量（与发票/付款导出同口径）。
   */
  private allLedgerRows(projectId: string, settleMonth?: string): Promise<any[]> {
    return pagedAll((page, pageSize) =>
      this.findLedger({ page, pageSize, ...(settleMonth ? { settleMonth } : {}) }, projectId, pageSize),
    );
  }

  /** 导出台账 Excel；`settleMonth` 传入时只导该月（归档按期目录用，避免每期都塞全项目台账） */
  async exportLedger(projectId: string, settleMonth?: string) {
    const all = await this.allLedgerRows(projectId, settleMonth);
    const res: any = { list: all, total: all.length };
    const yesNo = await this.dict.nameMap('yes_no');
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const rows = (res.list as any[]).map((r) => ({
      projectName: project?.name || '',
      supplierName: r.contract?.supplier?.name, contractName: r.contract?.name, contractCode: r.contract?.code,
      settleMonth: r.settleMonth, monthSettleAmount: num(r.monthSettleAmount), monthInvoiceAmount: num(r.monthInvoiceAmount),
      settleCount: r.settleCount, yearSettleAmount: num(r.yearSettleAmount),
      cumPurchaseAmount: num(r.cumPurchaseAmount),
      startSettleAmount: num(r.startSettleAmount), monthActualPurchase: num(r.monthActualPurchase),
      factoringDiscount: num(r.factoringDiscount), overdueInterest: num(r.overdueInterest),
      yearSettleIncome: num(r.yearSettleIncome), cumSettleIncome: num(r.cumSettleIncome),
      isOnAccountName: yesNo[r.isOnAccount]?.name || '',
    }));
    return this.styled.exportTable({
      sheetName: '结算台账',
      logoColumn: true,
      title: `结算台账（${project?.name || ''}${settleMonth ? ' · ' + settleMonth : ''}）`,
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
  async templateLedger(_projectId: string) {
    const yesNo = await this.dict.options('yes_no');
    const columns: TemplateColumn[] = [
      { label: '合同编号', key: 'contractCode', required: true, width: 20, example: 'HT-2026-0001', desc: '须为合同台账中已存在的合同编号' },
      { label: '结算月份', key: 'settleMonth', required: true, type: 'text', width: 14, example: '2026-08', desc: '格式 YYYY-MM，填**账期标签**（期末所在月）：月度结算起始日不是 1 号时，一期跨两个自然月，按后一个月填' },
      { label: '本月结算额', key: 'monthSettleAmount', type: 'money', width: 16, example: 1234567.89, desc: '**系统派生**：本期结算单实际金额合计（本期无结算单即为 0）。此列填了也不生效，导入时忽略' },
      { label: '本月开票额', key: 'monthInvoiceAmount', type: 'money', width: 16, example: 1396621.72, desc: '当月有发票时以系统抓取值为准；无发票时才用手填值' },
      { label: '结算次数', key: 'settleCount', type: 'int', width: 10, example: 2, desc: '**系统派生**：该合同按结算期时间顺序的第几次结算（1、2、3…；当期无结算单为 0）。此列填了也不生效，导入时忽略' },
      { label: '开累采购额', key: 'cumPurchaseAmount', type: 'money', width: 16, example: 50000000, desc: '**系统派生**：结算期 ≤ 本行的「当月实际采购额 b」(a−c−d) 累计。此列填了也不生效，导入时忽略' },
      { label: '开工结算额', key: 'startSettleAmount', type: 'money', width: 16, example: 1000000, desc: '**系统派生**：该合同全部结算期「本月结算额」合计。此列填了也不生效，导入时忽略' },
      { label: '本月实际采购额', key: 'monthActualPurchase', type: 'money', width: 16, example: 1180000, desc: '**系统派生**：本月结算额 − 保理贴息 − 逾期利息。此列填了也不生效，导入时忽略' },
      { label: '保理贴息', key: 'factoringDiscount', type: 'money', width: 14, example: 12345.67, desc: '系统从资金费用台账抓取，手填不生效' },
      { label: '逾期利息', key: 'overdueInterest', type: 'money', width: 14, example: 0, desc: '系统从逾期利息台账抓取，手填不生效' },
      { label: '本年结算收入', key: 'yearSettleIncome', type: 'money', width: 16, example: 8000000 },
      { label: '开累结算收入', key: 'cumSettleIncome', type: 'money', width: 16, example: 9000000 },
      { label: '是否挂账', key: 'isOnAccount', type: 'select', width: 10, example: '否', options: yesNo.map((i: any) => i.itemName).filter(Boolean) },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '结算台账', sheetName: '数据', columns });
  }

  /** 结算台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importLedger(buffer: Buffer, projectId: string, meta?: { fileName?: string; user?: any; validateOnly?: boolean; mode?: string }) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    /** 覆盖模式（第 22 轮审计 P1-1）：默认「只新增不覆盖」，导出→改→导回时用 upsert 才更新已有行 */
    const upsert = String(meta?.mode ?? '').toLowerCase() === 'upsert';
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'settlement-ledger', moduleName: '结算台账', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r) => {
        // 导出件末尾的合计行不是数据行：跳过（返回 null 由 runner 忽略）
        if (LEDGER_TOTALS_MARKERS.has(String(r['项目'] ?? '').trim())) return null;
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const month = String(r['结算月份'] ?? '').trim();
        if (!/^\d{4}-\d{2}$/.test(month)) throw new RowError('结算月份为必填项，格式 YYYY-MM（如 2026-08）', '结算月份');
        notDup(`${contract.id}|${month}`, `唯一性校验失败：该合同 ${month} 的记录在本次导入中重复`, '结算月份');
        const dup: any = await this.prisma.settlementLedger.findFirst({
          where: { projectId, contractId: contract.id, settleMonth: month },
          select: { id: true },
        });
        if (dup && !upsert) {
          throw new RowError(
            `唯一性校验失败：该合同 ${month} 的结算台账已存在（如需覆盖，请勾选「已存在则更新」后再导入）`,
            '结算月份',
          );
        }
        const isOnAccount = String(r['是否挂账'] ?? '').trim();
        return {
          existingId: dup?.id ?? null,
          data: {
            contractId: contract.id,
            settleMonth: month,
            // 「本月结算额」纯派生（业务口径 2026-10-22）：表里填的一律忽略，写入时由系统按账期结算单重算
            monthSettleAmount: undefined,
            monthInvoiceAmount: num(r['本月开票额']),
            settleCount: undefined, // 结算次数同样纯派生（该合同按时间顺序的第几次结算）
            // 截止当月开累采购额 / 开工结算额 / 当月实际采购额 均为纯派生（2026-11-19，按结算单重算）：表里填的一律忽略
            cumPurchaseAmount: undefined,
            startSettleAmount: undefined,
            monthActualPurchase: undefined,
            factoringDiscount: num(pickAny(r, '保理贴息', '保理贴息 c')),
            overdueInterest: num(pickAny(r, '逾期利息', '逾期利息 d')),
            yearSettleIncome: num(pickAny(r, '本年结算收入', '本年结算对应收入（含税）')),
            cumSettleIncome: num(pickAny(r, '开累结算收入', '开累结算对应收入（含税）')),
            isOnAccount: isOnAccount || null,
            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        let created = 0;
        let updated = 0;
        for (const p of plans as any[]) {
          if (upsert && p.existingId) {
            // 覆盖模式：只更新模板里的可写列（自动抓取字段仍是「系统算得出就用系统的」），并推进乐观锁版本
            const auto: any = p.data.contractId && p.data.settleMonth
              ? await this.computeLedgerAutoFields(p.data.contractId, p.data.settleMonth, tx)
              : {};
            const payload: any = { ...p.data };
            for (const [k, v] of Object.entries(auto)) if (payload[k] === undefined || payload[k] === null) payload[k] = v;
            // 纯派生列强制用系统值（第 22 轮审计 P1-1 之后的补充：派生列不接受手填/表填）
            payload.monthSettleAmount = auto.monthSettleAmount;
            payload.settleCount = auto.settleCount;
            payload.yearSettleAmount = auto.yearSettleAmount;
            payload.cumPurchaseAmount = auto.cumPurchaseAmount;
            payload.startSettleAmount = auto.startSettleAmount;
            payload.monthActualPurchase = auto.monthActualPurchase;
            payload.settlementId = auto.settlementId;
            await tx.settlementLedger.update({ where: { id: p.existingId }, data: { ...payload, version: { increment: 1 } } });
            updated += 1;
          } else {
            await this.createLedger(p.data, projectId, tx, { fromImport: true });
            created += 1;
          }
        }
        return { created, updated };
      },
    }, meta?.validateOnly ?? false);
  }
}

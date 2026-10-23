/**
 * AI 预警 · 结算/付款异常（矩阵课题 6-9）—— **8 条规则的纯函数实现**。
 *
 * == 设计前提（为什么不是矩阵里写的 R1..R6）==
 * 原始设想里 R1 = 「同合同 + 同结算期间 + 金额相近」。这条在库里**已经被结构挡掉**：
 * - `SettlementLedger.settlementId @unique` + 台账「同合同同月一行」→ 同月不可能挂两张结算单；
 * - `SettlementService.assertMonthUniqueForContract` → 建单时就拦。
 * 所以真正的「重复结算」不是同月重复，而是下面三种（各自有真实数据形态）：
 *   R1-a 跨期指纹重复：换了月份，但金额相同、明细物资几乎重合（同一批活被结算两次）；
 *   R1-b 同物资重复计量：单张单子不超，**跨单累计**超合同链清单量；
 *   R1-c 总结算快照偏离：总结算单抓了月度结算，之后月度结算被改，快照没跟着改。
 * R6 同理改造：`PaymentProcedure` **没有审批时间字段**（原设想「审批晚于付款」无法判定），
 * 能判的是「单据上的开累快照 ≠ 实时台账」——事后补录留下的真实痕迹。
 *
 * == 硬约束 ==
 * ① **只算「已经发生的事实」**：本文件不猜业务意图，只做区间与集合比较；
 * ② **宁可漏报不许错报**：任何一个输入缺口（金额为 null、无付款比例、无清单量）
 *    一律走 `notEvaluated`（或直接跳过该对象），绝不把「未填」当 0
 *    —— 与 `contract-chain.ts`「主合同未填金额 → 返回 null 而非 0」同一取舍；
 * ③ 金额全程 `bigint` 分、数量全程 `bigint` 1e-4 单位（见 anomaly-types.ts 文件头）；
 * ④ 输出确定性：排序固定（等级 → 规则码 → 对象 ID），便于逐条对账与快照测试。
 */

import { monthKey } from '../../../common/utils/settlement-period.ts';
import {
  CONTRACT_STATUS,
  INVOICE_STATUS,
  LEGACY_CONTRACT_STATUS_COMPLETED,
  PAYMENT_EXCLUDED_STATUSES,
  SETTLEMENT_STATUS,
} from '../../../constants/statuses.ts';
import {
  ANOMALY_CODES,
  ANOMALY_LEVEL,
  centsToYuan,
  moneyToCents,
  qtyToUnits,
  ratioToBp,
  resolveTolerances,
  unitsToQty,
  type AnomalyEvaluation,
  type AnomalyLevel,
  type AnomalySummary,
  type AnomalyTolerances,
  type Cents,
  type ContractRow,
  type FinalSettlementItemRow,
  type Finding,
  type InvoiceRow,
  type MaterialQtyRow,
  type PaymentAnomalyInput,
  type PaymentRow,
  type ProcedureRow,
  type ReceiptRow,
  type SettlementRow,
} from './anomaly-types.ts';

/**
 * 合同 → 链根 id（补充协议归到主合同）。
 *
 * 清单量在数据集层已按链根聚合，结算量若仍按 `contractId` 归集，
 * 「主合同挂清单、补充协议挂结算」这种最常见形态就会永远比不出来（清单项级超结静默漏报）。
 */
function makeRootResolver(contracts: ContractRow[]): (id: string | null | undefined) => string | null {
  const byId = new Map<string, ContractRow>();
  for (const c of contracts) byId.set(c.id, c);
  const memo = new Map<string, string | null>();
  return (id) => {
    if (!id) return null;
    if (memo.has(id)) return memo.get(id)!;
    let cur: ContractRow | undefined = byId.get(id);
    if (!cur) {
      memo.set(id, null);
      return null;
    }
    const seen = new Set<string>([id]);
    while (cur.parentContractId) {
      const parent: ContractRow | undefined = byId.get(cur.parentContractId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      cur = parent;
    }
    memo.set(id, cur.id);
    return cur.id;
  };
}

/** 规则清单（文档/前端/自检共用；顺序即展示顺序） */
export const PAYMENT_RULE_IDS = [
  ANOMALY_CODES.R1_DUP_ACROSS_PERIOD,
  ANOMALY_CODES.R1_DUP_MATERIAL_QTY,
  ANOMALY_CODES.R1_FINAL_SNAPSHOT_DRIFT,
  ANOMALY_CODES.R2_OVERPAY,
  ANOMALY_CODES.R3_PAY_WITHOUT_CONTRACT,
  ANOMALY_CODES.R4_INVOICE_MISMATCH,
  ANOMALY_CODES.R5_SETTLE_BEFORE_RECEIPT,
  ANOMALY_CODES.R6_PROCEDURE_SNAPSHOT_DRIFT,
] as const;

/** 规则内部共享上下文：阈值 + 「没跑成的规则」收集器 */
interface RuleContext {
  tol: AnomalyTolerances;
  notEvaluated: string[];
}

// ---------------------------------------------------------------------------
// 通用小工具（全部纯函数）
// ---------------------------------------------------------------------------

/** 本地时区的 `YYYY-MM-DD`（与 `settlement-period.ts` 的本地口径一致，不要用 toISOString） */
function isoDay(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const dt = raw instanceof Date ? raw : new Date(raw as any);
  if (isNaN(dt.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/** 两个 `YYYY-MM-DD` 之间的整日差（`a - b`，纯日历计算，不受时区/夏令时影响） */
function dayDiff(a: string, b: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, (m || 1) - 1, d || 1);
  };
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** 集合重合度 |A∩B| / |A∪B|；任一为空 → 0（空集不算「重合」） */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const v of a) if (b.has(v)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function absBig(n: bigint): bigint {
  return n < 0n ? -n : n;
}

/**
 * 结算单金额：`actualAmount` 回退 `amount`。
 * 与 `contract-chain.chainSettledTotal`、`settlement.service` 的累计口径逐字一致——
 * 两处口径不同会让「面板说超付、列表说没超」这种最难解释的 bug 出现。
 */
function settledCents(row: SettlementRow): Cents | null {
  return moneyToCents(row.actualAmount ?? row.amount);
}

/** 只有**明确** `DRAFT` 的结算单不计入累计（`null` 计入，与 `notDraft` 同口径） */
function isCountedSettlement(row: SettlementRow): boolean {
  return row.statusCode !== SETTLEMENT_STATUS.DRAFT;
}

/** 失败/已退款的付款不计入累计（`null`/未填计入，与 `paidPaymentWhere()` 同口径） */
function isCountedPayment(row: PaymentRow): boolean {
  return !PAYMENT_EXCLUDED_STATUSES.includes(row.statusCode as any);
}

/** 作废/红冲发票不参与票款比较 */
function isCountedInvoice(row: InvoiceRow): boolean {
  return row.statusCode !== INVOICE_STATUS.CANCELLED && row.statusCode !== INVOICE_STATUS.RED;
}

/** 合同是否处于「可以付款」的状态（已签章；兼容历史 `COMPLETED` 旧行） */
function isPayableContract(row: ContractRow | undefined): boolean {
  if (!row) return false;
  return row.status === CONTRACT_STATUS.SIGNED || row.status === LEGACY_CONTRACT_STATUS_COMPLETED;
}

function pushSkip(ctx: RuleContext, message: string): void {
  if (!ctx.notEvaluated.includes(message)) ctx.notEvaluated.push(message);
}

/** 合同的可读标识（`code` 优先，其次 `name`，最后截断 ID） */
function contractLabel(row: ContractRow | undefined, fallbackId: string): string {
  if (!row) return `合同 ${fallbackId.slice(0, 8)}`;
  return row.code || row.name || `合同 ${fallbackId.slice(0, 8)}`;
}

/**
 * 按 id 取合同标签（R1-a / R1-b 的 `facts.合同` 用它）。
 *
 * 原来那两处传的是 `contractLabel(undefined, id)`，于是 facts 恒为「合同 3f9a1c2b」——
 * 财务拿到这条记录无法定位合同（编号就在入参里，白扔了）。
 */
function contractLabeler(contracts: ContractRow[]): (id: string) => string {
  const byId = new Map(contracts.map((c) => [c.id, c]));
  return (id) => contractLabel(byId.get(id), id);
}

// ---------------------------------------------------------------------------
// R1-a 跨期指纹重复
// ---------------------------------------------------------------------------

interface RuleResult {
  findings: Finding[];
}

/**
 * **R1-a 跨期指纹重复**：同合同两张结算单，金额相同（差 ≤ 容差）且明细物资集合重合度 ≥ 阈值。
 *
 * 判定只看「金额 + 明细指纹」，不看月份：同月重复在库里已被唯一约束挡住，
 * 真出问题时月份恰恰是**不同**的（同一批活下个月又结了一次）。
 * 等级固定 HIGH：这类命中一旦成立，业务后果是直接多付钱。
 */
export function r1aDuplicateAcrossPeriod(
  settlements: SettlementRow[],
  ctx: RuleContext,
  contracts: ContractRow[] = [],
): RuleResult {
  const findings: Finding[] = [];
  const label = contractLabeler(contracts);
  const counted = settlements.filter((s) => isCountedSettlement(s) && (s.items?.length ?? 0) > 0);
  const byContract = groupBy(counted, (s) => s.contractId ?? '');

  for (const [contractId, list] of byContract) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const ca = settledCents(a);
        const cb = settledCents(b);
        if (ca === null || cb === null) continue;
        const gap = absBig(ca - cb);
        if (gap > ctx.tol.amount) continue;

        const setA = new Set((a.items ?? []).map((it) => it.materialBaseId));
        const setB = new Set((b.items ?? []).map((it) => it.materialBaseId));
        const overlap = jaccard(setA, setB);
        if (overlap < ctx.tol.jaccard) continue;

        const monthA = monthKey(a.settleDate);
        const monthB = monthKey(b.settleDate);
        findings.push({
          code: ANOMALY_CODES.R1_DUP_ACROSS_PERIOD,
          level: ANOMALY_LEVEL.HIGH,
          entity: 'settlement',
          // 报「后一张」：核查动作发生在最新单据上（它才是可以撤回/冲销的那张）
          entityId: b.id,
          title: `结算单 ${b.code || b.id.slice(0, 8)} 与 ${a.code || a.id.slice(0, 8)} 金额相同且物资明细高度重合`,
          facts: {
            合同: label(contractId),
            结算单A: a.code || a.id.slice(0, 8),
            结算月份A: monthA ?? '未填',
            金额A: centsToYuan(ca),
            结算单B: b.code || b.id.slice(0, 8),
            结算月份B: monthB ?? '未填',
            金额B: centsToYuan(cb),
            金额差额: centsToYuan(gap),
            明细重合度: `${Math.round(overlap * 100)}%`,
            重合物资数: String([...setA].filter((v) => setB.has(v)).length),
            涉及物资数: String(new Set([...setA, ...setB]).size),
          },
          amountDiff: centsToYuan(gap),
        });
      }
    }
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// R1-b 同物资跨单重复计量
// ---------------------------------------------------------------------------

/**
 * **R1-b 同一物资重复计量**：某物资在合同内**跨结算单累计**的结算量 > 合同链清单量 ×(1+容差%)。
 *
 * 单张结算单可能都被「防超结量」挡住了（`checkOverSettlementQty` 每次只校验本单），
 * 但两张单子各取 60% 就会合计 120%——这是清单项级结算上线后最现实的漏洞。
 * 没有清单量口径（链上没清单）时该物资**不判**，并记入 `notEvaluated`。
 */
export function r1bDuplicateMaterialQty(
  settlements: SettlementRow[],
  materials: MaterialQtyRow[] | undefined,
  ctx: RuleContext,
  contracts: ContractRow[] = [],
): RuleResult {
  const findings: Finding[] = [];
  if (!materials?.length) {
    pushSkip(ctx, 'R1-b 未执行：项目内没有合同清单量（ContractMaterial）可供对比');
    return { findings };
  }

  // 合同链清单量（调用方已按链根聚合好；一物资可为多行，求和）
  const chainQty = new Map<string, { units: bigint; name: string | null }>();
  for (const row of materials) {
    if (!row.contractId || !row.materialBaseId) continue;
    const units = qtyToUnits(row.qty);
    if (units === null || units <= 0n) continue;
    const key = `${row.contractId}::${row.materialBaseId}`;
    const prev = chainQty.get(key);
    if (prev) prev.units += units;
    else chainQty.set(key, { units, name: row.name ?? null });
  }
  if (!chainQty.size) {
    pushSkip(ctx, 'R1-b 未执行：合同清单量为空或全为 0');
    return { findings };
  }

  // 结算量必须折到链根再比：清单量（上游）就是按链根聚合的
  const rootOf = makeRootResolver(contracts);
  const label = contractLabeler(contracts);
  const settledQty = new Map<string, bigint>();
  for (const s of settlements) {
    if (!s.contractId || !isCountedSettlement(s)) continue;
    const rootId = rootOf(s.contractId) ?? s.contractId;
    for (const it of s.items ?? []) {
      if (!it.materialBaseId) continue;
      const units = qtyToUnits(it.qty);
      if (units === null) continue;
      const key = `${rootId}::${it.materialBaseId}`;
      settledQty.set(key, (settledQty.get(key) ?? 0n) + units);
    }
  }

  // 阈值用整数百分数运算，避免浮点：上限 = qty × (100 + pct) / 100
  const pctSteps = BigInt(Math.round(ctx.tol.qtyPct));
  for (const [key, chain] of chainQty) {
    const got = settledQty.get(key);
    if (!got) continue;
    const limit = (chain.units * (100n + pctSteps)) / 100n;
    if (got <= limit) continue;
    const [contractId, materialBaseId] = key.split('::');
    const overPct = chain.units > 0n ? Number(((got - chain.units) * 10_000n) / chain.units) / 100 : 0;
    findings.push({
      code: ANOMALY_CODES.R1_DUP_MATERIAL_QTY,
      level: ANOMALY_LEVEL.MEDIUM,
      entity: 'contract',
      entityId: contractId,
      title: `物资 ${chain.name || materialBaseId.slice(0, 8)} 累计结算量超出合同清单量 ${overPct.toFixed(1)}%`,
      facts: {
        合同: label(contractId),
        物资: chain.name || `物资 ${materialBaseId.slice(0, 8)}`,
        合同链清单量: unitsToQty(chain.units),
        累计已结量: unitsToQty(got),
        超出量: unitsToQty(got - chain.units),
        超出比例: `${overPct.toFixed(1)}%`,
        容差: `${ctx.tol.qtyPct}%`,
      },
      amountDiff: null,
    });
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// R1-c 总结算快照偏离
// ---------------------------------------------------------------------------

/**
 * **R1-c 总结算快照偏离**：总结算单明细行的金额 ≠ 它引用的月度结算单当前金额。
 *
 * 原因只有两种：月度结算被改过而总结算没重抓；或引用的结算单已不存在。
 * 两种都要人看——总结算单是最终对外/对账凭证，它和台账不一致就是账不对。
 */
export function r1cFinalSnapshotDrift(
  items: FinalSettlementItemRow[] | undefined,
  settlements: SettlementRow[],
  ctx: RuleContext,
): RuleResult {
  const findings: Finding[] = [];
  if (!items?.length) return { findings };
  const byId = new Map(settlements.map((s) => [s.id, s]));
  // 引用到的结算单不在本次取数范围内：**不能断言「不在本项目中」**
  // （可能是结算日在区间外、属于其它合同、或确实已删除），逐条报会变成大面积误报
  let outOfScope = 0;

  for (const item of items) {
    const snapshot = moneyToCents(item.amount);
    if (snapshot === null) continue;
    const month = item.settleMonth || '未填';
    if (!item.settlementId) {
      findings.push({
        code: ANOMALY_CODES.R1_FINAL_SNAPSHOT_DRIFT,
        level: ANOMALY_LEVEL.MEDIUM,
        entity: 'settlement',
        entityId: item.finalSettlementId,
        title: `总结算单明细（${month}）未关联月度结算单`,
        facts: {
          总结算单: item.finalSettlementId.slice(0, 8),
          结算月份: month,
          明细金额: centsToYuan(snapshot),
        },
        amountDiff: null,
      });
      continue;
    }
    const target = byId.get(item.settlementId);
    if (!target) {
      // 只计数，末尾汇总一条 notEvaluated（逐条报会刷屏，且断言「不在本项目中」是错的）
      outOfScope += 1;
      continue;
    }
    const current = settledCents(target);
    if (current === null) continue;
    const gap = absBig(snapshot - current);
    if (gap <= ctx.tol.amount) continue;
    findings.push({
      code: ANOMALY_CODES.R1_FINAL_SNAPSHOT_DRIFT,
      level: ANOMALY_LEVEL.MEDIUM,
      entity: 'settlement',
      entityId: target.id,
      title: `总结算单明细金额与结算单 ${target.code || target.id.slice(0, 8)} 当前金额不一致`,
      facts: {
        总结算单: item.finalSettlementId.slice(0, 8),
        结算单: target.code || target.id.slice(0, 8),
        结算月份: month,
        总结算明细金额: centsToYuan(snapshot),
        结算单当前金额: centsToYuan(current),
        差额: centsToYuan(gap),
      },
      amountDiff: centsToYuan(gap),
    });
  }
  if (outOfScope) {
    pushSkip(
      ctx,
      `R1-c 未判定 ${outOfScope} 条总结算明细：其引用的月度结算单不在本次取数范围内（可能是结算日在区间外、属于其它合同或已删除），不能据此断言「不在本项目」`,
    );
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// R2 超付
// ---------------------------------------------------------------------------

/**
 * 按**链根**累计结算额。
 *
 * 为什么按链根（2026-10-23 审计 P1）：付款上限是「整条链」的口径（`contract-chain.ts`：
 * 当前金额 = 母合同 + 补充协议增量，`amount-guard` 也按链判）。若按签约主体各自聚合，
 * 「结算记在母合同、付款记在补充协议」这种常见组合会让补充协议的分母变 0，
 * 于是 1 万元以内的正常付款也被报成「超出上限 100%」的高风险超付。
 */
function sumSettledByChainRoot(rows: SettlementRow[], rootOf: (id: string) => string | null): Map<string, Cents> {
  const map = new Map<string, Cents>();
  for (const row of rows) {
    if (!row.contractId || !isCountedSettlement(row)) continue;
    const cents = settledCents(row);
    if (cents === null) continue;
    const root = rootOf(row.contractId) ?? row.contractId;
    map.set(root, (map.get(root) ?? 0n) + cents);
  }
  return map;
}

/** 链上有「计入口径但推不出金额」的结算单（链根集合） */
function chainRootsWithUnusableSettlement(rows: SettlementRow[], rootOf: (id: string) => string | null): Set<string> {
  const set = new Set<string>();
  for (const row of rows) {
    if (!row.contractId || !isCountedSettlement(row)) continue;
    if (settledCents(row) !== null) continue;
    set.add(rootOf(row.contractId) ?? row.contractId);
  }
  return set;
}

/** 按**链根**累计付款额（排除失败/已退款；`null` 状态计入，与 `paidPaymentWhere()` 同口径） */
function sumPaidByChainRoot(rows: PaymentRow[], rootOf: (id: string) => string | null): Map<string, Cents> {
  const map = new Map<string, Cents>();
  for (const row of rows) {
    if (!row.contractId || !isCountedPayment(row)) continue;
    const cents = moneyToCents(row.amount);
    if (cents === null) continue;
    const root = rootOf(row.contractId) ?? row.contractId;
    map.set(root, (map.get(root) ?? 0n) + cents);
  }
  return map;
}

/**
 * **R2 超付**：累计付款 > 累计结算 × 生效付款比例。
 *
 * 付款比例取 `ContractExt.currentPayRatio`（派生值：有生效比例变更取变更值，否则取原比例）。
 * **比例推不出来时整条不判**并记入 `notEvaluated`——按 100% 兜底会把「按 80% 付款」的正常
 * 业务全变成高风险，那是最糟的误报（业务会立刻关掉这个面板）。
 * 比例口径出处：`.claude/rules/backend-conventions.md`（付款比例派生与同步）。
 * 容差：应付上限按比例**向下取整**（到分），再把 `tol.amount`（默认 1 元）内的差额算作分位噪声
 * —— 与 `amount-guard`「恰好等于上限不算超」同一口径，避免四舍五入被报成超付。
 */
export function r2Overpay(input: PaymentAnomalyInput, ctx: RuleContext): RuleResult {
  const findings: Finding[] = [];
  const contracts = new Map(input.contracts.map((c) => [c.id, c]));
  const rootOf = makeRootResolver(input.contracts);
  // 累计口径：区间之前的历史结算必须看见，否则「区间内结算 / 全时段付款」必互相打架
  const cumulative = input.cumulativeSettlements?.length ? input.cumulativeSettlements : input.settlements;
  const settled = sumSettledByChainRoot(cumulative, rootOf);
  const paid = sumPaidByChainRoot(input.payments, rootOf);
  const unusable = chainRootsWithUnusableSettlement(cumulative, rootOf);
  // 付款比例也是**整链口径**：分子分母都按链根累计了，比例却只取链根那一条合同，
  // 一旦补充协议的比例与母合同不同（常见：母合同已完已结 100%、补充协议还在 80%），
  // 上限就会算成一个两边都不成立的值。这里先把链内各家比例收集起来：
  // 唯一才用，多于一个整链不判（宁可「未判定」也不给假上限）。
  const bpsByRoot = new Map<string, Set<number>>();
  for (const c of input.contracts) {
    const root = rootOf(c.id) ?? c.id;
    const bp = ratioToBp(c.currentPayRatio);
    if (bp === null) continue;
    const set = bpsByRoot.get(root) ?? new Set<number>();
    set.add(bp);
    bpsByRoot.set(root, set);
  }

  for (const [rootId, paidCents] of paid) {
    const contract = contracts.get(rootId);
    // 合同缺失/未签章的付款由 R3 报，这里不重复
    if (!contract) continue;
    // 链上有任何一张结算单推不出金额时**整条链不判**：把缺失的金额当 0 会让分母偏小，
    // 于是「单据没填金额」被报成「超付」，真正原因反被藏起来
    // （2026-10-23 审计 P2：原来只在「一张都推不出」时才跳过，混合情形仍会误报）
    if (unusable.has(rootId)) {
      pushSkip(ctx, `R2 未判定：${contractLabel(contract, rootId)} 的结算单没有金额（amount/actualAmount 均为空），累计结算额不可用`);
      continue;
    }
    const settledCentsTotal = settled.get(rootId) ?? 0n;
    // 没有任何已结算金额时，「付款 > 结算×比例」恒成立（预付款场景），判超付是纯噪音
    if (settledCentsTotal === 0n) {
      pushSkip(ctx, `R2 未判定：${contractLabel(contract, rootId)} 尚无已结算金额（预付款无法据比例判定是否超付）`);
      continue;
    }
    const bps = bpsByRoot.get(rootId);
    if (!bps || bps.size === 0) {
      pushSkip(
        ctx,
        `R2 未判定：${contractLabel(contract, rootId)} 没有可用的付款比例（当前比例为空或不在 0~1）`,
      );
      continue;
    }
    if (bps.size > 1) {
      const shown = [...bps].map((v) => `${(v / 100).toFixed(2)}%`).join(' / ');
      pushSkip(
        ctx,
        `R2 未判定：${contractLabel(contract, rootId)} 的母合同与补充协议付款比例不一致（${shown}），整链上限没有唯一值`,
      );
      continue;
    }
    const bp = [...bps][0];
    const limit = (settledCentsTotal * BigInt(bp)) / 10_000n;
    if (paidCents <= limit + ctx.tol.amount) continue;
    const over = paidCents - limit;
    findings.push({
      code: ANOMALY_CODES.R2_OVERPAY,
      level: ANOMALY_LEVEL.HIGH,
      entity: 'contract',
      entityId: rootId,
      title: `${contractLabel(contract, rootId)} 累计付款超出生效付款比例上限`,
      facts: {
        合同: contractLabel(contract, rootId),
        口径: '母合同与补充协议合计（整链）',
        累计结算金额: centsToYuan(settledCentsTotal),
        付款比例: `${(bp / 100).toFixed(2)}%`,
        应付上限: centsToYuan(limit),
        累计已付: centsToYuan(paidCents),
        超出金额: centsToYuan(over),
        容差: centsToYuan(ctx.tol.amount),
      },
      amountDiff: centsToYuan(over),
    });
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// R3 无效合同付款
// ---------------------------------------------------------------------------

/**
 * **R3 付款缺少有效合同**：付款记录没有 `contractId`、合同不在本项目中、或合同尚未签章。
 *
 * 这是资金流出端最基本的控制点，也是数据质量问题的第一现场（导入的历史付款常缺合同）。
 */
export function r3PayWithoutContract(input: PaymentAnomalyInput, ctx: RuleContext): RuleResult {
  const findings: Finding[] = [];
  const contracts = new Map(input.contracts.map((c) => [c.id, c]));

  const from = input.window?.from ?? null;
  for (const payment of input.payments) {
    if (!isCountedPayment(payment)) continue;
    // 付款取数只设上界（累计口径）；明细类判定要守住区间下界，
    // 否则「上月已处理过的无合同付款」每次查询都会再报一遍
    if (from && payment.payDate && isoDay(payment.payDate) && isoDay(payment.payDate)! < from) continue;
    if (from && !payment.payDate && payment.payMonth && payment.payMonth < from.slice(0, 7)) continue;
    const amount = moneyToCents(payment.amount);
    const label = payment.payDate ? isoDay(payment.payDate) ?? '未填' : payment.payMonth ?? '未填';
    const baseFacts: Record<string, string> = {
      付款记录: payment.id.slice(0, 8),
      付款日期: label ?? '未填',
      付款金额: amount === null ? '未填' : centsToYuan(amount),
    };
    if (!payment.contractId) {
      findings.push({
        code: ANOMALY_CODES.R3_PAY_WITHOUT_CONTRACT,
        level: ANOMALY_LEVEL.HIGH,
        entity: 'payment',
        entityId: payment.id,
        title: `付款记录 ${payment.id.slice(0, 8)} 未关联任何合同`,
        facts: baseFacts,
        amountDiff: null,
      });
      continue;
    }
    const contract = contracts.get(payment.contractId);
    if (!contract) {
      findings.push({
        code: ANOMALY_CODES.R3_PAY_WITHOUT_CONTRACT,
        level: ANOMALY_LEVEL.MEDIUM,
        entity: 'payment',
        entityId: payment.id,
        title: `付款记录 ${payment.id.slice(0, 8)} 关联的合同不在本项目中`,
        facts: { ...baseFacts, 合同ID: payment.contractId.slice(0, 8) },
        amountDiff: null,
      });
      continue;
    }
    if (!isPayableContract(contract)) {
      findings.push({
        code: ANOMALY_CODES.R3_PAY_WITHOUT_CONTRACT,
        level: ANOMALY_LEVEL.MEDIUM,
        entity: 'payment',
        entityId: payment.id,
        title: `${contractLabel(contract, payment.contractId)} 未签章即有付款记录`,
        facts: { ...baseFacts, 合同: contractLabel(contract, payment.contractId), 合同状态: contract.status || '未填' },
        amountDiff: null,
      });
    }
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// R4 票款不一致
// ---------------------------------------------------------------------------

/**
 * **R4 发票金额与结算金额不一致**：同一结算单的有效发票合计（含税）≠ 结算金额。
 *
 * 一张结算单可对应多张发票（业务口径 2026-10-16），所以按组合计比较；
 * 作废/红冲发票不参与（红冲本身另有一套账务处理）。
 */
export function r4InvoiceMismatch(input: PaymentAnomalyInput, ctx: RuleContext): RuleResult {
  const findings: Finding[] = [];
  // 发票可能指向区间之前的结算单：用累计口径查得到，就不会被误报成「跨项目数据串了」
  const cumulative = input.cumulativeSettlements?.length ? input.cumulativeSettlements : input.settlements;
  const settlements = new Map(cumulative.filter(isCountedSettlement).map((s) => [s.id, s]));
  const bySettlement = groupBy(
    input.invoices.filter((i) => isCountedInvoice(i) && i.settlementId),
    (i) => i.settlementId as string,
  );

  // 「找不到」有三种完全不同的原因，**必须分开说**：草稿结算 / 不属于本项目 / 没有。
  // 原来一律写「在本项目内找不到（或为草稿）」，而集合已被区间裁剪过，
  // 于是「日期在区间外」也被诊断成「跨项目数据串了」，还按发票张数刷出一串条目。
  const draftSettlementIds = new Set(
    (input.cumulativeSettlements ?? []).filter((s) => !isCountedSettlement(s)).map((s) => s.id),
  );
  let draftSkipped = 0;
  let absentSkipped = 0;

  for (const [settlementId, invoices] of bySettlement) {
    const settlement = settlements.get(settlementId);
    if (!settlement) {
      if (draftSettlementIds.has(settlementId)) draftSkipped += invoices.length;
      else absentSkipped += invoices.length;
      continue;
    }
    const expected = settledCents(settlement);
    if (expected === null) continue;
    let invoiced = 0n;
    let missing = 0;
    for (const inv of invoices) {
      const cents = moneyToCents(inv.amountWithTax);
      if (cents === null) missing++;
      else invoiced += cents;
    }
    if (missing) {
      pushSkip(ctx, `R4 部分未判定：结算单 ${settlement.code || settlementId.slice(0, 8)} 有 ${missing} 张发票未填含税金额`);
    }
    const gap = absBig(invoiced - expected);
    if (gap <= ctx.tol.amount) continue;
    findings.push({
      code: ANOMALY_CODES.R4_INVOICE_MISMATCH,
      level: ANOMALY_LEVEL.MEDIUM,
      entity: 'settlement',
      entityId: settlementId,
      title: `结算单 ${settlement.code || settlementId.slice(0, 8)} 的发票合计与结算金额相差 ${centsToYuan(gap)} 元`,
      facts: {
        结算单: settlement.code || settlementId.slice(0, 8),
        结算金额: centsToYuan(expected),
        发票合计: centsToYuan(invoiced),
        发票张数: String(invoices.length),
        差额: centsToYuan(gap),
        容差: centsToYuan(ctx.tol.amount),
      },
      amountDiff: centsToYuan(gap),
    });
  }
  if (draftSkipped > 0) {
    pushSkip(ctx, `R4 未覆盖 ${draftSkipped} 张发票：其结算单仍是草稿（草稿不参与票款比对）`);
  }
  if (absentSkipped > 0) {
    pushSkip(ctx, `R4 未判定 ${absentSkipped} 张发票：其结算单不在本项目已加载的结算单里（可能已删除或属于其它项目）`);
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// R5 结算早于收领单
// ---------------------------------------------------------------------------

/**
 * **R5 结算早于收领单日期**：结算日期早于它关联的任一收领单日期。
 *
 * 逻辑上是硬伤：没收到货就先结算。现实中多是「结算单日期手工填早了」，
 * 但它同时会让月度归集、成本归属整体错一个月，所以必须报。
 */
export function r5SettleBeforeReceipt(input: PaymentAnomalyInput, ctx: RuleContext): RuleResult {
  const findings: Finding[] = [];
  const settlements = new Map(
    input.settlements.filter(isCountedSettlement).map((s) => [s.id, s]),
  );
  const bySettlement = groupBy(
    (input.receipts ?? []).filter((r) => r.settlementId),
    (r) => r.settlementId as string,
  );

  for (const [settlementId, receipts] of bySettlement) {
    const settlement = settlements.get(settlementId);
    if (!settlement) continue;
    const settleDay = isoDay(settlement.settleDate);
    if (!settleDay) {
      pushSkip(ctx, `R5 未判定：结算单 ${settlement.code || settlementId.slice(0, 8)} 没有结算日期`);
      continue;
    }
    const receiptDays = receipts.map((r) => isoDay(r.orderDate)).filter((d): d is string => !!d);
    if (!receiptDays.length) continue;
    const earliest = receiptDays.reduce((min, d) => (d < min ? d : min), receiptDays[0]);
    if (settleDay >= earliest) continue;
    findings.push({
      code: ANOMALY_CODES.R5_SETTLE_BEFORE_RECEIPT,
      level: ANOMALY_LEVEL.MEDIUM,
      entity: 'settlement',
      entityId: settlementId,
      title: `结算单 ${settlement.code || settlementId.slice(0, 8)} 的结算日期早于收领单日期 ${dayDiff(earliest, settleDay)} 天`,
      facts: {
        结算单: settlement.code || settlementId.slice(0, 8),
        结算日期: settleDay,
        最早收领单日期: earliest,
        相差天数: String(dayDiff(earliest, settleDay)),
        收领单张数: String(receipts.length),
      },
      amountDiff: null,
    });
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// R6 付款手续快照偏离
// ---------------------------------------------------------------------------

/**
 * **R6 付款手续开累快照与台账不一致**：手续单上记录的「开累结算 / 开累付款」
 * 与该付款日**当时的**实时累计对不上，说明该日之后有人补录/改动了结算或付款，
 * 而历史手续单（已签字的那张纸）没有回改。
 *
 * `PaymentProcedure` 没有审批时间字段，所以原设想的「审批晚于付款」不可判；
 * 这一条是同样业务含义、且**数据支持**的替代判定（见文件头）。
 */
export function r6ProcedureSnapshotDrift(input: PaymentAnomalyInput, ctx: RuleContext): RuleResult {
  const findings: Finding[] = [];
  const procedures: ProcedureRow[] = input.procedures ?? [];
  if (!procedures.length) {
    pushSkip(ctx, 'R6 未执行：项目内没有付款手续单');
    return { findings };
  }

  // 手续单上记的是**整条链**的开累（台账口径 = 母合同 + 补充协议），
  // 所以实时累计也必须按链根汇总，否则「手续开在母合同、付款记在补充协议」
  // 会被算成「实时付款 0，手续单多记了钱」的假偏离（2026-10-23 审计）
  const rootOf = makeRootResolver(input.contracts);
  const cumulative = input.cumulativeSettlements?.length ? input.cumulativeSettlements : input.settlements;
  const rootSettled = groupBy(
    cumulative.filter((s) => isCountedSettlement(s) && s.contractId),
    (s) => rootOf(s.contractId as string) ?? String(s.contractId),
  );
  const rootPaid = groupBy(
    input.payments.filter((p) => isCountedPayment(p) && p.contractId),
    (p) => rootOf(p.contractId as string) ?? String(p.contractId),
  );
  // 静默跳过要能说出来：金额全空 / 没有合同的手续单原来一句不提，面板会显示「全绿」
  let skippedNoAmount = 0;
  let skippedNoContract = 0;


  for (const procedure of procedures) {
    if (!procedure.contractId) {
      skippedNoContract += 1;
      continue;
    }
    const payDay = isoDay(procedure.payDate);
    if (!payDay) {
      pushSkip(ctx, `R6 未判定：手续单 ${procedure.code || procedure.id.slice(0, 8)} 没有付款日期`);
      continue;
    }
    const snapSettled = moneyToCents(procedure.settleCumAmount);
    const snapPaid = moneyToCents(procedure.paidCumAmount);
    if (snapSettled === null && snapPaid === null) {
      skippedNoAmount += 1;
      continue;
    }
    const rootId = rootOf(procedure.contractId) ?? String(procedure.contractId);

    let liveSettled = 0n;
    for (const s of rootSettled.get(rootId) ?? []) {
      const day = isoDay(s.settleDate);
      if (!day || day > payDay) continue;
      const cents = settledCents(s);
      if (cents !== null) liveSettled += cents;
    }
    let livePaid = 0n;
    for (const p of rootPaid.get(rootId) ?? []) {
      const day = isoDay(p.payDate);
      // 只有「账期」没有付款日的付款行：按账期月 ≤ 付款月 计入（口径从宽，避免误报）
      const inRange = day ? day <= payDay : !!p.payMonth && p.payMonth <= payDay.slice(0, 7);
      if (!inRange) continue;
      const cents = moneyToCents(p.amount);
      if (cents !== null) livePaid += cents;
    }

    const driftSettled = snapSettled === null ? 0n : liveSettled - snapSettled;
    const driftPaid = snapPaid === null ? 0n : livePaid - snapPaid;
    if (absBig(driftSettled) <= ctx.tol.amount && absBig(driftPaid) <= ctx.tol.amount) continue;

    const facts: Record<string, string> = {
      付款手续单: procedure.code || procedure.id.slice(0, 8),
      付款日期: payDay,
      // 一句话说清口径：手续单上记的是**整链开累**，与单合同台账对不上是正常的，
      // 不写这句用户拿到面板只能去对单合同（2026-10-23 复核 P3）
      口径: '母合同与补充协议合计（整链）',
      容差: centsToYuan(ctx.tol.amount),
    };
    if (snapSettled !== null) {
      facts.手续开累结算 = centsToYuan(snapSettled);
      facts.台账开累结算 = centsToYuan(liveSettled);
      facts.结算差额 = centsToYuan(driftSettled);
    }
    if (snapPaid !== null) {
      facts.手续开累付款 = centsToYuan(snapPaid);
      facts.台账开累付款 = centsToYuan(livePaid);
      facts.付款差额 = centsToYuan(driftPaid);
    }
    findings.push({
      code: ANOMALY_CODES.R6_PROCEDURE_SNAPSHOT_DRIFT,
      level: ANOMALY_LEVEL.MEDIUM,
      entity: 'procedure',
      entityId: procedure.id,
      title: `付款手续单 ${procedure.code || procedure.id.slice(0, 8)} 的开累金额与台账不一致`,
      facts,
      amountDiff: centsToYuan(absBig(driftPaid) >= absBig(driftSettled) ? driftPaid : driftSettled),
    });
  }
  if (skippedNoContract) {
    pushSkip(ctx, `R6 未判定 ${skippedNoContract} 张付款手续单：没有关联合同，无法按合同链核对开累`);
  }
  if (skippedNoAmount) {
    pushSkip(ctx, `R6 未判定 ${skippedNoAmount} 张付款手续单：手续上的开累金额（结算/付款）都是空值`);
  }
  return { findings };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<AnomalyLevel, number> = { HIGH: 0, MEDIUM: 1 };
const CODE_ORDER: Record<string, number> = Object.fromEntries(
  PAYMENT_RULE_IDS.map((code, index) => [code, index]),
);

/** 确定性排序：等级 → 规则码 → 对象 ID */
export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const byLevel = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
    if (byLevel !== 0) return byLevel;
    const byCode = (CODE_ORDER[a.code] ?? 99) - (CODE_ORDER[b.code] ?? 99);
    if (byCode !== 0) return byCode;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  });
}

export function summarizeFindings(findings: Finding[]): AnomalySummary {
  const summary: AnomalySummary = { total: findings.length, high: 0, medium: 0, byCode: {} };
  for (const finding of findings) {
    if (finding.level === ANOMALY_LEVEL.HIGH) summary.high++;
    else summary.medium++;
    summary.byCode[finding.code] = (summary.byCode[finding.code] ?? 0) + 1;
  }
  return summary;
}

/**
 * **8 条规则一次跑完**（纯函数，无 IO）。
 *
 * service 只负责按 `projectId` 取数 → 调这里 → 落通知/落缓存；任何判定逻辑都不许写在 service 里，
 * 否则口径会被复制到两处（本仓库最贵的历史教训：金额口径一旦分裂，修一次要动五个模块）。
 */
export function evaluatePaymentAnomalies(input: PaymentAnomalyInput): AnomalyEvaluation {
  const ctx: RuleContext = { tol: resolveTolerances(input.tolerances), notEvaluated: [] };
  // 累计口径：区间之前的单据是已发生的事实（见 PaymentAnomalyInput.cumulativeSettlements）
  const cumulative = input.cumulativeSettlements?.length ? input.cumulativeSettlements : input.settlements;
  const findings = [
    // 明细类：只看判定区间内的结算单，否则历史问题每月重复报
    ...r1aDuplicateAcrossPeriod(input.settlements, ctx, input.contracts).findings,
    // 累计类：清单量是合同全生命周期的上限，必须用累计结算量
    ...r1bDuplicateMaterialQty(cumulative, input.contractMaterials, ctx, input.contracts).findings,
    ...r1cFinalSnapshotDrift(input.finalSettlementItems, cumulative, ctx).findings,
    ...r2Overpay(input, ctx).findings,
    ...r3PayWithoutContract(input, ctx).findings,
    ...r4InvoiceMismatch(input, ctx).findings,
    ...r5SettleBeforeReceipt(input, ctx).findings,
    ...r6ProcedureSnapshotDrift(input, ctx).findings,
  ];
  const sorted = sortFindings(findings);
  return { findings: sorted, summary: summarizeFindings(sorted), notEvaluated: ctx.notEvaluated };
}

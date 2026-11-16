/**
 * AI 预警 · **合同履约偏差**（矩阵课题 4-9）—— 规则层（纯函数）。
 *
 * 与 `anomaly/rules-payment.ts`、`quote/rules-quote.ts` 同款：入参是已取好的行，
 * 出参是命中清单。**不 import Prisma、不做 IO、不读当前时间**（`now` 由上层注入），
 * 因此能被 `npm test` 裸跑并有真值夹具双向对锁。
 *
 * 口径约定：
 * - 节点状态取 `MILESTONE_STATUS`（PENDING / DONE / SKIPPED）；
 * - 「逾期」与页面标红同口径（`common/utils/milestone.ts`：未完成且计划日已过），
 *   本层再加**宽限期**，避免刚到期就报警；
 * - 天数全部按**本地日历日**差算（UTC 毫秒折算，绕开夏令时）；
 * - 合同金额用链式当前金额（主合同 + 带符号补充协议），不用 `amount` 裸值。
 */

import {
  FINAL_SETTLEMENT_STATUS,
  MILESTONE_STATUS,
  PAYMENT_EXCLUDED_STATUSES,
} from '../../../constants/statuses.ts';
import { resolveChainAmounts } from '../../../common/utils/contract-chain.ts';
import { moneyToCents, type Cents } from '../common/money.ts';
import {
  FULFILLMENT_CODES,
  FULFILLMENT_LEVEL,
  resolveFulfillmentTolerances,
  type FulfillmentContractRow,
  type FulfillmentFinding,
  type FulfillmentInput,
  type FulfillmentSummary,
  type FulfillmentTolerances,
  type MilestoneRow,
} from './fulfillment-types.ts';

/** 逾期 / 滞后的高风险门槛（天）：超过就升级为「必须马上看」 */
const HIGH_RISK_DAYS = 30;
/** 付款快于履约的高风险门槛（百分点） */
const HIGH_RISK_GAP_PCT = 50;

export interface FulfillmentRuleContext {
  /** 判定基准日（本地零点）；由 service 传 `new Date()`，单测传固定日期 */
  now: Date;
  tol: FulfillmentTolerances;
  /** 因数据缺失没跑成的规则，写进这里 → 响应里的 `notEvaluated` */
  notEvaluated: string[];
}

export interface FulfillmentEvaluation {
  findings: FulfillmentFinding[];
  summary: FulfillmentSummary;
  notEvaluated: string[];
}

/** 日历日序号（本地时区 → UTC 天序号），非法日期返回 null */
function dayIndex(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** b − a 的天数（均为日历日）；任一为空返回 null */
function daysBetween(a: Date | string | null | undefined, b: Date | string | null | undefined): number | null {
  const x = dayIndex(a);
  const y = dayIndex(b);
  if (x === null || y === null) return null;
  return y - x;
}

const dayText = (v: Date | string | null | undefined): string => {
  const i = dayIndex(v);
  if (i === null) return '未填';
  const d = new Date(i * 86_400_000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
};

const isDone = (m: MilestoneRow) => m.statusCode === MILESTONE_STATUS.DONE;
const isSkipped = (m: MilestoneRow) => m.statusCode === MILESTONE_STATUS.SKIPPED;
/** 「还没完成」：既不是 DONE 也不是 SKIPPED（null 视为未完成，与页面一致） */
const isOpen = (m: MilestoneRow) => !isDone(m) && !isSkipped(m);

const isCountedPayment = (p: { statusCode?: string | null }) =>
  !PAYMENT_EXCLUDED_STATUSES.includes(String(p.statusCode ?? ''));

function contractLabel(c: FulfillmentContractRow | undefined): { code: string; name: string } {
  return { code: String(c?.code ?? ''), name: String(c?.name ?? '') };
}

function push(
  out: FulfillmentFinding[],
  finding: Omit<FulfillmentFinding, 'contractCode' | 'contractName'> & { contractCode?: string; contractName?: string },
) {
  out.push({
    ...finding,
    contractCode: finding.contractCode ?? '',
    contractName: finding.contractName ?? '',
  });
}

/**
 * C1 节点逾期未完成。
 *
 * 口径与页面标红一致（未完成 + 计划日已过），但**再减宽限期**：
 * 计划日期过了 `graceDays` 天还没完成才报。逾期 > 30 天升为高风险。
 */
export function c1Overdue(
  milestones: MilestoneRow[],
  contracts: Map<string, FulfillmentContractRow>,
  ctx: FulfillmentRuleContext,
): FulfillmentFinding[] {
  const out: FulfillmentFinding[] = [];
  for (const m of milestones) {
    if (!isOpen(m)) continue;
    const overdue = daysBetween(m.planDate, ctx.now);
    if (overdue === null || overdue <= ctx.tol.graceDays) continue;
    const c = contracts.get(m.contractId);
    const { code, name } = contractLabel(c);
    push(out, {
      code: FULFILLMENT_CODES.C1_OVERDUE,
      level: overdue > HIGH_RISK_DAYS ? FULFILLMENT_LEVEL.HIGH : FULFILLMENT_LEVEL.MEDIUM,
      entity: 'milestone',
      entityId: m.id,
      contractId: m.contractId,
      contractCode: code,
      contractName: name,
      title: `节点「${m.name ?? '(未命名)'}」已逾期 ${overdue} 天仍未完成`,
      facts: [
        `合同：${code}${name ? ` ${name}` : ''}`,
        `节点：${m.name ?? '(未命名)'}`,
        `计划日期：${dayText(m.planDate)}`,
        `实际日期：${dayText(m.actualDate)}`,
        `逾期天数：${overdue} 天（宽限 ${ctx.tol.graceDays} 天）`,
        `节点状态：${m.statusCode ?? '未设置'}`,
        `责任人：${m.owner || '未填'}`,
      ],
      amountDiff: null,
    });
  }
  return out;
}

/** C2 已完成但没填实际日期（进度不可追溯，也影响所有「是否按期」的判断） */
export function c2DoneNoActual(
  milestones: MilestoneRow[],
  contracts: Map<string, FulfillmentContractRow>,
): FulfillmentFinding[] {
  const out: FulfillmentFinding[] = [];
  for (const m of milestones) {
    if (!isDone(m) || m.actualDate) continue;
    const { code, name } = contractLabel(contracts.get(m.contractId));
    push(out, {
      code: FULFILLMENT_CODES.C2_DONE_NO_ACTUAL,
      level: FULFILLMENT_LEVEL.MEDIUM,
      entity: 'milestone',
      entityId: m.id,
      contractId: m.contractId,
      contractCode: code,
      contractName: name,
      title: `节点「${m.name ?? '(未命名)'}」标记完成但没有实际日期`,
      facts: [
        `合同：${code}${name ? ` ${name}` : ''}`,
        `节点：${m.name ?? '(未命名)'}`,
        `计划日期：${dayText(m.planDate)}`,
        '实际日期：未填',
        '节点状态：已完成',
        `责任人：${m.owner || '未填'}`,
      ],
      amountDiff: null,
    });
  }
  return out;
}

/**
 * C3 顺序倒挂：更早的计划节点还没完成，更晚的计划节点却已完成。
 *
 * 这是「补录进度」时最常见的错误形态——如果两头的实际日期对不上，
 * 后面所有基于进度的话都不成立。每个未完成节点只报一次（取**最早的那个已完成后继**做对照）。
 */
export function c3SequenceInverted(
  milestones: MilestoneRow[],
  contracts: Map<string, FulfillmentContractRow>,
): FulfillmentFinding[] {
  const out: FulfillmentFinding[] = [];
  const byContract = new Map<string, MilestoneRow[]>();
  for (const m of milestones) {
    if (dayIndex(m.planDate) === null) continue;
    const list = byContract.get(m.contractId) ?? [];
    list.push(m);
    byContract.set(m.contractId, list);
  }
  for (const [contractId, rows] of byContract) {
    const sorted = rows
      .slice()
      .sort((a, b) => (dayIndex(a.planDate) as number) - (dayIndex(b.planDate) as number));
    for (let i = 0; i < sorted.length; i += 1) {
      const cur = sorted[i];
      if (!isOpen(cur)) continue;
      const curDay = dayIndex(cur.planDate) as number;
      // **同日节点不算「后继」**：同一天并行的多个节点（如「到货」与「初验」）
      // 谁先完成都对，按数组顺序取「后面的」就会把并行节点误判成顺序倒挂。
      const later = sorted
        .slice(i + 1)
        .find((x) => isDone(x) && (dayIndex(x.planDate) as number) > curDay);
      if (!later) continue;
      const { code, name } = contractLabel(contracts.get(contractId));
      push(out, {
        code: FULFILLMENT_CODES.C3_SEQUENCE_INVERTED,
        level: FULFILLMENT_LEVEL.MEDIUM,
        entity: 'milestone',
        entityId: cur.id,
        contractId,
        contractCode: code,
        contractName: name,
        title: `节点「${cur.name ?? '(未命名)'}」未完成，但后续节点「${later.name ?? '(未命名)'}」已完成`,
        facts: [
          `合同：${code}${name ? ` ${name}` : ''}`,
          `未完成节点：${cur.name ?? '(未命名)'}（计划 ${dayText(cur.planDate)}，状态 ${cur.statusCode ?? '未设置'}）`,
          `已完成节点：${later.name ?? '(未命名)'}（计划 ${dayText(later.planDate)}，实际 ${dayText(later.actualDate)}）`,
          '口径：按计划日期排序，前序未完成而后序已完成',
        ],
        amountDiff: null,
      });
    }
  }
  return out;
}

/** C4 完成滞后：实际完成日期晚于计划超过 `lateFinishDays` 天 */
export function c4FinishLate(
  milestones: MilestoneRow[],
  contracts: Map<string, FulfillmentContractRow>,
  ctx: FulfillmentRuleContext,
): FulfillmentFinding[] {
  const out: FulfillmentFinding[] = [];
  for (const m of milestones) {
    if (!isDone(m) || !m.actualDate) continue;
    const late = daysBetween(m.planDate, m.actualDate);
    if (late === null || late <= ctx.tol.lateFinishDays) continue;
    const { code, name } = contractLabel(contracts.get(m.contractId));
    push(out, {
      code: FULFILLMENT_CODES.C4_FINISH_LATE,
      level: late > HIGH_RISK_DAYS ? FULFILLMENT_LEVEL.HIGH : FULFILLMENT_LEVEL.MEDIUM,
      entity: 'milestone',
      entityId: m.id,
      contractId: m.contractId,
      contractCode: code,
      contractName: name,
      title: `节点「${m.name ?? '(未命名)'}」实际完成比计划晚 ${late} 天`,
      facts: [
        `合同：${code}${name ? ` ${name}` : ''}`,
        `节点：${m.name ?? '(未命名)'}`,
        `计划日期：${dayText(m.planDate)}`,
        `实际日期：${dayText(m.actualDate)}`,
        `滞后天数：${late} 天（容忍 ${ctx.tol.lateFinishDays} 天）`,
      ],
      amountDiff: null,
    });
  }
  return out;
}

/**
 * C5 计划日期早于合同签订日期。
 *
 * 计划早于签订不一定是错（框架协议、事后补签都常见），但**必须复核**：
 * 一旦计划轴起点错了，后面所有「逾期多少天」都是错的。
 */
export function c5PlanBeforeSign(
  milestones: MilestoneRow[],
  contracts: Map<string, FulfillmentContractRow>,
): FulfillmentFinding[] {
  const out: FulfillmentFinding[] = [];
  for (const m of milestones) {
    const c = contracts.get(m.contractId);
    const signDay = c?.signedDate ?? c?.signDate;
    const early = daysBetween(signDay, m.planDate);
    if (early === null || early >= 0) continue;
    const { code, name } = contractLabel(c);
    push(out, {
      code: FULFILLMENT_CODES.C5_PLAN_BEFORE_SIGN,
      level: FULFILLMENT_LEVEL.MEDIUM,
      entity: 'milestone',
      entityId: m.id,
      contractId: m.contractId,
      contractCode: code,
      contractName: name,
      title: `节点「${m.name ?? '(未命名)'}」计划日期早于合同签订 ${Math.abs(early)} 天`,
      facts: [
        `合同：${code}${name ? ` ${name}` : ''}`,
        `合同签订日期：${dayText(signDay)}`,
        `节点计划日期：${dayText(m.planDate)}`,
        `提前天数：${Math.abs(early)} 天`,
      ],
      amountDiff: null,
    });
  }
  return out;
}

/**
 * C6 付款快于履约：累计付款占合同当前金额的比例，明显高于节点完成率。
 *
 * 「节点完成率」= 已完成节点 ÷（已完成 + 未完成），跳过 SKIPPED。
 * 差额 ≥ `progressGapPct` 个百分点才报；≥ 50 个百分点为高风险。
 * 缺数据（没有节点 / 合同金额为 0 或未填）不猜：写入 `notEvaluated` 或直接跳过。
 */
export function c6ProgressPaymentGap(input: FulfillmentInput, ctx: FulfillmentRuleContext): FulfillmentFinding[] {
  const out: FulfillmentFinding[] = [];
  const contracts = input.contracts ?? [];
  const payments = (input.payments ?? []).filter(isCountedPayment);
  if (contracts.length === 0) return out;

  const chainRows = contracts.map((c) => ({
    id: c.id,
    parentContractId: c.parentContractId ?? null,
    amount: c.amount,
    changeAmount: c.changeAmount,
  }));

  // 付款按**链根**归集：分母是整链金额，分子若只认本合同，付款记在补充协议上时
  // paid 恒为 0 → C6 静默不报（比误报更危险：看着像「没有问题」）。
  const rootOfContract = (id: string): string => {
    const byId = new Map(chainRows.map((c) => [c.id, c]));
    let rid = id;
    let node = byId.get(id);
    const guard = new Set<string>([id]);
    while (node?.parentContractId && byId.has(node.parentContractId) && !guard.has(node.parentContractId)) {
      guard.add(node.parentContractId);
      rid = node.parentContractId;
      node = byId.get(node.parentContractId);
    }
    return rid;
  };
  const paidByChainRoot = new Map<string, Cents>();
  let paidWithoutContract = 0;
  for (const p of payments) {
    const cid = String(p.contractId ?? '');
    if (!cid) {
      // 付款没挂合同：这笔钱进不了任何链的累计付款，会让「付款进度」偏低 → 必须说出来
      paidWithoutContract += 1;
      continue;
    }
    const cents = moneyToCents(p.amount) ?? 0n;
    const root = rootOfContract(cid);
    paidByChainRoot.set(root, (paidByChainRoot.get(root) ?? 0n) + cents);
  }

  const byContract = new Map<string, MilestoneRow[]>();
  for (const m of input.milestones ?? []) {
    const list = byContract.get(m.contractId) ?? [];
    list.push(m);
    byContract.set(m.contractId, list);
  }

  let skippedNoAmount = 0;
  let skippedNoMilestone = 0;
  let skippedAllNodes = 0;
  // 一条合同链只出一条：分子（累计付款）与分母（合同当前金额）都是**整链**口径，
  // 完成率若只取单个节点（母合同或某份补充协议），同一链上的各合同会各报一条、
  // 结论还互相矛盾（2026-10-23 审计 P1）。整链聚合后实体也归到链根。
  const chains = new Map<string, { rootId: string; rows: Array<{ id: string; code?: string | null; name?: string | null }> }>();
  for (const c of contracts) {
    const rootId = rootOfContract(c.id);
    const entry = chains.get(rootId) ?? { rootId, rows: [] };
    entry.rows.push(c);
    chains.set(rootId, entry);
  }

  for (const { rootId, rows: chainContracts } of chains.values()) {
    const milestones = chainContracts.flatMap((c) => byContract.get(c.id) ?? []);
    if (milestones.length === 0) {
      skippedNoMilestone += chainContracts.length;
      continue;
    }
    const done = milestones.filter(isDone).length;
    const open = milestones.filter(isOpen).length;
    if (done + open === 0) {
      // 节点状态既不是已完成也不是未完成（脏状态）：没有可比口径，但要计数
      skippedAllNodes += chainContracts.length;
      continue;
    }
    const donePct = Math.round((done * 100) / (done + open));

    const rootContract = chainContracts.find((c) => c.id === rootId) ?? chainContracts[0];
    const chain = resolveChainAmounts(chainRows, rootId);
    const paid = paidByChainRoot.get(rootId) ?? 0n;
    if (paid === 0n) continue;
    if (chain.currentAmount === null || chain.currentAmount <= 0) {
      skippedNoAmount += chainContracts.length;
      continue;
    }
    const currentCents = moneyToCents(chain.currentAmount.toFixed(2));
    if (currentCents === null || currentCents <= 0n) {
      skippedNoAmount += chainContracts.length;
      continue;
    }
    // 付款比例（百分点，向下去整）：paid / currentAmount × 100
    const paidPct = Number((paid * 100n) / currentCents);
    const gap = paidPct - donePct;
    // 与 C1/C4 同口径：**严格超出**阈值才报，等于阈值属于容忍范围
    if (gap <= ctx.tol.progressGapPct) continue;
    const chainNote = chainContracts.length > 1 ? `（整链 ${chainContracts.length} 份合同）` : '';
    push(out, {
      code: FULFILLMENT_CODES.C6_PROGRESS_PAYMENT_GAP,
      level: gap >= HIGH_RISK_GAP_PCT ? FULFILLMENT_LEVEL.HIGH : FULFILLMENT_LEVEL.MEDIUM,
      entity: 'contract',
      entityId: rootId,
      contractId: rootId,
      contractCode: String(rootContract.code ?? ''),
      contractName: String(rootContract.name ?? ''),
      title: `付款进度 ${paidPct}% 高于履约完成率 ${donePct}（差 ${gap} 个百分点）`,
      facts: [
        `合同：${String(rootContract.code ?? '')}${rootContract.name ? ` ${rootContract.name}` : ''}${chainNote}`,
        `合同当前金额：${(Number(currentCents) / 100).toFixed(2)} 元（母合同 + 补充协议增量）`,
        `累计付款：${(Number(paid) / 100).toFixed(2)} 元（占 ${paidPct}%）`,
        `履约节点：已完成 ${done} / 未完成 ${open}（完成率 ${donePct}%，整链合计）`,
        `差额：${gap} 个百分点（超出阈值 ${ctx.tol.progressGapPct} 个百分点）`,
      ],
      amountDiff: null,
    });
  }
  if (skippedNoAmount > 0) {
    ctx.notEvaluated.push(`C6 有 ${skippedNoAmount} 个合同因「合同金额未填或为 0」无法计算付款比例`);
  }
  if (skippedNoMilestone > 0) {
    ctx.notEvaluated.push(`C6 有 ${skippedNoMilestone} 个合同因「没有任何履约节点」无法计算完成率`);
  }
  if (skippedAllNodes > 0) {
    ctx.notEvaluated.push(`C6 有 ${skippedAllNodes} 个合同的履约节点状态既非已完成也非未完成，无法计算完成率`);
  }
  if (paidWithoutContract > 0) {
    ctx.notEvaluated.push(`C6 有 ${paidWithoutContract} 笔付款没有挂合同，未计入任何合同链的累计付款`);
  }
  return out;
}

/** C7 已出终期结算（非草稿）却仍有未完成节点 —— 结算口径与履约口径自相矛盾 */
export function c7SettledUnfinished(
  input: FulfillmentInput,
  contracts: Map<string, FulfillmentContractRow>,
  ctx?: FulfillmentRuleContext,
): FulfillmentFinding[] {
  const out: FulfillmentFinding[] = [];
  const settledContracts = new Map<string, string>();
  // 变量名不要用 fs：`aiCodeGuards.spec` 会扫 server/src 里的 fs 调用，误判成文件 I/O
  // 口径：只有「已定案」（SETTLED）才算已出终期结算。字典（final_settlement_status）
  // 只有 PENDING_ATTACHMENT / SETTLED 两个值——原来按 `status === 'DRAFT'` 排除草稿，
  // 那是个**永远不成立**的死条件（等于把「待补附件」也当成了已结算）。
  let unsettledNoted = 0;
  for (const settle of input.finalSettlements ?? []) {
    const cid = String(settle.contractId ?? '');
    if (!cid) continue;
    const status = String(settle.statusCode ?? '');
    if (status !== FINAL_SETTLEMENT_STATUS.SETTLED) {
      unsettledNoted += 1;
      continue;
    }
    settledContracts.set(cid, settle.id);
  }
  if (unsettledNoted > 0) {
    ctx?.notEvaluated?.push(
      `C7 有 ${unsettledNoted} 份终期结算未定案（statusCode ≠ SETTLED），未纳入「已出终期结算」判定`,
    );
  }
  if (settledContracts.size === 0) return out;

  const pendingByContract = new Map<string, MilestoneRow[]>();
  for (const m of input.milestones ?? []) {
    if (!isOpen(m)) continue;
    const list = pendingByContract.get(m.contractId) ?? [];
    list.push(m);
    pendingByContract.set(m.contractId, list);
  }

  for (const [contractId, finalId] of settledContracts) {
    const pending = pendingByContract.get(contractId) ?? [];
    if (pending.length === 0) continue;
    const { code, name } = contractLabel(contracts.get(contractId));
    push(out, {
      code: FULFILLMENT_CODES.C7_SETTLED_UNFINISHED,
      level: FULFILLMENT_LEVEL.MEDIUM,
      entity: 'contract',
      entityId: contractId,
      contractId,
      contractCode: code,
      contractName: name,
      title: `已出终期结算，但仍有 ${pending.length} 个履约节点未完成`,
      facts: [
        `合同：${code}${name ? ` ${name}` : ''}`,
        `终期结算 ID：${finalId}`,
        `未完成节点：${pending.map((m) => `${m.name ?? '(未命名)'}（计划 ${dayText(m.planDate)}）`).join('、')}`,
      ],
      amountDiff: null,
    });
  }
  return out;
}

/** C8 已签章合同没有任何履约节点（等于没有履约跟踪，后面所有偏差都看不见） */
export function c8NoMilestone(
  input: FulfillmentInput,
  contracts: Map<string, FulfillmentContractRow>,
): FulfillmentFinding[] {
  const out: FulfillmentFinding[] = [];
  const withNodes = new Set((input.milestones ?? []).map((m) => m.contractId));
  for (const c of input.contracts ?? []) {
    const signed = Boolean(c.signedDate || c.signDate);
    if (!signed) continue;
    if (withNodes.has(c.id)) continue;
    const { code, name } = contractLabel(contracts.get(c.id));
    push(out, {
      code: FULFILLMENT_CODES.C8_NO_MILESTONE,
      level: FULFILLMENT_LEVEL.MEDIUM,
      entity: 'contract',
      entityId: c.id,
      contractId: c.id,
      contractCode: code,
      contractName: name,
      title: '已签章合同没有任何履约节点',
      facts: [
        `合同：${code}${name ? ` ${name}` : ''}`,
        `签订日期：${dayText(c.signedDate ?? c.signDate)}`,
        '履约节点：0 个',
      ],
      amountDiff: null,
    });
  }
  return out;
}

/** 排序：高风险在前，其次按合同编号、规则码（保证输出稳定，便于对账） */
export function sortFulfillmentFindings(list: FulfillmentFinding[]): FulfillmentFinding[] {
  return list.slice().sort((a, b) => {
    if (a.level !== b.level) return a.level === FULFILLMENT_LEVEL.HIGH ? -1 : 1;
    if (a.contractCode !== b.contractCode) return a.contractCode < b.contractCode ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
  });
}

export function summarizeFulfillmentFindings(list: FulfillmentFinding[]): FulfillmentSummary {
  const byCode: Record<string, number> = {};
  let high = 0;
  let medium = 0;
  for (const f of list) {
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    if (f.level === FULFILLMENT_LEVEL.HIGH) high += 1;
    else medium += 1;
  }
  return { total: list.length, high, medium, byCode };
}

/**
 * 全部规则跑一遍。
 *
 * `now` 由调用方给：service 传当前时间，单测传固定日期——**规则层永远不读系统时钟**，
 * 否则夹具会随日期漂移，评测结果不可复现。
 */
export function evaluateFulfillmentAnomalies(input: FulfillmentInput): FulfillmentEvaluation {
  const tol = resolveFulfillmentTolerances(input.tolerances);
  const ctx: FulfillmentRuleContext = { now: input.now ?? new Date(), tol, notEvaluated: [] };
  const contracts = new Map<string, FulfillmentContractRow>();
  for (const c of input.contracts ?? []) contracts.set(c.id, c);
  const milestones = input.milestones ?? [];

  // C7 要看「已出终期结算」的合同——它们多数已退出 C1–C6 主口径，得单独补一份口径给它，
  // 否则候选集恒空、规则永远不触发（2026-10-23 审计）。
  // ⚠️ 节点必须**两边合并**：主口径里的合同（仍在履行，但终期结算已定案而 execStatus 还没同步）
  // 也有自己的未完成节点，只喂 settledScope 的节点会让它们凭空变成「没有未完成节点」→ C7 漏判。
  const c7Input: FulfillmentInput = input.settledScope
    ? {
        ...input,
        contracts: [...(input.contracts ?? []), ...input.settledScope.contracts],
        milestones: [...(input.milestones ?? []), ...input.settledScope.milestones],
      }
    : input;
  const c7Contracts = new Map(contracts);
  for (const c of input.settledScope?.contracts ?? []) c7Contracts.set(c.id, c);

  const findings = [
    ...c1Overdue(milestones, contracts, ctx),
    ...c2DoneNoActual(milestones, contracts),
    ...c3SequenceInverted(milestones, contracts),
    ...c4FinishLate(milestones, contracts, ctx),
    ...c5PlanBeforeSign(milestones, contracts),
    ...c6ProgressPaymentGap(input, ctx),
    ...c7SettledUnfinished(c7Input, c7Contracts, ctx),
    ...c8NoMilestone(input, contracts),
  ];

  return {
    findings: sortFulfillmentFindings(findings),
    summary: summarizeFulfillmentFindings(findings),
    notEvaluated: ctx.notEvaluated,
  };
}

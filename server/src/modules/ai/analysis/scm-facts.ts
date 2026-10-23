/**
 * 课题 7-11 · **供应链运营分析助理**——事实层（纯函数）。
 *
 * 与 6-9 / 3-9 / 4-9 同款约束：**不 import Prisma、不做 IO、不读系统时钟**，
 * `asOf`（基准日）由上层注入，因此能被 `npm test` 裸跑。
 *
 * 这一层只做三件事：
 * 1. `buildScmFacts()`：把已取好的行汇总成事实包（金额全程整数分，输出时转元）；
 * 2. `scmFactsToMarkdown()`：**确定性**的全景报告——AI 未配置、调用失败、
 *    或模型编了无法对账的数字时，直接用它产出，页面不出现空壳；
 * 3. `scmFactNumbers()`：事实包里所有出现过的数字，供 `auditNumbers()` 对账。
 */

import {
  CONTRACT_STATUS,
  INVOICE_STATUS,
  LEGACY_CONTRACT_STATUS_COMPLETED,
  MILESTONE_STATUS,
  PAYMENT_EXCLUDED_STATUSES,
  SETTLEMENT_STATUS,
} from '../../../constants/statuses.ts';
import { resolveChainAmounts } from '../../../common/utils/contract-chain.ts';
import { centsToYuan, moneyToCents, type Cents } from '../common/money.ts';
import {
  DEFAULT_SCM_TOLERANCES,
  type ScmFacts,
  type ScmProjectFacts,
  type ScmRows,
  type ScmSupplierFacts,
  type ScmTolerances,
  type ScmTotals,
} from './scm-types.ts';

/** 结算单是否计入：`DRAFT` 不算（与 6-9 同口径） */
const isCountedSettlement = (row: { statusCode?: string | null }): boolean =>
  row.statusCode !== SETTLEMENT_STATUS.DRAFT;

/** 付款是否计入：`FAILED` / `REFUNDED` 不算 */
const isCountedPayment = (row: { statusCode?: string | null }): boolean =>
  !PAYMENT_EXCLUDED_STATUSES.includes(String(row.statusCode ?? ''));

/** 发票是否计入：作废（`CANCELLED`）与红冲（`RED`）不算 */
const isCountedInvoice = (row: { statusCode?: string | null }): boolean => {
  const s = String(row.statusCode ?? '');
  return s !== INVOICE_STATUS.CANCELLED && s !== INVOICE_STATUS.RED;
};

/**
 * 合同是否「已签」：`SIGNED` 或历史遗留 `COMPLETED`（`DRAFT`/`APPROVING` 未落地，不进全景）。
 * 注意字段名——合同用 `status`，结算/付款/发票用 `statusCode`。
 */
const isSignedContract = (row: { status?: string | null }): boolean => {
  const s = String(row.status ?? '');
  return s === CONTRACT_STATUS.SIGNED || s === LEGACY_CONTRACT_STATUS_COMPLETED;
};

/** 本地日历日差（回合到整日，绕过夏令时） */
const dayDiff = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / 86_400_000);

const toDay = (v: unknown): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * 百分比（保留 1 位小数，四舍五入）：分母为 0 → `null`（「无法计算」不是 0%）。
 *
 * 先按万分之一取整再折算，避免 `Number(/ 1000n)` 的截断把 105.26% 变成 105.2%。
 */
const pct = (numeratorCents: Cents, denominatorCents: Cents): number | null => {
  if (denominatorCents === 0n) return null;
  const bp = (numeratorCents * 10_000n) / denominatorCents;
  return Math.round(Number(bp) / 10) / 10;
};

const sumCents = (list: Cents[]): Cents => list.reduce((a, b) => a + b, 0n);

/** 事实包构建（纯函数） */
export function buildScmFacts(
  rows: ScmRows,
  asOf: string,
  tol: ScmTolerances = DEFAULT_SCM_TOLERANCES,
): ScmFacts {
  const asOfDay = toDay(asOf) ?? new Date(0);
  const projectIds = rows.projects.map((p) => p.id);
  const known = new Set(projectIds);

  // ---- 合同：按链聚合（链根一个金额，补充协议只用 changeAmount 增量） ----
  const chainRoots = new Map<
    string,
    { projectId: string; supplierId: string | null; cents: Cents | null; signed: boolean }
  >();
  for (const row of rows.contracts) {
    const chain = resolveChainAmounts(rows.contracts, row.id);
    if (!chain.rootId) continue;
    if (chainRoots.has(chain.rootId)) continue;
    const rootRow = rows.contracts.find((r) => r.id === chain.rootId);
    if (!rootRow) continue;
    chainRoots.set(chain.rootId, {
      projectId: rootRow.projectId,
      supplierId: rootRow.supplierId ?? null,
      // 主合同金额未填 → null（未知，不是 0）：不计入签约额，但要单独提示
      cents: chain.currentAmount === null ? null : moneyToCents(chain.currentAmount),
      signed: isSignedContract(rootRow),
    });
  }

  const signedByProject = new Map<string, Cents[]>();
  const countByProject = new Map<string, number>();
  const unknownAmountByProject = new Map<string, number>();
  const signedBySupplier = new Map<string | null, Cents[]>();
  const supplierName = new Map<string, string>(rows.suppliers.map((s) => [s.id, s.name]));

  for (const root of chainRoots.values()) {
    if (!root.signed) continue;
    const list = signedByProject.get(root.projectId) ?? [];
    countByProject.set(root.projectId, (countByProject.get(root.projectId) ?? 0) + 1);
    if (root.cents === null) {
      unknownAmountByProject.set(root.projectId, (unknownAmountByProject.get(root.projectId) ?? 0) + 1);
      signedByProject.set(root.projectId, list);
      continue;
    }
    list.push(root.cents);
    signedByProject.set(root.projectId, list);
    const sl = signedBySupplier.get(root.supplierId) ?? [];
    sl.push(root.cents);
    signedBySupplier.set(root.supplierId, sl);
  }

  // ---- 结算 / 付款 / 开票：按项目累加 ----
  const settledByProject = new Map<string, Cents[]>();
  for (const row of rows.settlements) {
    if (!isCountedSettlement(row)) continue;
    const raw = row.actualAmount ?? row.amount;
    const cents = moneyToCents(raw);
    if (cents === null) continue;
    const list = settledByProject.get(row.projectId) ?? [];
    list.push(cents);
    settledByProject.set(row.projectId, list);
  }

  const paidByProject = new Map<string, Cents[]>();
  for (const row of rows.payments) {
    if (!isCountedPayment(row)) continue;
    const cents = moneyToCents(row.amount);
    if (cents === null) continue;
    const list = paidByProject.get(row.projectId) ?? [];
    list.push(cents);
    paidByProject.set(row.projectId, list);
  }

  const invoicedByProject = new Map<string, Cents[]>();
  for (const row of rows.invoices) {
    if (!isCountedInvoice(row)) continue;
    const cents = moneyToCents(row.amountWithTax);
    if (cents === null) continue;
    const list = invoicedByProject.get(row.projectId) ?? [];
    list.push(cents);
    invoicedByProject.set(row.projectId, list);
  }

  // ---- 履约节点：逾期口径与页面标红一致（未完成且计划日已过） ----
  const milestoneByProject = new Map<string, { total: number; overdue: number }>();
  for (const row of rows.milestones) {
    if (!known.has(row.projectId)) continue;
    const stat = milestoneByProject.get(row.projectId) ?? { total: 0, overdue: 0 };
    stat.total += 1;
    const plan = toDay(row.planDate);
    if (row.statusCode === MILESTONE_STATUS.PENDING && plan && dayDiff(plan, asOfDay) > 0) {
      stat.overdue += 1;
    }
    milestoneByProject.set(row.projectId, stat);
  }

  // ---- 逐项目事实 ----
  const projects: ScmProjectFacts[] = rows.projects.map((p) => {
    const signedCents = sumCents(signedByProject.get(p.id) ?? []);
    const settledCents = sumCents(settledByProject.get(p.id) ?? []);
    const paidCents = sumCents(paidByProject.get(p.id) ?? []);
    const invoicedCents = sumCents(invoicedByProject.get(p.id) ?? []);
    const stat = milestoneByProject.get(p.id) ?? { total: 0, overdue: 0 };
    return {
      projectId: p.id,
      code: p.code,
      name: p.name,
      contractCount: countByProject.get(p.id) ?? 0,
      signedYuan: Number(centsToYuan(signedCents)),
      settledYuan: Number(centsToYuan(settledCents)),
      paidYuan: Number(centsToYuan(paidCents)),
      invoicedYuan: Number(centsToYuan(invoicedCents)),
      unpaidYuan: Number(centsToYuan(settledCents - paidCents)),
      uninvoicedYuan: Number(centsToYuan(settledCents - invoicedCents)),
      payRatioPct: pct(paidCents, settledCents),
      settleRatioPct: pct(settledCents, signedCents),
      invoiceRatioPct: pct(invoicedCents, settledCents),
      milestoneCount: stat.total,
      overdueMilestones: stat.overdue,
    };
  });
  projects.sort((a, b) => b.signedYuan - a.signedYuan || a.code.localeCompare(b.code));

  const totalSignedCents = sumCents(projects.map((p) => moneyToCents(p.signedYuan) ?? 0n));
  const totalSettledCents = sumCents(projects.map((p) => moneyToCents(p.settledYuan) ?? 0n));
  const totalPaidCents = sumCents(projects.map((p) => moneyToCents(p.paidYuan) ?? 0n));
  const totalInvoicedCents = sumCents(projects.map((p) => moneyToCents(p.invoicedYuan) ?? 0n));

  const totals: ScmTotals = {
    projectCount: projects.length,
    contractCount: projects.reduce((a, p) => a + p.contractCount, 0),
    signedYuan: Number(centsToYuan(totalSignedCents)),
    settledYuan: Number(centsToYuan(totalSettledCents)),
    paidYuan: Number(centsToYuan(totalPaidCents)),
    invoicedYuan: Number(centsToYuan(totalInvoicedCents)),
    unpaidYuan: Number(centsToYuan(totalSettledCents - totalPaidCents)),
    uninvoicedYuan: Number(centsToYuan(totalSettledCents - totalInvoicedCents)),
    payRatioPct: pct(totalPaidCents, totalSettledCents),
    settleRatioPct: pct(totalSettledCents, totalSignedCents),
    invoiceRatioPct: pct(totalInvoicedCents, totalSettledCents),
    overdueMilestones: projects.reduce((a, p) => a + p.overdueMilestones, 0),
  };

  // ---- 供应商集中度 ----
  const suppliers: ScmSupplierFacts[] = [];
  for (const [supplierId, list] of signedBySupplier) {
    const cents = sumCents(list);
    suppliers.push({
      supplierId,
      name: supplierId ? supplierName.get(supplierId) || '（供应商已删除）' : '（未填供应商）',
      contractCount: list.length,
      signedYuan: Number(centsToYuan(cents)),
      sharePct: totalSignedCents === 0n ? 0 : (pct(cents, totalSignedCents) ?? 0),
    });
  }
  suppliers.sort((a, b) => b.signedYuan - a.signedYuan || a.name.localeCompare(b.name));

  const empty = projects.length === 0 || totals.contractCount === 0;

  return {
    asOf,
    totals,
    projects,
    suppliers: suppliers.slice(0, Math.max(1, tol.topSuppliers)),
    risks: buildRisks(projects, totals, suppliers, tol, unknownAmountByProject),
    empty,
  };
}

/**
 * 风险提示：**全部由程序判定**，模型只许转述。
 * 只用库内数据就能判的四类：付款超过结算、开票明显落后、节点逾期、供应商过度集中。
 */
function buildRisks(
  projects: ScmProjectFacts[],
  totals: ScmTotals,
  suppliers: ScmSupplierFacts[],
  tol: ScmTolerances,
  unknownAmountByProject: Map<string, number>,
): string[] {
  const risks: string[] = [];

  const overpaid = projects.filter((p) => p.unpaidYuan < 0);
  for (const p of overpaid) {
    risks.push(
      `${p.code}：付款已超过结算 ${Math.abs(p.unpaidYuan).toFixed(2)} 元（付款 ${p.paidYuan.toFixed(2)} 元 > 结算 ${p.settledYuan.toFixed(2)} 元）`,
    );
  }

  const gapThreshold = tol.invoiceGapPct;
  for (const p of projects) {
    if (p.invoiceRatioPct === null) continue;
    const gap = Math.round((100 - p.invoiceRatioPct) * 10) / 10;
    if (gap >= gapThreshold) {
      risks.push(
        `${p.code}：开票落后于结算 ${gap} 个百分点（已结算 ${p.settledYuan.toFixed(2)} 元，已开票 ${p.invoicedYuan.toFixed(2)} 元）`,
      );
    }
  }

  const overdueProjects = projects.filter((p) => p.overdueMilestones > 0);
  if (overdueProjects.length) {
    const detail = overdueProjects
      .map((p) => `${p.code} ${p.overdueMilestones} 个`)
      .join('、');
    risks.push(`履约节点逾期：合计 ${totals.overdueMilestones} 个（${detail}），逾期节点直接对应交付与验收延迟风险`);
  }

  const top = suppliers[0];
  if (top && top.sharePct >= tol.topSharePct && suppliers.length > 1) {
    risks.push(
      `供应商集中度偏高：${top.name} 签约额占比 ${top.sharePct}%（警戒线 ${tol.topSharePct}%），单点依赖风险`,
    );
  }

  for (const [projectId, count] of unknownAmountByProject) {
    const p = projects.find((x) => x.projectId === projectId);
    if (!p) continue;
    risks.push(`${p.code}：有 ${count} 份已签合同未填主合同金额，未计入签约额（数据缺口，不是 0 元）`);
  }

  return risks;
}

const fmtYuan = (n: number): string =>
  n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (v: number | null): string => (v === null ? '—' : `${v}%`);

/**
 * 确定性全景报告（AI 不可用 / 数字对账失败时的兜底，也是 prompt 的结构骨架）。
 * 只写事实包里已有的数字，不做任何推算。
 */
export function scmFactsToMarkdown(facts: ScmFacts): string {
  const t = facts.totals;
  const lines: string[] = [];
  lines.push('# 供应链运营全景');
  lines.push('');
  lines.push(`基准日：${facts.asOf}（口径：累计至今，金额单位为元）`);
  lines.push('');

  lines.push('## 一、总体情况');
  lines.push('');
  lines.push(`- 在管项目 **${t.projectCount}** 个，已签合同 **${t.contractCount}** 份`);
  lines.push(`- 签约额 ${fmtYuan(t.signedYuan)} 元，结算额 ${fmtYuan(t.settledYuan)} 元（结算率 ${fmtPct(t.settleRatioPct)}）`);
  lines.push(`- 付款额 ${fmtYuan(t.paidYuan)} 元（付款率 ${fmtPct(t.payRatioPct)}），未付 ${fmtYuan(t.unpaidYuan)} 元`);
  lines.push(`- 开票额 ${fmtYuan(t.invoicedYuan)} 元（开票率 ${fmtPct(t.invoiceRatioPct)}），未开票 ${fmtYuan(t.uninvoicedYuan)} 元`);
  lines.push(`- 履约节点逾期 **${t.overdueMilestones}** 个`);
  lines.push('');

  lines.push('## 二、项目对照');
  lines.push('');
  lines.push('| 项目 | 签约 | 结算 | 付款 | 开票 | 付款率 | 逾期节点 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const p of facts.projects) {
    lines.push(
      `| ${p.code} ${p.name} | ${fmtYuan(p.signedYuan)} | ${fmtYuan(p.settledYuan)} | ${fmtYuan(p.paidYuan)} | ${fmtYuan(p.invoicedYuan)} | ${fmtPct(p.payRatioPct)} | ${p.overdueMilestones} |`,
    );
  }
  lines.push('');

  lines.push('## 三、供应商集中度');
  lines.push('');
  if (facts.suppliers.length === 0) {
    lines.push('- 无已签合同的供应商数据');
  } else {
    lines.push('| 供应商 | 合同数 | 签约额 | 占比 |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of facts.suppliers) {
      lines.push(`| ${s.name} | ${s.contractCount} | ${fmtYuan(s.signedYuan)} | ${s.sharePct}% |`);
    }
  }
  lines.push('');

  lines.push('## 四、风险与建议');
  lines.push('');
  if (facts.risks.length === 0) {
    lines.push('- 程序未发现可判定的异常，但仍需关注数据完整性（未填金额、未开票、未验收等不体现在本报告）');
  } else {
    for (const r of facts.risks) lines.push(`- ${r}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 事实包里所有数字（金额、家数、百分比），供 `auditNumbers()` 对账 */
export function scmFactNumbers(facts: ScmFacts): number[] {
  const out: number[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.push(v);
      // 差额类数值同时放行其绝对值：模型说「付款已超结算 50,000.00 元」时，
      // 报出来的正是 `unpaidYuan = -50000` 的绝对值——它是**由事实直接推得**的数，
      // 不放行会导致整份报告被误判为「编数字」。放行绝对值不引入新口径。
      if (v < 0) out.push(Math.abs(v));
    }
  };
  const t = facts.totals;
  for (const key of [
    'projectCount',
    'contractCount',
    'signedYuan',
    'settledYuan',
    'paidYuan',
    'invoicedYuan',
    'unpaidYuan',
    'uninvoicedYuan',
    'payRatioPct',
    'settleRatioPct',
    'invoiceRatioPct',
    'overdueMilestones',
  ] as const) {
    push(t[key]);
  }
  const day = /(\d{4})-(\d{2})-(\d{2})/.exec(facts.asOf);
  if (day) {
    push(Number(day[1]));
    push(Number(day[2]));
    push(Number(day[3]));
  }
  for (const p of facts.projects) {
    push(p.contractCount);
    push(p.signedYuan);
    push(p.settledYuan);
    push(p.paidYuan);
    push(p.invoicedYuan);
    push(p.unpaidYuan);
    push(p.uninvoicedYuan);
    push(p.payRatioPct);
    push(p.settleRatioPct);
    push(p.invoiceRatioPct);
    push(p.milestoneCount);
    push(p.overdueMilestones);
  }
  for (const s of facts.suppliers) {
    push(s.contractCount);
    push(s.signedYuan);
    push(s.sharePct);
  }
  // 项目编号/供应商名里的数字（如 `XM-2026-01`）不是金额，但出现在正文里也不该报成编造
  for (const p of facts.projects) {
    for (const n of p.code.match(/\d+/g) ?? []) push(Number(n));
  }
  return out;
}

/**
 * AI 预警 · **采购报价与价差规则层**（矩阵课题 3-9）。
 *
 * 七类形态、十二条规则码，全部纯函数：输入已是内存行，输出 `findings`。
 * 一条铁律：**这里算完的数，模型只许照抄**。需要新增数字时改这里，不要指望提示词。
 *
 * 未判定的情形一律落 `notEvaluated`（口径透明）：`items` 没控制价、还没定标、
 * 只有一家有效报价…… 都要说出来，不能静默当「没问题」。
 */

import { BIDDER_STATUS } from '../../../constants/statuses.ts';
import {
  type BidderRow,
  type Cents,
  type CompareItemRow,
  type QuoteCode,
  type QuoteEvaluation,
  type QuoteEntity,
  type QuoteFinding,
  type QuoteInput,
  type QuoteLevel,
  type QuoteSummary,
  type QuoteTaskInput,
  type QuoteTolerances,
  type TotalItemRow,
  type Units,
  LEGAL_TAX_RATE_PCT,
  QUOTE_CODES,
  QUOTE_LEVEL,
  QUOTE_PCT,
  amountOfUnits,
  bidderFirstCents,
  bidderSecondCents,
  bidderTotalCents,
  fmtBp,
  isCountedBidder,
  moneyToCents,
  qtyToUnits,
  ratioBpOf,
  resolveQuoteTolerances,
  taxRateBpOf,
  yuan,
} from './quote-types.ts';

export const QUOTE_RULE_IDS = [
  QUOTE_CODES.B1_DROP_EXCESS,
  QUOTE_CODES.B1_DROP_INVERTED,
  QUOTE_CODES.B2_SPREAD_TOO_LOW,
  QUOTE_CODES.B3_OVER_BUDGET,
  QUOTE_CODES.B3_UNDER_BUDGET,
  QUOTE_CODES.B4_PRICE_OVER_CONTROL,
  QUOTE_CODES.B4_PRICE_VS_MARKET,
  QUOTE_CODES.B5_TAX_RATE_INVALID,
  QUOTE_CODES.B5_TAX_RATE_DRIFT,
  QUOTE_CODES.B6_NOT_LOWEST,
  QUOTE_CODES.B7_FEW_BIDDERS,
  QUOTE_CODES.B7_WINNER_NO_PRICE,
] as const;

/** 单条规则的产出 */
export interface QuoteRuleResult {
  findings: QuoteFinding[];
  notEvaluated: string[];
}

const empty = (): QuoteRuleResult => ({ findings: [], notEvaluated: [] });

const nameOf = (b: BidderRow): string => (b.bidderName ?? '').trim() || b.id;
const taskNoOf = (input: QuoteTaskInput): string =>
  (input.task.taskNo ?? '').trim() || input.task.id;

function base(
  input: QuoteTaskInput,
  code: QuoteCode,
  level: QuoteLevel,
  entity: QuoteEntity,
  entityId: string,
  title: string,
  facts: string[],
  amountDiff?: Cents,
): QuoteFinding {
  const f: QuoteFinding = {
    code,
    level,
    entity,
    entityId,
    taskId: input.task.id,
    taskNo: taskNoOf(input),
    title,
    facts,
  };
  if (amountDiff !== undefined) f.amountDiff = yuan(amountDiff < 0n ? -amountDiff : amountDiff);
  return f;
}

/** 定标单位（`status === WON`）。理论上每任务至多一家；多于一家时取序号最小者并如实报出 */
export function winnerOf(bidders: BidderRow[]): BidderRow | null {
  const won = bidders.filter((b) => b.status === BIDDER_STATUS.WON);
  if (won.length === 0) return null;
  return [...won].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0];
}

/**
 * 控制价合计（分）= Σ 数量 × 预计采购单价（`planPrice`）。
 * 任一行缺数量或缺单价就跳过该行（「未填 ≠ 0」）；一行都用不上 → `null`。
 */
export function budgetCentsOf(items: TotalItemRow[]): Cents | null {
  let total = 0n;
  let used = 0;
  for (const it of items) {
    const price = moneyToCents(it.planPrice);
    const qty = qtyToUnits(it.qty);
    if (price === null || qty === null || price <= 0n || qty <= 0n) continue;
    total += amountOfUnits(price, qty);
    used += 1;
  }
  return used === 0 ? null : total;
}

const keyOfRow = (r: { materialBaseId?: string | null; materialName?: string | null; spec?: string | null }): string =>
  (r.materialBaseId ?? '').trim() ||
  `${(r.materialName ?? '').trim()}|${(r.spec ?? '').trim()}`;

const labelOfRow = (r: { materialName?: string | null; spec?: string | null }): string =>
  `${(r.materialName ?? '').trim() || '(未命名物资)'}${
    (r.spec ?? '').trim() ? `（${(r.spec ?? '').trim()}）` : ''
  }`;

// ------------------------------------------------------------------ B1 两轮降幅

/**
 * B1：同一单位两轮报价的方向与幅度。
 * - 二轮高于一轮 → 议价方向异常（录入/口径错），MEDIUM；
 * - 降幅超阈值 → 先虚高再降价的典型形态，MEDIUM（要书面降价依据）。
 */
export function b1DropAnomalies(input: QuoteTaskInput, tol: QuoteTolerances): QuoteRuleResult {
  const out = empty();
  let checked = 0;
  let skipped = 0;
  for (const b of input.bidders) {
    const first = bidderFirstCents(b);
    const second = bidderSecondCents(b);
    if (first === null || second === null || first <= 0n) {
      // 缺一轮报价 / 金额为 0：这一家不参与比较，但要说出有几家被跳过，
      // 否则「只比了 1 家」也会显示成全绿（2026-10-23 审计）
      skipped += 1;
      continue;
    }
    checked += 1;
    const dropBp = ratioBpOf(first - second, first);
    if (dropBp === null) {
      skipped += 1;
      checked -= 1;
      continue;
    }
    const name = nameOf(b);
    if (dropBp < 0) {
      out.findings.push(
        base(
          input,
          QUOTE_CODES.B1_DROP_INVERTED,
          QUOTE_LEVEL.MEDIUM,
          'bidder',
          b.id,
          `${name} 第二轮报价高于第一轮`,
          [
            `第一轮不含税 ${yuan(first)} 元，第二轮 ${yuan(second)} 元`,
            `二轮比一轮高 ${yuan(second - first)} 元（${fmtBp(-dropBp)}）`,
            '议价方向异常：多为录入错误或两轮口径不一致（含税/不含税、范围变化）',
          ],
          second - first,
        ),
      );
    } else if (dropBp > tol.dropPct * QUOTE_PCT) {
      out.findings.push(
        base(
          input,
          QUOTE_CODES.B1_DROP_EXCESS,
          QUOTE_LEVEL.MEDIUM,
          'bidder',
          b.id,
          `${name} 第二轮降幅 ${fmtBp(dropBp)} 超过阈值 ${tol.dropPct}%`,
          [
            `第一轮 ${yuan(first)} 元 → 第二轮 ${yuan(second)} 元，降 ${yuan(first - second)} 元`,
            `降幅 ${fmtBp(dropBp)}，阈值 ${fmtBp(tol.dropPct * QUOTE_PCT)}`,
            '复核首轮是否虚高、降价依据（成本复核表/让利说明）是否有书面支撑',
          ],
          first - second,
        ),
      );
    }
  }
  if (checked === 0) {
    out.notEvaluated.push(
      `B1 未判定：${taskNoOf(input)} 没有同时填了两轮报价的单位${
        skipped > 0 ? `（${skipped} 家缺一轮报价或金额为 0）` : ''
      }`,
    );
  }
  // 注意：**不做「比了几家」的部分提示**。报价还在进行中时「部分单位只交了首轮」是正常状态，
  // 把它写成「未判定」会让每张在谈的任务都变黄灯，反而掩护真问题（2026-10-23 复核）。
  return out;
}

// -------------------------------------------------------------- B2 报价离散度

/**
 * B2：首轮报价离散系数（标准差 / 均值）低于阈值 → 报价高度一致。
 * 只用**首轮**：第二轮受议价影响，天然收敛，用它判断围标会把正常议价误判。
 * 家数不足 `minBidders` 不判定（样本太少时离散系数没有意义）。
 */
export function b2SpreadAnomalies(input: QuoteTaskInput, tol: QuoteTolerances): QuoteRuleResult {
  const out = empty();
  const rows: Array<{ name: string; cents: Cents }> = [];
  let skipped = 0;
  for (const b of input.bidders) {
    if (b.status === BIDDER_STATUS.ABSTAINED) continue;
    const c = bidderFirstCents(b);
    if (c === null || c <= 0n) {
      // 弃标之外的「首轮金额没填」也要计数：否则 5 家里 3 家没填会被当成「只有 2 家报价」
      skipped += 1;
      continue;
    }
    rows.push({ name: nameOf(b), cents: c });
  }
  if (rows.length < tol.minBidders) {
    out.notEvaluated.push(
      `B2 未判定：${taskNoOf(input)} 首轮有效报价 ${rows.length} 家，不足 ${tol.minBidders} 家${
        skipped > 0 ? `（另有 ${skipped} 家首轮金额未填）` : ''
      }`,
    );
    return out;
  }

  // 家数 ≤ 20 且金额（分）远小于 2^53，这里用浮点做统计只影响「是否低于 3%」这种粗判定
  const vals = rows.map((r) => Number(r.cents));
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
  const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length;
  const stdev = Math.sqrt(variance);
  const cvBp = mean > 0 ? Math.round((stdev / mean) * 10_000) : null;
  if (cvBp === null) return out;
  if (cvBp >= tol.spreadPct * QUOTE_PCT) return out;

  const sorted = [...rows].sort((a, b) => (a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0));
  const min = sorted[0].cents;
  const max = sorted[sorted.length - 1].cents;
  const rangeBp = ratioBpOf(max - min, min) ?? 0;
  out.findings.push(
    base(
      input,
      QUOTE_CODES.B2_SPREAD_TOO_LOW,
      QUOTE_LEVEL.MEDIUM,
      'task',
      input.task.id,
      `${rows.length} 家首轮报价高度一致（离散系数 ${fmtBp(cvBp)}）`,
      [
        `首轮 ${rows.length} 家：${sorted.map((r) => `${r.name} ${yuan(r.cents)} 元`).join('；')}`,
        `最低 ${yuan(min)} 元，最高 ${yuan(max)} 元，极差仅 ${fmtBp(rangeBp)}`,
        `离散系数（标准差/均值）${fmtBp(cvBp)}，低于阈值 ${fmtBp(tol.spreadPct * QUOTE_PCT)}`,
        '报价高度一致是围标/串标的常见迹象：复核各单位报价独立性与成本测算依据，必要时要求书面澄清',
      ],
    ),
  );
  return out;
}

// ------------------------------------------------------------ B3 成交价与预算

/** B3：中标签约金额与控制价合计的偏离（超预算 / 显著低于预算两种方向都要看） */
export function b3BudgetAnomalies(input: QuoteTaskInput, tol: QuoteTolerances): QuoteRuleResult {
  const out = empty();
  const winner = winnerOf(input.bidders);
  if (!winner) {
    out.notEvaluated.push(`B3 未判定：${taskNoOf(input)} 尚未定标（没有 WON 单位）`);
    return out;
  }
  const budget = budgetCentsOf(input.items ?? []);
  if (budget === null || budget <= 0n) {
    out.notEvaluated.push(`B3 未判定：${taskNoOf(input)} 总采购清单没有「数量 × 控制价」可用行`);
    return out;
  }
  const deal = bidderTotalCents(winner);
  if (deal === null || deal <= 0n) {
    out.notEvaluated.push(
      `B3 未判定：${taskNoOf(input)} 中标单位 ${nameOf(winner)} 没有可用报价`,
    );
    return out;
  }
  const diff = deal - budget;
  const ratioBp = ratioBpOf(deal, budget);
  if (diff > tol.amount) {
    out.findings.push(
      base(
        input,
        QUOTE_CODES.B3_OVER_BUDGET,
        QUOTE_LEVEL.HIGH,
        'bidder',
        winner.id,
        `成交价超控制价 ${yuan(diff)} 元`,
        [
          `控制价合计 ${yuan(budget)} 元（清单数量 × 预计采购单价）`,
          `成交单位 ${nameOf(winner)}：${yuan(deal)} 元${ratioBp === null ? '' : `，为控制价的 ${fmtBp(ratioBp)}`}`,
          `超出 ${yuan(diff)} 元${ratioBp === null ? '' : `（${fmtBp(ratioBp - 10_000)}）`}`,
          '超预算成交需有审批依据：核对是否经变更/追加审批，以及是否已同步调整合同金额口径',
        ],
        diff,
      ),
    );
  } else if (deal * 100n < budget * BigInt(Math.round(tol.underBudgetPct))) {
    out.findings.push(
      base(
        input,
        QUOTE_CODES.B3_UNDER_BUDGET,
        QUOTE_LEVEL.MEDIUM,
        'bidder',
        winner.id,
        `成交价仅为控制价的 ${ratioBp === null ? '—' : fmtBp(ratioBp)}，显著低于阈值`,
        [
          `控制价合计 ${yuan(budget)} 元，成交价 ${yuan(deal)} 元，低 ${yuan(budget - deal)} 元`,
          `阈值：成交价不得低于控制价的 ${tol.underBudgetPct}%`,
          '显著偏低常见于清单漏项、范围缩水或控制价本身失真：复核报价范围的完整性',
        ],
        budget - deal,
      ),
    );
  }
  return out;
}

// -------------------------------------------------------------- B4 单价与价差

interface MergedRow {
  key: string;
  label: string;
  deal: Cents | null;
  plan: Cents | null;
  market: Cents | null;
  info: Cents | null;
  qty: Units | null;
}

/**
 * 归并 + **一致性护栏**：行序配对是「没有 id 可用」时的兜底，一旦两侧对不上就宁可
 * 「未判定」也不能硬配——硬配的后果不是报错，而是**静默错配**：市场价/控制价贴到
 * 另一条物资上，B4 给出「某物资比市场价高 300%」这种指错行的结论。
 */
function mergeRowsChecked(input: QuoteTaskInput): { rows: MergedRow[]; warning: string | null } {
  const totals = input.items ?? [];
  const compares = input.compareItems ?? [];
  const totalKeys = new Set(totals.map((r) => keyOfRow(r)));
  /**
   * **真实落库形状**：价格对比表 JSON 里每行的 `materialBaseId` 是「总采购清单行 id」
   * （`procurement-task.service.ts` 保存时写 `t.id`），而总采购清单行的 `materialBaseId`
   * 是物资 id ——两套 id 永不相等。按 id 归并会让「清单行 ↔ 成交价」错开：
   * 成交价行单独成行，**市场价（只存在总清单行上）永远到不了**，B4 的市场价比较静默失效。
   *
   * 因此：两侧 id 完全不重叠且行数一致时，按**行序**配对（两侧都由同一份
   * `orderBy: sortOrder` 的总清单派生，顺序是契约的一部分）。
   * 行数不一致、或行序配对后物资名/数量对不上时**不猜**，只报「未判定」。
   */
  const byIndex =
    compares.length > 0 &&
    compares.length === totals.length &&
    !compares.some((r) => totalKeys.has(keyOfRow(r)));
  if (byIndex) {
    const mismatch = totals.find((t, i) => {
      const c = compares[i];
      const n1 = String(t.materialName ?? '').trim();
      const n2 = String(c.materialName ?? '').trim();
      if (n1 && n2 && n1 !== n2) return true;
      const q1 = qtyToUnits(t.qty);
      const q2 = qtyToUnits(c.qty);
      return q1 !== null && q2 !== null && q1 !== q2;
    });
    if (!mismatch) {
      return {
        rows: totals.map((t, i) => {
          const c = compares[i];
          return {
            key: keyOfRow(t),
            label: labelOfRow(t),
            deal: moneyToCents(c.dealPrice),
            plan: moneyToCents(t.planPrice) ?? moneyToCents(c.planPrice),
            market: moneyToCents(t.marketPrice) ?? moneyToCents(c.marketPrice),
            info: moneyToCents(t.infoPrice) ?? moneyToCents(c.infoPrice),
            qty: qtyToUnits(t.qty) ?? qtyToUnits(c.qty),
          };
        }),
        warning: null,
      };
    }
    return {
      rows: [],
      warning:
        `B4 未判定：${taskNoOf(input)} 的采购价格对比表与总采购清单行数相同但物资/数量对不上` +
        '（清单可能被改过行序或增删后未重新发布对比表），不按行序强行配对，避免把价格贴到别的物资上',
    };
  }

  const map = new Map<string, MergedRow>();
  const get = (r: TotalItemRow | CompareItemRow): MergedRow => {
    const key = keyOfRow(r);
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        label: labelOfRow(r),
        deal: null,
        plan: null,
        market: null,
        info: null,
        qty: null,
      };
      map.set(key, row);
    }
    return row;
  };
  for (const it of input.items ?? []) {
    const row = get(it);
    row.plan = row.plan ?? moneyToCents(it.planPrice);
    row.market = row.market ?? moneyToCents(it.marketPrice);
    row.info = row.info ?? moneyToCents(it.infoPrice);
    row.qty = row.qty ?? qtyToUnits(it.qty);
  }
  for (const it of input.compareItems ?? []) {
    const row = get(it);
    row.deal = row.deal ?? moneyToCents(it.dealPrice);
    row.plan = row.plan ?? moneyToCents(it.planPrice);
    row.market = row.market ?? moneyToCents(it.marketPrice);
    row.info = row.info ?? moneyToCents(it.infoPrice);
    row.qty = row.qty ?? qtyToUnits(it.qty);
  }
  return { rows: [...map.values()], warning: null };
}

/**
 * B4：清单行成交单价。
 * - 高于控制价单价 → HIGH（单行就超控制价，不需要合计）；
 * - 偏离市场价（无市场价用信息价）超阈值 → MEDIUM。
 */
export function b4UnitPriceAnomalies(input: QuoteTaskInput, tol: QuoteTolerances): QuoteRuleResult {
  const out = empty();
  const merged = mergeRowsChecked(input);
  if (merged.warning) out.notEvaluated.push(merged.warning);
  const rows = merged.rows.filter((r) => r.deal !== null && r.deal > 0n);
  if (rows.length === 0) {
    if (!merged.warning) out.notEvaluated.push(`B4 未判定：${taskNoOf(input)} 采购价格对比表还没有录成交单价`);
    return out;
  }
  for (const r of rows) {
    const deal = r.deal as Cents;
    if (r.plan !== null && r.plan > 0n && deal - r.plan > tol.amount) {
      const perUnit = deal - r.plan;
      const total = r.qty !== null && r.qty > 0n ? amountOfUnits(perUnit, r.qty) : null;
      const bp = ratioBpOf(perUnit, r.plan);
      out.findings.push(
        base(
          input,
          QUOTE_CODES.B4_PRICE_OVER_CONTROL,
          QUOTE_LEVEL.HIGH,
          'totalItem',
          r.key,
          `${r.label} 成交单价超控制价 ${yuan(perUnit)} 元/单位`,
          [
            `成交单价 ${yuan(deal)} 元，控制价 ${yuan(r.plan)} 元${bp === null ? '' : `（高 ${fmtBp(bp)}）`}`,
            `数量 ${r.qty === null ? '(未填)' : String(Number(r.qty) / 10_000)}，合计多出 ${total === null ? '(数量未填，无法合计)' : `${yuan(total)} 元`}`,
            '单项超控制价需说明理由（规格变更、市场涨价），或按控制价重新议价',
          ],
          total ?? perUnit,
        ),
      );
    }
    const ref = r.market !== null && r.market > 0n ? r.market : r.info !== null && r.info > 0n ? r.info : null;
    const refName = r.market !== null && r.market > 0n ? '市场价' : '信息价';
    if (ref === null) continue;
    const devBp = ratioBpOf(deal - ref, ref);
    if (devBp === null || Math.abs(devBp) <= tol.priceDevPct * QUOTE_PCT) continue;
    const total = r.qty !== null && r.qty > 0n ? amountOfUnits(deal - ref, r.qty) : null;
    out.findings.push(
      base(
        input,
        QUOTE_CODES.B4_PRICE_VS_MARKET,
        QUOTE_LEVEL.MEDIUM,
        'totalItem',
        r.key,
        `${r.label} 成交单价比${refName}${devBp > 0 ? '高' : '低'} ${fmtBp(Math.abs(devBp))}`,
        [
          `成交单价 ${yuan(deal)} 元，${refName} ${yuan(ref)} 元`,
          `偏离 ${fmtBp(Math.abs(devBp))}，阈值 ${fmtBp(tol.priceDevPct * QUOTE_PCT)}`,
          `按数量折算合计${devBp > 0 ? '多支出' : '少支出'} ${total === null ? '(数量未填，无法合计)' : `${yuan(total < 0n ? -total : total)} 元`}`,
          '偏离幅度过大时复核价格来源：询价记录、信息价发布期次、市场价取价口径',
        ],
        total ?? (deal - ref),
      ),
    );
  }
  return out;
}

// ------------------------------------------------------------------ B5 税率

const isLegalTaxRate = (rateBp: number, toleranceBp: number): boolean =>
  LEGAL_TAX_RATE_PCT.some((pct) => Math.abs(rateBp - pct * QUOTE_PCT) <= toleranceBp);

/**
 * B5：税金与不含税总额的税率自洽性。
 * 常用税率集合来自 `LEGAL_TAX_RATE_PCT`（0/1/3/5/6/9/11/13），容差默认 0.30 个百分点。
 */
export function b5TaxAnomalies(input: QuoteTaskInput, tol: QuoteTolerances): QuoteRuleResult {
  const out = empty();
  let checked = 0;
  const legalText = `${LEGAL_TAX_RATE_PCT.join('/')}%`;
  for (const b of input.bidders) {
    const rounds: Array<{ label: string; pre: Cents | null; tax: Cents | null }> = [
      { label: '第一轮', pre: bidderFirstCents(b), tax: moneyToCents(b.firstTax) },
      { label: '第二轮', pre: bidderSecondCents(b), tax: moneyToCents(b.secondTax) },
    ];
    const rates: Array<{ label: string; rateBp: number }> = [];
    for (const r of rounds) {
      const rateBp = taxRateBpOf(r.pre, r.tax);
      if (rateBp === null) continue;
      checked += 1;
      rates.push({ label: r.label, rateBp });
      if (!isLegalTaxRate(rateBp, tol.taxRateToleranceBp)) {
        out.findings.push(
          base(
            input,
            QUOTE_CODES.B5_TAX_RATE_INVALID,
            QUOTE_LEVEL.MEDIUM,
            'bidder',
            b.id,
            `${nameOf(b)} ${r.label}税率 ${fmtBp(rateBp)} 不在常用税率集合`,
            [
              `${r.label}：不含税 ${yuan(r.pre as Cents)} 元，税额 ${yuan(r.tax as Cents)} 元 → 税率 ${fmtBp(rateBp)}`,
              `常用税率 ${legalText}，容差 ${fmtBp(tol.taxRateToleranceBp)}`,
              '税金与不含税总额不自洽：复核税率取值、是否含税价误填为不含税价',
            ],
          ),
        );
      }
    }
    if (rates.length === 2) {
      const drift = Math.abs(rates[0].rateBp - rates[1].rateBp);
      if (drift > tol.taxRateToleranceBp) {
        out.findings.push(
          base(
            input,
            QUOTE_CODES.B5_TAX_RATE_DRIFT,
            QUOTE_LEVEL.MEDIUM,
            'bidder',
            b.id,
            `${nameOf(b)} 两轮税率不一致（${fmtBp(rates[0].rateBp)} → ${fmtBp(rates[1].rateBp)}）`,
            [
              `第一轮税率 ${fmtBp(rates[0].rateBp)}，第二轮税率 ${fmtBp(rates[1].rateBp)}，差 ${fmtBp(drift)}`,
              '两轮口径混用（如一轮按 13%、二轮按 9%）：核对合同适用税率与报价说明',
            ],
          ),
        );
      }
    }
  }
  if (checked === 0) {
    out.notEvaluated.push(`B5 未判定：${taskNoOf(input)} 没有同时填了不含税总额与税金的报价行`);
  }
  return out;
}

// -------------------------------------------------------------- B6 定标合理性

/** B6：中标价高于同任务最低有效报价 —— 不必然是错误（技术/工期/服务差异），所以只标「需复核」并要理由 */
export function b6NotLowest(input: QuoteTaskInput, tol: QuoteTolerances): QuoteRuleResult {
  const out = empty();
  const winner = winnerOf(input.bidders);
  if (!winner) {
    out.notEvaluated.push(`B6 未判定：${taskNoOf(input)} 尚未定标（没有 WON 单位）`);
    return out;
  }
  const winTotal = bidderTotalCents(winner);
  if (winTotal === null || winTotal <= 0n) {
    out.notEvaluated.push(
      `B6 未判定：${taskNoOf(input)} 中标单位 ${nameOf(winner)} 没有可用报价`,
    );
    return out;
  }
  const others: Array<{ name: string; cents: Cents }> = [];
  for (const b of input.bidders) {
    if (b.id === winner.id || !isCountedBidder(b)) continue;
    const c = bidderTotalCents(b);
    if (c === null || c <= 0n) continue;
    others.push({ name: nameOf(b), cents: c });
  }
  if (others.length === 0) {
    out.notEvaluated.push(`B6 未判定：${taskNoOf(input)} 除中标单位外没有其他有效报价`);
    return out;
  }
  const lowest = others.reduce((a, b) => (b.cents < a.cents ? b : a));
  const diff = winTotal - lowest.cents;
  if (diff <= tol.amount) return out;
  const bp = ratioBpOf(diff, lowest.cents);
  out.findings.push(
    base(
      input,
      QUOTE_CODES.B6_NOT_LOWEST,
      QUOTE_LEVEL.MEDIUM,
      'bidder',
      winner.id,
      `成交价高于最低有效报价 ${yuan(diff)} 元`,
      [
        `中标单位 ${nameOf(winner)}：${yuan(winTotal)} 元`,
        `最低有效报价 ${lowest.name}：${yuan(lowest.cents)} 元${bp === null ? '' : `（高 ${fmtBp(bp)}）`}`,
        '非最低价定标可以成立（技术、工期、业绩、服务差异），但须在定标记录中写明理由与评审依据',
      ],
      diff,
    ),
  );
  return out;
}

// ------------------------------------------------------------ B7 参标完整性

/** B7：有效报价家数下限、以及「中标单位却没有报价」这种数据缺口 */
export function b7Completeness(input: QuoteTaskInput, tol: QuoteTolerances): QuoteRuleResult {
  const out = empty();
  const counted = input.bidders.filter(isCountedBidder);
  if (input.bidders.length === 0) {
    out.notEvaluated.push(`B7 未判定：${taskNoOf(input)} 还没有导入响应单位`);
    return out;
  }
  if (counted.length < tol.minBidders) {
    out.findings.push(
      base(
        input,
        QUOTE_CODES.B7_FEW_BIDDERS,
        QUOTE_LEVEL.MEDIUM,
        'task',
        input.task.id,
        `有效报价仅 ${counted.length} 家，低于下限 ${tol.minBidders} 家`,
        [
          `计入有效报价：${counted.length === 0 ? '(无)' : counted.map((b) => nameOf(b)).join('、')}`,
          `导入响应单位 ${input.bidders.length} 家，下限 ${tol.minBidders} 家`,
          '家数不足影响竞争充分性：核对是否重新公告、是否按单一来源审批',
        ],
      ),
    );
  }
  const winner = winnerOf(input.bidders);
  if (winner) {
    const total = bidderTotalCents(winner);
    if (total === null || total <= 0n) {
      out.findings.push(
        base(
          input,
          QUOTE_CODES.B7_WINNER_NO_PRICE,
          QUOTE_LEVEL.MEDIUM,
          'bidder',
          winner.id,
          `中标单位 ${nameOf(winner)} 没有可用报价`,
          [
            `本任务有效报价 ${counted.length} 家，导入响应单位 ${input.bidders.length} 家`,
            '定标只写最终确认价；该单位最终确认价、第二轮、第一轮均为空',
            '生成合同需要中标金额：核对导入表报价列是否漏填，或定标时是否漏写最终确认价',
          ],
        ),
      );
    }
  }
  return out;
}

// ------------------------------------------------------------------ 汇总

export function sortFindings(findings: QuoteFinding[]): QuoteFinding[] {
  const levelRank: Record<QuoteLevel, number> = { HIGH: 0, MEDIUM: 1 };
  return [...findings].sort(
    (a, b) =>
      levelRank[a.level] - levelRank[b.level] ||
      a.code.localeCompare(b.code) ||
      a.taskNo.localeCompare(b.taskNo) ||
      a.entityId.localeCompare(b.entityId),
  );
}

export function summarizeQuoteFindings(findings: QuoteFinding[]): QuoteSummary {
  const byCode: Record<string, number> = {};
  let high = 0;
  let medium = 0;
  for (const f of findings) {
    byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    if (f.level === QUOTE_LEVEL.HIGH) high += 1;
    else medium += 1;
  }
  return { total: findings.length, high, medium, byCode };
}

/**
 * 全部任务跑一遍。`tolerances` 优先取任务级，其次全局，最后默认值。
 * 单条规则抛出异常不应让整个扫描失败（一条坏数据不该让财务看不到其他异常）。
 */
export function evaluateQuoteAnomalies(input: QuoteInput): QuoteEvaluation {
  const findings: QuoteFinding[] = [];
  const notEvaluated: string[] = [];
  const tasks = [...input.tasks].sort((a, b) => taskNoOf(a).localeCompare(taskNoOf(b)));
  for (const task of tasks) {
    const tol = resolveQuoteTolerances(task.tolerances ?? input.tolerances);
    const rules = [
      b1DropAnomalies,
      b2SpreadAnomalies,
      b3BudgetAnomalies,
      b4UnitPriceAnomalies,
      b5TaxAnomalies,
      b6NotLowest,
      b7Completeness,
    ];
    for (const rule of rules) {
      try {
        const r = rule(task, tol);
        findings.push(...r.findings);
        notEvaluated.push(...r.notEvaluated);
      } catch (e) {
        // 失败要说出来，不能静默：先在未判定里点名规则，再由上层决定是否告警
        notEvaluated.push(
          `规则执行失败：${taskNoOf(task)} ${rule.name} —— ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  const sorted = sortFindings(findings);
  return { findings: sorted, summary: summarizeQuoteFindings(sorted), notEvaluated };
}

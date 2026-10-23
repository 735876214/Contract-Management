/**
 * AI 预警面板 · **「到底查没查清楚」判定**。
 *
 * 三个预警面板（结算/报价/履约）此前都只在 `summary.total === 0` 时亮绿「未发现命中」。
 * 但 total 为 0 有三种完全不同的处境：
 *   ① 规则全跑了、数据齐全 → 真的没问题（该亮绿）；
 *   ② 有规则因数据缺失没跑 → 那部分单据**等于没检查**；
 *   ③ 样本为 0（区间内没有单据）或预警被停用 → **一条都没查**。
 * ②③ 亮绿就是给看板喂安慰剂：用户看到绿色就走开了。
 * 所以绿色只留给 ①，其余一律黄灯并说明原因。
 */

export interface CoverageInput {
  enabled: boolean;
  sample?: Record<string, number> | null;
  notEvaluated: string[];
}

export interface CoverageState {
  /** true 才能说「查过，没问题」 */
  ok: boolean;
  /** 样本计数合计 */
  sampled: number;
  /** 黄灯原因（ok 为 true 时为空串） */
  reason: string;
}

export function coverageState(result: CoverageInput): CoverageState {
  const sampled = Object.values(result.sample ?? {}).reduce((acc, v) => {
    const n = Number(v ?? 0);
    return acc + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);

  if (!result.enabled) {
    return { ok: false, sampled, reason: '预警已在系统参数中停用，本次未执行任何规则。' };
  }
  if (sampled === 0) {
    return { ok: false, sampled, reason: '所选范围内没有任何可用数据，规则未执行。' };
  }
  if (result.notEvaluated.length > 0) {
    return {
      ok: false,
      sampled,
      reason: `仍有 ${result.notEvaluated.length} 条规则未判定（见上），这部分单据等于没检查。`,
    };
  }
  return { ok: true, sampled, reason: '' };
}

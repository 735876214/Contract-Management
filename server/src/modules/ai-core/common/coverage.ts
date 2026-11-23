/**
 * AI 预警 · **数据覆盖度原语**。
 *
 * 面板的「绿色通过」必须同时满足两件事：规则真的跑过、且每条规则真的判得出来。
 * 只有 `notEvaluated` 为空还不够——**样本为 0 时规则根本没跑**，此时 `findings` 为空
 * 与「查过没问题」长得一模一样，面板绿光一亮，看板就成了安慰剂。
 *
 * 因此各 service 在返回前统一调用本函数判断「这一轮到底有没有数据」。
 */

/** 样本计数的总和（`{ 合同: 3, 结算单: 0 }` → 3） */
export function sampleTotal(sample: Record<string, number> | null | undefined): number {
  let total = 0;
  for (const v of Object.values(sample ?? {})) {
    const n = Number(v ?? 0);
    if (Number.isFinite(n) && n > 0) total += n;
  }
  return total;
}

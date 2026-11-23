/**
 * 「按页取全量」的唯一实现（导出 / 汇总 / 下拉等需要完整结果集的场景）。
 *
 * 为什么要有它：`paginate()` 会把单页 `take` 夹到上限（默认 500/2000/5000），
 * 而各模块原先都写成 `findAll({ pageSize: 2000 })` 直接拿一次结果 —— 超过上限的部分
 * 不会出现在任何一页里，导出文件与汇总金额**静默**缺数据，接口里也没有任何截断提示。
 * 这类缺陷在 2026-10 的审计里在付款/结算台账/日报/发票/台账/还款/资产/物资 **8 个模块**
 * 各出现了一次，根因就是没有单一实现。新增导出/汇总请直接用本函数，不要再手写循环。
 *
 * 契约：
 * - `fetchPage(page, pageSize)` 返回 `{ list, total? }`；`total` 用于提前结束（省一次空查询）。
 * - 某页返回不足 `pageSize` 或累计达到 `total` 即停止；`maxPages` 是防空转的保险丝。
 *
 * ⚠️ 调用方的分页参数必须同时把 `pageSize` 与后端单页上限对齐，
 * 例如 `findAll({ page, pageSize }, projectId, pageSize)`——只传 `page` 不传 `pageSize`
 * 会让每页退回默认 20 条，虽然结果仍正确但会多跑几十次查询。
 */
export interface PageResult<T> {
  list: T[];
  total?: number;
}

export async function pagedAll<T>(
  fetchPage: (page: number, pageSize: number) => Promise<PageResult<T>>,
  pageSize = 500,
  maxPages = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetchPage(page, pageSize);
    const list = (res?.list ?? []) as T[];
    out.push(...list);
    // 最后一页：不足一页即到底（total 缺失时也能正确终止）
    if (list.length < pageSize) break;
    if (typeof res?.total === 'number' && out.length >= res.total) break;
  }
  return out;
}

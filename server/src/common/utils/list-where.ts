import { startOfDay, endOfDay } from '../calc/time.ts';

/**
 * 列表查询的公共 where 片段（2026-11-22 质量审计：20 个 service 各写一份）。
 *
 * 只收「语义已经定死、写法却漂移」的两类条件：日期区间与关键字。字段白名单仍由各模块自己给，
 * 因为这些字段是业务口径（搜哪些列属于产品决策，不该被工具层猜）。
 */

/**
 * 日期区间：两端都非法/为空 → 返回 null（调用方**不要**把 null 写进 where）。
 * 边界语义在 `common/calc/time`：左 = 当天本地零点，右 = 当天本地最后一毫秒（含当天）。
 */
export function dateRange(startDate: unknown, endDate: unknown): { gte?: Date; lte?: Date } | null {
  const gte = startOfDay(startDate);
  const lte = endOfDay(endDate);
  if (!gte && !lte) return null;
  const range: { gte?: Date; lte?: Date } = {};
  if (gte) range.gte = gte;
  if (lte) range.lte = lte;
  return range;
}

/**
 * 关键字模糊匹配（任一字段命中即算）：空关键字返回 null。
 * 用法：`const kw = keywordWhere([{ name: true }, { code: true }], query.keyword);
 *        if (kw) and.push(kw);`  —— 传字段名数组即可，`contains` 会按字段展开。
 */
export function keywordWhere(fields: readonly string[], keyword: unknown): any | null {
  const kw = String(keyword ?? '').trim();
  if (!kw || !fields.length) return null;
  return { OR: fields.map((f) => ({ [f]: { contains: kw } })) };
}

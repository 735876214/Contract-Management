/**
 * 分组求和的 SQL 侧实现（P1-4：把「整项目明细行取回内存再 reduce」改成数据库聚合）。
 *
 * 只放「Prisma 的 \`_sum\` 表达不了、但又必须与既有口径逐位一致」的那几个聚合，
 * 别把这里做成通用查询层：口径逻辑仍然属于 \`calc/aggregate.ts\`。
 */
import type { PrismaClient } from '@prisma/client';
import { num } from '../calc/numeric.ts';

/** 聚合的分组维度（必须是被聚合表自己的列，才能走 groupBy） */
export type SumScope = 'projectId' | 'contractId';

/**
 * 结算单金额的分组求和 —— 口径 = 台账/合同链/看板全线的「审定额」= \`actualAmount ?? amount\`。
 *
 * ## 为什么要两次 groupBy
 *
 * Prisma 的 \`_sum\` 无法表达 \`COALESCE\`：\`_sum: { actualAmount, amount }\` 得到的是两列各自的和，
 * 而口径要的是**逐行**先取 \`actualAmount ?? amount\` 再求和（两者在「部分行填了审定、部分行没有」时不等）。
 * 把行取回内存当然能算对，但那正是 P1-4 要消灭的「整项目明细行常驻内存」。
 *
 * 所以拆成两组互斥的行分别求和：
 * - \`actualAmount IS NOT NULL\` → 取 \`SUM(actualAmount)\`；
 * - \`actualAmount IS NULL\` → 取 \`SUM(amount)\`（null 视为 0，与 \`num() || 0\` 一致）。
 *
 * \`actualAmount\` 是 \`Decimal?\`，库里只可能是数值或 NULL（不存在空串），
 * 因此这与 \`calc/aggregate.ts\` 的 \`settlementAmountOf(row, 'actual')\` 完全等价。
 *
 * @returns 分组键 → 金额（两位小数）。**分组键为 null 的行被丢弃**（无归属的脏数据，不计入任何分组）。
 */
export async function sumSettlementAmount(
  prisma: PrismaClient,
  scope: SumScope,
  where: Record<string, unknown>,
): Promise<Map<string, number>> {
  const [withActual, withoutActual] = await Promise.all([
    // groupBy 的 \`by\` 是字面量类型，动态列名只能在此处放宽一次（与本仓既有用法一致）
    (prisma.settlement.groupBy as any)({
      by: [scope],
      where: { ...where, actualAmount: { not: null } },
      _sum: { actualAmount: true },
    }) as Promise<Array<Record<string, any>>>,
    (prisma.settlement.groupBy as any)({
      by: [scope],
      where: { ...where, actualAmount: null },
      _sum: { amount: true },
    }) as Promise<Array<Record<string, any>>>,
  ]);

  const out = new Map<string, number>();
  const add = (key: unknown, value: unknown) => {
    const k = key == null ? '' : String(key);
    if (!k) return;
    out.set(k, (out.get(k) ?? 0) + (num(value) ?? 0));
  };
  for (const g of withActual) add(g[scope], g._sum?.actualAmount);
  for (const g of withoutActual) add(g[scope], g._sum?.amount);
  return out;
}

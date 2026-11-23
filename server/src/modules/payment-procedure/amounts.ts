/**
 * 付款手续单据上的「开累」四个数字与编号候选 —— 纯函数，供 service 调用与 spec 锁定。
 *
 * 为什么单独成文件：这四个数字是**单据留痕**（编制当时的快照），口径错一位就会让单据与台账对不上，
 * 而 service 里全是 Prisma 调用、单测跑不起来。抽出来后 spec 能直接锁住舍入与负值语义。
 */
import { round2 } from '../../common/calc/money.ts';

/**
 * 开累结算 / 开累付款 / 未付款。
 *
 * - 三值都按 2 位舍入后再相减：否则 A-B 会带出 0.0000000001 之类的尾数；
 * - **未付款允许为负**：付款超过结算额时它就是负数——那是该被看见的数据异常，不抹平（与台账三态一致）；
 * - 入参为空按 0（chain 合计在无数据时给 0 或 null，都视作 0）。
 */
export function deriveProcedureAmounts(
  settled: number | null | undefined,
  paid: number | null | undefined,
): { settleCumAmount: number; paidCumAmount: number; unpaidAmount: number } {
  const settleCumAmount = round2(settled ?? 0);
  const paidCumAmount = round2(paid ?? 0);
  return { settleCumAmount, paidCumAmount, unpaidAmount: round2(settleCumAmount - paidCumAmount) };
}

/**
 * 编号候选：`FK-<合同编号>-<YYYYMMDD>`，第 1 个无后缀，其后 `-2`、`-3` …（上限 max）。
 * 逐条试到不重复为止——真正的唯一性由表上的 `@@unique([projectId, code])` 兜底。
 */
export function* procedureCodeCandidates(
  contractCode: string | null | undefined,
  day: string,
  max = 20,
): Generator<string> {
  const base = `FK-${contractCode || 'HT'}-${day}`;
  for (let i = 0; i < max; i += 1) yield i === 0 ? base : `${base}-${i + 1}`;
}

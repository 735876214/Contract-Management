import { num } from '@cms/calc/numeric';

/**
 * **合同接口的金额 JSON 口径：一律 number**（2026-11-24 收口）。
 *
 * 起因：`/contracts` 直接把 Prisma `Decimal` 原样下发，JSON 里是 **string**（`"500000"`），
 * 而台账 `/ledger/contracts` 过了 `num()` 给的是 number（`500000`）——同一个系统同一类字段两种类型，
 * 前端每个用合同金额的地方都得先 `Number()`，漏一处就是「字符串相加」式的隐性 bug。
 * 本文件把「合同域对外金额一律 number」收成一处实现，由 `contract.service` 的读路径统一调用。
 *
 * 口径：
 * - `null` 保持 `null`（**未填 ≠ 0**）；
 * - 只转**已知的金额/比率列**，不动其它字段（避免把 `formData` 之类文本误转）；
 * - `ext`（ContractExt）里的两个比例列同口径处理。
 * - 幂等：已经是 number 的再转一次仍相等。
 */
const CONTRACT_DECIMAL_FIELDS = [
  'amount',
  'taxRatePct',
  'changeAmount',
  'changeQty',
  'monthlyRate',
  'interestCapRatio',
] as const;

const CONTRACT_EXT_DECIMAL_FIELDS = ['currentPayRatio', 'settlementPayRatio'] as const;

/** 把合同行的 Decimal 列转成 number（`null` 保持 `null`）。 */
export function normalizeContractDecimals<T extends Record<string, any>>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  const out: Record<string, any> = { ...row };
  for (const key of CONTRACT_DECIMAL_FIELDS) {
    if (key in out) out[key] = out[key] === null ? null : num(out[key]);
  }
  if (out.ext && typeof out.ext === 'object') {
    const ext = { ...out.ext };
    for (const key of CONTRACT_EXT_DECIMAL_FIELDS) {
      if (key in ext) ext[key] = ext[key] === null ? null : num(ext[key]);
    }
    out.ext = ext;
  }
  return out as T;
}

/**
 * 精确乘积，返回 number。任一入参空/非法返回 null（不臆造 0）。
 * digits 为最终保留的小数位；舍入沿用 money.round 的「半值远离零」口径。
 */
export declare function mulDecimal(a: unknown, b: unknown, digits?: number): number | null;
/** 合价 = 单价 × 数量，默认按金额 2 位舍入；空值按 0 处理 */
export declare function calcAmount(price: unknown, qty: unknown, digits?: number): number;
/** 含税单价 = 税前单价 × (1 + 税率百分数/100)；任一入参缺失返回 null（不臆造 0） */
export declare function calcPriceWithTax(priceBeforeTax: unknown, taxPct: unknown, digits?: number): number | null;
/** 含税合价 = 含税单价 × 数量；任一入参缺失返回 null */
export declare function calcTotalWithTax(priceWithTax: unknown, qty: unknown, digits?: number): number | null;
/**
 * 「税前 × (1 + 税率)」与「含税」的差额（含税 − 应为的含税，2 位）。
 *
 * 用途：发票的税前/税率/含税是三个自由输入字段（交互式录入与导入都不重算），
 * 任一被手改就会出现「税前 × 1.13 ≠ 含税」的票面不自洽（第 24 轮审计：
 * 08812678 差 598.99，进项税额随之多算 598.99 并流入合同台账）。
 *
 * 返回 `null` = **无法判定**（含税或税率缺失——历史票/导入票允许缺税率，不能当错拦下）；
 * 返回数字 = 实际差额，调用方按容差（默认 1 分）决定是否拦。
 */
export declare function taxAmountDiff(beforeTax: unknown, taxPct: unknown, withTax: unknown, digits?: number): number | null;
/** 逐项累加并在每一步舍入（与采购价格对比表表底汇总口径一致），避免浮点尾差累积 */
export declare function sumRounded(values: Array<number | null | undefined>, digits?: number): number;

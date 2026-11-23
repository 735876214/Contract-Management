/** 金额：千分位 + 2 位小数；空值返回空串（0 正常显示 0.00） */
export declare function fmtAmount(v: unknown): string;
/** 数量：整数原样、小数去掉多余的 0；空值返回空串 */
export declare function fmtQty(v: unknown): string;
/** 比率：百分比保留 2 位小数；入参本身已是百分数数值（12.34 → 12.34%） */
export declare function fmtRate(v: unknown, digits?: number): string;
/** 万元金额格式：与 fmtAmount 同口径 */
export declare const fmtWan: typeof fmtAmount;

/** 占比（%）= numerator / denominator × 100；分母为 0 返回 0（沿用 helpers.ratio 口径） */
export declare function ratio(numerator: unknown, denominator: unknown): number;
/** 差额比率（%）=（基准 − 成交）/ 基准 × 100；基准缺失或为 0 → null（表示不可计算） */
export declare function calcRateNullable(base: unknown, deal: unknown): number | null;

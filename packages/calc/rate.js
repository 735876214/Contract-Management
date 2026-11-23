"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ratio = ratio;
exports.calcRateNullable = calcRateNullable;
/**
 * 比率计算（零依赖，前后端共用）。
 *
 * 税率全站单轨为百分数（13 = 13%，字段名统一 taxRatePct），不再有小数↔百分数双轨，
 * 因此旧的双轨换算函数 rateToPct/pctToRate 已删除。本文件只保留通用占比计算。
 */
const money_1 = require("./money");
const numeric_1 = require("./numeric");
/** 占比（%）= numerator / denominator × 100；分母为 0 返回 0（沿用 helpers.ratio 口径） */
function ratio(numerator, denominator) {
    const d = (0, numeric_1.num)(denominator);
    if (!d)
        return 0;
    return (0, money_1.round2)((((0, numeric_1.num)(numerator) ?? 0) / d) * 100);
}
/** 差额比率（%）=（基准 − 成交）/ 基准 × 100；基准缺失或为 0 → null（表示不可计算） */
function calcRateNullable(base, deal) {
    const b = (0, numeric_1.num)(base);
    const d = (0, numeric_1.num)(deal);
    if (b === null || b === 0 || d === null)
        return null;
    return (0, money_1.round2)(((b - d) / b) * 100);
}

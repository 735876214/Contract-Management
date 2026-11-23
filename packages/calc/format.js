"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fmtWan = void 0;
exports.fmtAmount = fmtAmount;
exports.fmtQty = fmtQty;
exports.fmtRate = fmtRate;
/**
 * 展示层数值格式化（零依赖，前后端共用）。
 * 只负责"怎么显示"，任何参与落库/比较的数值必须先走 money.ts / amounts.ts 的原语。
 */
const numeric_1 = require("./numeric");
const money_1 = require("./money");
/** 金额：千分位 + 2 位小数；空值返回空串（0 正常显示 0.00） */
function fmtAmount(v) {
    const n = (0, numeric_1.num)(v);
    if (n === null)
        return '';
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** 数量：整数原样、小数去掉多余的 0；空值返回空串 */
function fmtQty(v) {
    const n = (0, numeric_1.num)(v);
    return n === null ? '' : String(n);
}
/** 比率：百分比保留 2 位小数；入参本身已是百分数数值（12.34 → 12.34%） */
function fmtRate(v, digits = 2) {
    const n = (0, numeric_1.num)(v);
    if (n === null)
        return '';
    const r = (0, money_1.round)(n, digits);
    if (r === null)
        return '';
    return `${r.toFixed(digits)}%`;
}
/** 万元金额格式：与 fmtAmount 同口径 */
exports.fmtWan = fmtAmount;

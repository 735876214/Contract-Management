"use strict";
/**
 * Decimal / 表单字符串 → number 的统一入口（零依赖，前后端共用）。
 * Prisma Decimal 经 JSON 序列化后是字符串，前端函数签名即便写 number 也常收到字符串，
 * 因此禁止在各模块手写 Number() / parseFloat() / `|| 0` 混用。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.numOrNull = void 0;
exports.num = num;
exports.sum = sum;
function num(v) {
    if (v === null || v === undefined || v === '')
        return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}
/** 语义别名：强调"取不到就是没有"，不是 0 */
exports.numOrNull = num;
/** 求和，忽略空值（保留 helpers.sum 的既有口径） */
function sum(list, pick) {
    return list.reduce((acc, item) => acc + (num(pick(item)) || 0), 0);
}

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mulDecimal = mulDecimal;
exports.calcAmount = calcAmount;
exports.calcPriceWithTax = calcPriceWithTax;
exports.calcTotalWithTax = calcTotalWithTax;
exports.taxAmountDiff = taxAmountDiff;
exports.sumRounded = sumRounded;
/**
 * 金额计算原语（零依赖，前后端共用）。
 *
 * 收敛此前散落在合同清单 / 物资 / 收领单 / 结算 / 采购各阶段的重复公式：
 * - 含税单价 = 税前单价 × (1 + 税率百分数 / 100)
 * - 含税合价 = 单价 × 数量
 * 精度由调用方显式传入（合同清单 4 位、收领单总价 2 位、结算合价 2 位），
 * 但舍入实现只有 money.ts 一份。
 */
const money_1 = require("./money");
const numeric_1 = require("./numeric");
/** 把任意数值归一为 { 符号, 整数尾数, 小数位数 }；空/非法返回 null */
function decimalOf(value) {
    if (value === null || value === undefined)
        return null;
    // Decimal 对象 / number / string 统一转十进制字符串；避免 number 已丢精度时无从挽回，
    // 但调用方传入字符串或 Decimal 时这里能保住完整尾数。
    let s = String(value).trim();
    if (!s)
        return null;
    let sign = 1;
    if (s[0] === '-') {
        sign = -1;
        s = s.slice(1);
    }
    else if (s[0] === '+') {
        s = s.slice(1);
    }
    // 科学计数法：3e-7 / 1.2e+3 → 先拆指数，再并入 scale
    let exp = 0;
    const eIdx = s.search(/[eE]/);
    if (eIdx >= 0) {
        exp = Number(s.slice(eIdx + 1));
        if (!Number.isInteger(exp))
            return null;
        s = s.slice(0, eIdx);
    }
    const dot = s.indexOf('.');
    const intPart = dot >= 0 ? s.slice(0, dot) : s;
    const fracPart = dot >= 0 ? s.slice(dot + 1) : '';
    if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart))
        return null;
    if (!intPart && !fracPart)
        return null;
    const digitsStr = `${intPart || '0'}${fracPart}`;
    let mantissa = BigInt(digitsStr || '0');
    let scale = fracPart.length - exp;
    // 负指数位数超出尾数（如 5e-3 已在 fracPart，这里只处理 exp 带来的额外放大）
    if (scale < 0) {
        mantissa *= 10n ** BigInt(-scale);
        scale = 0;
    }
    if (mantissa === 0n)
        return { sign: 1, mantissa: 0n, scale: 0 };
    return { sign, mantissa, scale };
}
/**
 * 精确乘积，返回 number。任一入参空/非法返回 null（不臆造 0）。
 * digits 为最终保留的小数位；舍入沿用 money.round 的「半值远离零」口径。
 */
function mulDecimal(a, b, digits = 2) {
    const A = decimalOf(a);
    const B = decimalOf(b);
    if (!A || !B)
        return null;
    const product = A.mantissa * B.mantissa;
    if (product === 0n)
        return 0;
    const d = Math.max(0, Math.min(10, Math.trunc(digits)));
    const totalScale = A.scale + B.scale;
    // 先还原成带totalScale位小数的精确十进制字符串，再交给 round 完成半值远离零舍入。
    // 逐步构造，避免 Number(product) 在超大尾数时溢出。
    let s = product.toString();
    if (totalScale > 0) {
        if (s.length <= totalScale)
            s = '0'.repeat(totalScale - s.length + 1) + s;
        s = `${s.slice(0, s.length - totalScale)}.${s.slice(s.length - totalScale)}`;
    }
    else if (totalScale < 0) {
        s += '0'.repeat(-totalScale);
    }
    if (A.sign * B.sign < 0)
        s = `-${s}`;
    return (0, money_1.round)(Number(s), d);
}
/** 合价 = 单价 × 数量，默认按金额 2 位舍入；空值按 0 处理 */
function calcAmount(price, qty, digits = 2) {
    return mulDecimal(price, qty, digits) ?? 0;
}
/** 含税单价 = 税前单价 × (1 + 税率百分数/100)；任一入参缺失返回 null（不臆造 0） */
function calcPriceWithTax(priceBeforeTax, taxPct, digits = 4) {
    const price = (0, numeric_1.num)(priceBeforeTax);
    const pct = (0, numeric_1.num)(taxPct);
    if (price === null || pct === null)
        return null;
    return mulDecimal(price, 1 + pct / 100, digits);
}
/** 含税合价 = 含税单价 × 数量；任一入参缺失返回 null */
function calcTotalWithTax(priceWithTax, qty, digits = 4) {
    const price = (0, numeric_1.num)(priceWithTax);
    const q = (0, numeric_1.num)(qty);
    if (price === null || q === null)
        return null;
    return mulDecimal(price, q, digits);
}
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
function taxAmountDiff(beforeTax, taxPct, withTax, digits = 2) {
    const before = (0, numeric_1.num)(beforeTax);
    const pct = (0, numeric_1.num)(taxPct);
    const withT = (0, numeric_1.num)(withTax);
    if (before === null || pct === null || withT === null)
        return null;
    const expect = mulDecimal(before, 1 + pct / 100, digits);
    if (expect === null)
        return null;
    return (0, money_1.round)(withT - expect, digits);
}
/** 逐项累加并在每一步舍入（与采购价格对比表表底汇总口径一致），避免浮点尾差累积 */
function sumRounded(values, digits = 2) {
    return values.reduce((acc, v) => (0, money_1.round)(acc + (v ?? 0), digits) ?? acc, 0);
}

/**
 * 人民币金额中文大写转换（需求：{{合同额大写}}）
 *
 * 规则遵循财务票据规范（《正确填写票据和结算凭证的基本规定》）：
 * - 数字用「零壹贰叁肆伍陆柒捌玖」，单位用「拾佰仟万亿」，角分用「角分」。
 * - 无角分时以「整」收尾，如 123456.00 → 壹拾贰万叁仟肆佰伍拾陆元整。
 * - 有角无分时写作「X元Y角整」，如 1234.50 → 壹仟贰佰叁拾肆元伍角整。
 * - 有分无角时补「零」，如 1234.06 → 壹仟贰佰叁拾肆元零陆分。
 * - 中间连续零只保留一个「零」，如 1005 → 壹仟零伍元整；100000 → 壹拾万元整。
 * - 0 输出「零元整」。
 *
 * 说明：为避免浮点误差，先按分（两位小数）四舍五入后再转为整数字符串处理。
 */

const CN_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
/** 节内单位：个、拾、佰、仟 */
const CN_UNITS = ['', '拾', '佰', '仟'];
/** 节单位：万、亿、万亿 */
const CN_SECTIONS = ['', '万', '亿', '万亿'];

/** 把「分」为单位的非负整数金额（字符串）的整数部分转换为中文大写 */
function integerPartToChinese(intStr: string): string {
  const trimmed = intStr.replace(/^0+/, '');
  if (trimmed === '') return '';

  // 从右往左每 4 位分一节
  const sections: string[] = [];
  let rest = trimmed;
  while (rest.length > 0) {
    sections.unshift(rest.slice(-4));
    rest = rest.slice(0, -4);
  }

  const parts: string[] = [];
  const total = sections.length;

  sections.forEach((section, idx) => {
    const bigUnit = CN_SECTIONS[total - 1 - idx] ?? '';
    const sectionNum = parseInt(section, 10);
    if (sectionNum === 0) {
      // 整节为零：若前面已有内容且尚未以「零」结尾，补一个零占位
      if (parts.length > 0 && !parts[parts.length - 1].endsWith('零')) parts.push('零');
      return;
    }
    const digits = section.padStart(4, '0').split('').map((d) => parseInt(d, 10));
    let sectionText = '';
    let pendingZero = false;
    digits.forEach((d, i) => {
      const unit = CN_UNITS[3 - i];
      if (d === 0) {
        pendingZero = true;
        return;
      }
      // 节内出现跳位时需要补「零」，但节首的零不补（如 0001 万 → 壹万）
      if (pendingZero && sectionText !== '') sectionText += CN_DIGITS[0];
      pendingZero = false;
      sectionText += CN_DIGITS[d] + unit;
    });
    parts.push(sectionText + bigUnit);
  });

  return parts.join('').replace(/零+$/, '');
}

/**
 * 金额转中文大写。
 * @param input 金额（数字或数字字符串，允许带千分位逗号与货币符号）
 * @param options.empty 空值时的返回，默认 '零元整'
 */
export function toChineseAmount(input: number | string | null | undefined, options: { empty?: string } = {}): string {
  const emptyText = options.empty ?? '零元整';
  if (input === null || input === undefined || input === '') return emptyText;

  const raw = typeof input === 'string' ? input.replace(/[,¥￥\s]/g, '') : input;
  const value = Number(raw);
  if (!Number.isFinite(value)) return emptyText;

  const negative = value < 0;
  // 以「分」为单位的整数，规避浮点误差
  const cents = Math.round(Math.abs(value) * 100);
  if (cents === 0) return negative ? `负${emptyText}` : emptyText;

  const intStr = String(Math.floor(cents / 100));
  const jiao = Math.floor((cents % 100) / 10);
  const fen = cents % 10;

  const intPart = integerPartToChinese(intStr);

  let decimalPart = '';
  if (jiao === 0 && fen === 0) {
    decimalPart = '整';
  } else if (fen === 0) {
    decimalPart = `${CN_DIGITS[jiao]}角整`;
  } else if (jiao === 0) {
    decimalPart = `零${CN_DIGITS[fen]}分`;
  } else {
    decimalPart = `${CN_DIGITS[jiao]}角${CN_DIGITS[fen]}分`;
  }

  const body = `${intPart}元${decimalPart}`;
  return negative ? `负${body}` : body;
}

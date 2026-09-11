/**
 * 金额转中文大写（财务规范）
 * - 四舍五入到分
 * - 整数：X元整
 * - 有角无分：X元X角整
 * - 无角有分：X元零X分
 * - 有角有分：X元X角X分
 * - 零金额：零元整
 */
const DIGIT = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
// [组单位(元/万/亿/兆), 组内单位(拾/佰/仟)]
const UNIT: [string[], string[]] = [['', '万', '亿', '兆'], ['', '拾', '佰', '仟']];

/** 整数部分转中文大写（每 4 位一组，处理 万/亿/兆 与内部的零） */
function convertInteger(num: number): string {
  if (num === 0) return '';
  let str = '';
  let n = Math.floor(num);
  let i = 0;
  do {
    let p = '';
    const section = n % 10000;
    let temp = section;
    for (let j = 0; j < UNIT[1].length && temp > 0; j++) {
      p = DIGIT[temp % 10] + UNIT[1][j] + p;
      temp = Math.floor(temp / 10);
    }
    p = p.replace(/(零.)*零$/, '').replace(/^零/, '');
    str = p + (section !== 0 ? UNIT[0][i] : p ? '零' : '') + str;
    n = Math.floor(n / 10000);
    i++;
  } while (n > 0);
  return str.replace(/(零.)+/g, '零').replace(/^零/, '');
}

export function amountToChineseCapital(input: number | string | null | undefined): string {
  let n = typeof input === 'string' ? Number(input) : Number(input ?? 0);
  if (!Number.isFinite(n)) n = 0;
  // 四舍五入到分
  n = Math.round((n + Number.EPSILON) * 100) / 100;
  if (n === 0) return '零元整';

  const neg = n < 0;
  n = Math.abs(n);

  // 用整数「分」避免浮点误差
  const cents = Math.round(n * 100);
  const jiao = Math.floor(cents / 10) % 10;
  const fen = cents % 10;
  const intPart = Math.floor(cents / 100);

  const intStr = convertInteger(intPart);

  // 不足 1 元：不加「元」前缀，也不补前导「零」
  if (intPart === 0) {
    const sub = (jiao ? DIGIT[jiao] + '角' : '') + (fen ? DIGIT[fen] + '分' : '');
    return (neg ? '负' : '') + (sub || '零元整');
  }

  let frac: string;
  if (jiao === 0 && fen === 0) frac = '整';
  else if (jiao === 0 && fen !== 0) frac = '零' + DIGIT[fen] + '分';
  else if (jiao !== 0 && fen === 0) frac = DIGIT[jiao] + '角整';
  else frac = DIGIT[jiao] + '角' + DIGIT[fen] + '分';

  return (neg ? '负' : '') + intStr + '元' + frac;
}

/**
 * 金额转中文大写（财务规范，移植自服务端 common/utils/money.ts）
 * - 四舍五入到分；整数：X元整；零金额：零元整
 *
 * ⚠️ 与服务端 `server/src/common/utils/money.ts` 的 `amountToChineseCapital` **行为一致**
 * （2026-10-17 取样比对过 6 组值）。因 web 构建不宜跨包 import server 源码，两份副本并存；
 * 改动任何一侧必须同步另一侧并复核取值。
 */
const DIGIT = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const UNIT: [string[], string[]] = [['', '万', '亿', '兆'], ['', '拾', '佰', '仟']];

/** 单个 4 位组转中文（组内空位合并为一个「零」，不处理跨组补零） */
function sectionToChinese(section: number): string {
  const digits = String(section).padStart(4, '0').split('').map(Number);
  let out = '';
  let pendingZero = false;
  for (let j = 0; j < 4; j++) {
    const d = digits[j];
    if (d === 0) {
      pendingZero = true;
      continue;
    }
    if (pendingZero && out) out += '零';
    out += DIGIT[d] + UNIT[1][3 - j];
    pendingZero = false;
  }
  return out;
}

/**
 * 整数部分转中文大写（每 4 位一组，处理 万/亿/兆 与内部的零）。
 * 跨组补零是财务大写的关键：组值不足 4 位（如 10 万位为 0010）或中间整组为 0 时，
 * 组间必须出现一个「零」，否则 100005 会被读成「壹拾万伍」而不是「壹拾万零伍」。
 */
function convertInteger(num: number): string {
  if (num === 0) return '';
  let n = Math.floor(num);
  const sections: number[] = [];
  while (n > 0) {
    sections.push(n % 10000);
    n = Math.floor(n / 10000);
  }
  let out = '';
  let needZero = false;
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i];
    if (section === 0) {
      if (out) needZero = true;
      continue;
    }
    if (out && (needZero || section < 1000)) out += '零';
    out += sectionToChinese(section) + UNIT[0][i];
    needZero = false;
  }
  return out;
}

export function amountToChineseCapital(input: number | string | null | undefined): string {
  let n = typeof input === 'string' ? Number(input) : Number(input ?? 0);
  if (!Number.isFinite(n)) n = 0;
  n = Math.round((n + Number.EPSILON) * 100) / 100;
  if (n === 0) return '零元整';

  const neg = n < 0;
  n = Math.abs(n);

  const cents = Math.round(n * 100);
  const jiao = Math.floor(cents / 10) % 10;
  const fen = cents % 10;
  const intPart = Math.floor(cents / 100);

  const intStr = convertInteger(intPart);

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

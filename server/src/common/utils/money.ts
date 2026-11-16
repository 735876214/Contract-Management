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
  // 四舍五入到分（走 round()，与全站金额口径同一个实现；原式的 EPSILON 修正在 |n|≥2 时失效）
  n = round(n, 2) ?? 0;
  if (n === 0) return '零元整';

  const neg = n < 0;
  n = Math.abs(n);

  // 用整数「分」避免浮点误差（字符串位移：12.34 → "12.34e2" = 1234）
  const cents = Math.round(Number(String(n) + 'e2'));
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

/**
 * 金额四舍五入（模拟 Excel ROUND，避免浮点误差）。
 * null / undefined / 非有限值统一返回 null，调用方可用 ?? 0 兜底。
 *
 * **实现说明（2026-10-20 第 4 轮审计）**：原来是 `Math.round((n + Number.EPSILON) * p) / p`，
 * 而 `Number.EPSILON` 是**绝对量** 2.22e-16，只在 |n| < 1 时够用：
 * - `8.165 * 100 = 816.4999999999999`（该量级 ulp≈8.9e-16，补 EPSILON 无效）→ 得 8.16，Excel 给 8.17；
 * - `1234567.005 * 100 = 123456700.49999999` → 丢 1 分；
 * - 负数更糟：`Math.round` 向 +∞ 取整，`-1.005` 得 -1（应 -1.01），`-2.5` 得 -2 而 `2.5` 得 3（半值不对称）。
 *
 * 现在改成**字符串位移法**（`n.toString()` 已是能还原该 double 的最短十进制，位移后取整即人眼口径），
 * 并按符号取整，保证 `round(-x) === -round(x)`，与 Excel ROUND 的「半值远离零」一致。
 */
export function round(n: number | null | undefined, digits = 2): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  const d = Math.max(0, Math.min(10, Math.trunc(digits)));
  const neg = n < 0;
  const abs = Math.abs(n);
  const shifted = Number(`${abs}e${d}`);
  if (!Number.isFinite(shifted)) return n;
  const out = Number(`${Math.round(shifted)}e-${d}`);
  if (!Number.isFinite(out)) return n;
  return neg ? -out : out;
}

export const round2 = (n: number | null | undefined): number => round(n, 2) ?? 0;
export const round4 = (n: number | null | undefined): number => round(n, 4) ?? 0;

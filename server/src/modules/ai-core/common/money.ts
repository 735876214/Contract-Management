/**
 * AI 预警 · **金额/数量/比例原语（跨课题共用）**。
 *
 * 原属 `ai/anomaly/anomaly-types.ts`（课题 6-9）；M4（课题 3-9 报价与价差）要复用同一套
 * 「不让浮点碰钱」的解析/换算，故上提到 `ai/common/`。语义与常量一处维护，
 * `anomaly-types.ts` 用 `export * from '../common/money.ts'` 原样转出，既有 import 不受影响。
 */

/** 金额（分）。`bigint` 而非 number，见文件头 */
export type Cents = bigint;
/** 数量（1e-4 单位，对应 `Decimal(18,4)`） */
export type Units = bigint;

/** 数量的缩放位数：与 `schema.prisma` 的 `Decimal(18,4)` 同口径 */
export const QTY_SCALE = 4;
/** 金额的缩放位数：与 `Decimal(18,2)` 同口径 */
export const MONEY_SCALE = 2;

/**
 * 任意值 → 定点整数（`scale` 位小数），半进位。**不经浮点**。
 *
 * 接受 Prisma `Decimal`（有 `toString()`）、number、string（含千分位逗号）、bigint。
 * 空值/空串/非法输入 → `null`（**不是 0**：本仓库反复强调「未填 ≠ 0」，
 * 见 `ledger-derived.ts` 的三态契约；这里同样保留三态，由调用方决定跳过还是报错）。
 */
export function parseScaled(raw: unknown, scale: number): bigint | null {
  if (raw === null || raw === undefined) return null;
  let s: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    // number 只可能来自测试夹具/手写常量；先定点再看字符串，避免 1e-7 这类指数形式
    s = raw.toFixed(Math.min(scale + 2, 20));
  } else if (typeof raw === 'bigint') {
    s = raw.toString();
  } else if (typeof raw === 'string') {
    s = raw.trim();
  } else if (typeof (raw as any).toString === 'function') {
    s = String((raw as any).toString()).trim();
  } else {
    return null;
  }
  if (s === '') return null;
  s = s.replace(/,/g, '');
  const m = /^([+-])?(\d+)?(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const neg = m[1] === '-';
  const intPart = m[2] || '0';
  const frac = m[3] || '';
  // 多取一位用于半进位
  const padded = (frac + '0'.repeat(scale + 1)).slice(0, scale + 1);
  const keep = padded.slice(0, scale);
  const roundDigit = Number(padded.charAt(scale) || '0');
  let val = BigInt(intPart) * 10n ** BigInt(scale) + BigInt(keep === '' ? '0' : keep);
  if (roundDigit >= 5) val += 1n;
  return neg ? -val : val;
}

/** 金额 → 分（`Decimal(18,2)`）。空值 → `null` */
export const moneyToCents = (raw: unknown): Cents | null => parseScaled(raw, MONEY_SCALE);

/** 数量 → 1e-4 单位（`Decimal(18,4)`）。空值 → `null` */
export const qtyToUnits = (raw: unknown): Units | null => parseScaled(raw, QTY_SCALE);

/** 分 → 元字符串（两位小数，不用浮点；负数带 `-`） */
export function centsToYuan(cents: Cents): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const int = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${int.toString()}.${frac}`;
}

/** 1e-4 单位 → 数量字符串（四位小数，去掉尾零但不丢位） */
export function unitsToQty(units: Units): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const div = 10n ** BigInt(QTY_SCALE);
  const int = abs / div;
  const frac = (abs % div).toString().padStart(QTY_SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int.toString()}${frac ? '.' + frac : ''}`;
}

/**
 * 百分比 → 万分之一整数（基点）。`0.65` → `6500`，`65` 也按 0.65 之外的**另一种**语义处理？
 * 不：本仓库的付款比例字段（`ContractExt.currentPayRatio` / `settlementPayRatio`）是 **0..1 小数**，
 * 而界面上的「税率」是百分数（13 = 13%）。两者混用会差 100 倍，所以这里只接受 **0..1 小数**，
 * 超出 (0,1] 的值返回 `null` 由调用方当「口径未知」处理（宁可漏报，不许错报）。
 */
export function ratioToBp(raw: unknown): number | null {
  const scaled = parseScaled(raw, 4); // 万分之一
  if (scaled === null) return null;
  if (scaled <= 0n || scaled > 10_000n) return null;
  return Number(scaled);
}

/** 单价（分/单位）× 数量（1e-4 单位）→ 金额（分），半进位。用于「清单行 qty × 单价」 */
export function amountOfUnits(priceCents: Cents, qtyUnits: Units): Cents {
  const prod = priceCents * qtyUnits;
  const neg = prod < 0n;
  const abs = neg ? -prod : prod;
  const q = (abs + 5_000n) / 10_000n;
  return neg ? -q : q;
}

/** 绝对值（报告「超了多少」时用，方向由 finding 说明） */
export const absCents = (c: Cents): Cents => (c < 0n ? -c : c);

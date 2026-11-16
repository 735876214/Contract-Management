/**
 * 敏感字段打码（**零运行时依赖**，供操作日志拦截器与展示层共用）。
 *
 * 背景：操作日志拦截器会把请求参数、变更前后快照整体写入 `OperationLog`，而日志页
 * （`/system/log`，权限 `system:user`）可被非超管查看。2026-10-14 实测发现历史日志里：
 * - **35 条含明文 JWT**（`/api/auth/login` 的响应体被整体记录，而 token 有效期 7 天）；
 * - 2 条含明文银行账号、2 条含明文身份证号。
 * 当时唯一被处理的只有 `password` 三个键名。
 *
 * 设计：
 * - **白名单**驱动（`SECRET_FIELD_KEYS`）：只对明确列举的键名打码，避免误伤（如 `amount`）；
 * - **不改原对象**（返回深拷贝）：拦截器传进来的是「即将返回给前端的响应体」，就地改会把打码结果泄漏给前端；
 * - 与 `pickFields` 同一风格：纯函数、可单测（`server/test/mask.spec.mts`）。
 */

/** 打码方式 */
export type MaskKind = 'PASSWORD' | 'TOKEN' | 'BANK_ACCOUNT' | 'ID_NO' | 'PHONE' | 'EMAIL' | 'NAME';

/**
 * 敏感键白名单（**小写**键名 → 打码方式）。
 * 新增敏感字段时在此登记；键名以 Prisma 模型字段为准（见 `prisma/schema.prisma`）。
 */
export const SECRET_FIELD_KEYS: Record<string, MaskKind> = {
  // 凭据
  password: 'PASSWORD',
  oldpassword: 'PASSWORD',
  newpassword: 'PASSWORD',
  confirmpassword: 'PASSWORD',
  pwd: 'PASSWORD',
  token: 'TOKEN',
  accesstoken: 'TOKEN',
  refreshtoken: 'TOKEN',
  authorization: 'TOKEN',
  apikey: 'TOKEN',
  // 资金账号
  bankaccount: 'BANK_ACCOUNT',
  bankaccountno: 'BANK_ACCOUNT',
  accountno: 'BANK_ACCOUNT',
  // 证件号（Supplier.contractAuthIdNo / Subcontractor.authorizedPersonIdNo）
  idno: 'ID_NO',
  idnumber: 'ID_NO',
  contractauthidno: 'ID_NO',
  authorizedpersonidno: 'ID_NO',
  legalpersonidno: 'ID_NO',
  // 联系方式（User.phone / Supplier.legalPhone·contractAuthPhone·contactPhone 等）
  phone: 'PHONE',
  mobile: 'PHONE',
  legalphone: 'PHONE',
  contractauthphone: 'PHONE',
  contactphone: 'PHONE',
  contactphones: 'PHONE',
  tel: 'PHONE',
  email: 'EMAIL',
  contactemail: 'EMAIL',
};

/** 命中白名单的键 → 打码方式；未登记返回 null（原样保留） */
export function maskKindOf(key: string): MaskKind | null {
  return SECRET_FIELD_KEYS[String(key ?? '').toLowerCase()] ?? null;
}

const keepTail = (s: string, n: number): string => (s.length <= n ? '*'.repeat(s.length) : `****${s.slice(-n)}`);

/** 按方式打码；空值原样返回（避免把 undefined 变成字符串） */
export function maskField(value: unknown, kind: MaskKind): string {
  const s = String(value ?? '');
  if (!s) return s;
  switch (kind) {
    case 'PASSWORD':
    case 'TOKEN':
      // 连长度都不暴露
      return '******';
    case 'BANK_ACCOUNT':
      return keepTail(s, 4);
    case 'ID_NO':
      // 身份证 18 位：保留前 6 后 4，中间打码；过短则只留后 4
      return s.length >= 10 ? `${s.slice(0, 6)}${'*'.repeat(s.length - 10)}${s.slice(-4)}` : keepTail(s, 4);
    case 'PHONE': {
      const digits = s.replace(/\D/g, '');
      // 位数不足（畸形值）走整体打码：不暴露任何片段
      if (digits.length < 7) return '******';
      return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
    }
    case 'EMAIL': {
      const at = s.indexOf('@');
      // 畸形值（无 @）走整体打码：不暴露任何片段
      if (at <= 0) return '******';
      const local = s.slice(0, at);
      const head = local.slice(0, Math.min(2, local.length));
      return `${head}***${s.slice(at)}`;
    }
    case 'NAME':
      // 保留姓氏，其余打码（用于展示层）
      return s.length <= 1 ? s : `${s.slice(0, 1)}${'*'.repeat(s.length - 1)}`;
    default:
      return s;
  }
}

/** 按键名判断是否敏感；敏感则打码，否则原样返回 */
export function maskByKey(key: string, value: unknown): unknown {
  const kind = maskKindOf(key);
  if (!kind) return value;
  if (value === null || value === undefined || value === '') return value;
  if (Array.isArray(value)) return value.map((v) => (v == null || v === '' ? v : maskField(v, kind)));
  if (typeof value === 'object') return maskField('[object]', kind);
  return maskField(value, kind);
}

const MAX_DEPTH = 8;

/**
 * 深拷贝并对敏感键打码（**不改原对象**）。
 * 用于：① 日志写入前处理 `params` / `beforeData` / `afterData`；
 *       ② 将来做展示脱敏时处理响应体。
 * 非纯对象（Date / Buffer 等）原样返回；循环引用按原引用短路。
 */
export function slimSecrets<T>(input: T, depth = 0, seen?: WeakSet<object>): T {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (depth >= MAX_DEPTH) return input;

  const obj = input as unknown as Record<string, unknown>;
  const known = seen ?? new WeakSet<object>();
  if (known.has(obj)) return input;
  known.add(obj);

  if (Array.isArray(input)) {
    return input.map((v) => slimSecrets(v, depth + 1, known)) as unknown as T;
  }
  // Date / Buffer / 类实例：原样返回，避免破坏类型
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return input;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const masked = maskByKey(k, v);
    out[k] = masked === v ? slimSecrets(v, depth + 1, known) : masked;
  }
  return out as unknown as T;
}

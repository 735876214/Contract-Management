/**
 * 口令强度口径（2026-11-23 第 24 轮审计）。
 *
 * 起因：改密 / 重置密码只校验「长度 ≥ 6」，`123456` 直接通过；而 `admin / admin123`
 * 这类默认口令正是撞库的首选目标（登录节流能拖慢爆破，但拦不住弱口令本身）。
 *
 * 口径取「长度 ≥ 8 + 字母与数字都要有」：不引入特殊字符强制（企业内网用户常因此
 * 写在便签上），也不做历史口令比对（需要额外表，收益低于成本）。
 * 纯函数、零依赖：`.mts` 单测可直接加载。
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * 常见弱口令（小写比较，**精确匹配**）。
 *
 * 「8 位 + 字母数字」挡不住 `admin123` / `password1` 这类——它们恰好满足长度与字符要求，
 * 却排在每一份撞库字典的前 100 行。这里只列最常被扫的那一批（不做字典文件、不做模糊匹配：
 * 规则要一眼看懂、可预测，运维才不会踩到"我的口令为什么不行"）。
 */
export const WEAK_PASSWORDS: ReadonlySet<string> = new Set([
  'admin123',
  'admin1234',
  'admin@123',
  'administrator',
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwerty123',
  'qwertyuiop',
  'abc12345',
  'abcd1234',
  'a1234567',
  '12345678',
  '123456789',
  'cms12345',
  'welcome1',
  'letmein1',
]);

/** 返回不通过的原因（可直接展示给用户）；`null` = 通过 */
export function checkPasswordStrength(password: unknown): string | null {
  const s = String(password ?? '');
  if (!s) return '密码不能为空';
  if (s.length < PASSWORD_MIN_LENGTH) return `密码长度不能少于 ${PASSWORD_MIN_LENGTH} 位`;
  if (s.length > PASSWORD_MAX_LENGTH) return `密码长度不能超过 ${PASSWORD_MAX_LENGTH} 位`;
  if (!/[A-Za-z]/.test(s)) return '密码需包含字母（不能是纯数字）';
  if (!/\d/.test(s)) return '密码需包含数字';
  if (WEAK_PASSWORDS.has(s.toLowerCase())) return '这是常见弱口令，请换一个（如「项目缩写 + 随机数字」）';
  return null;
}

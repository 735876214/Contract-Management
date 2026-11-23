/**
 * 导入模板「状态」列的文本 → 0（停用）/ 1（启用）。
 *
 * 原实现是 `DISABLED_WORDS.includes(String(v ?? '').trim())`，**大小写敏感**：
 * 用户填 `Disabled` / `DISABLED` 会被当成「启用」，停用项导入后悄悄变成可用项。
 * 这里统一归一（去首尾空白 + 小写，`\\s` 已覆盖全角空格 U+3000），未识别按启用——与原行为一致，
 * 只修「写法不同就判错」这一类。
 */
const DISABLED_WORDS = new Set(['停用', '0', '禁用', 'false', '否', 'n', 'no', 'disabled']);

export function parseOtherProjectStatus(value: unknown): number {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return DISABLED_WORDS.has(text) ? 0 : 1;
}

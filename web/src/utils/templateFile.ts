/**
 * **模板文件地址的纯逻辑（前端）**——与后端 `server/src/modules/doc-template/doc-template-file.ts`
 * 的 `normalizeDocTemplateFileKey()` 保持同一口径（由 `docTemplateFile.spec.mts` 锁一致性）。
 *
 * 用途：
 * - `toStorageKey()`：上传接口返回 `url` 时取出相对键再落库（新接口也直接返回 `key`，二者等价）；
 * - `toFileUrl()`：展示/下载时把相对键补成一次 `/api/files/` 前缀——**只补一次**，
 *   历史上已存成公开 URL（甚至双前缀）的数据也能正确显示。
 */

const PREFIX = '/api/files/';

/** URL / 公开地址 / 相对键 → 存储相对键（与后端同语义） */
export function toStorageKey(raw?: string | null): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';

  s = s.replace(/\\/g, '/');

  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      // 解析失败按原串继续
    }
  }

  for (;;) {
    const i = s.indexOf(PREFIX);
    if (i < 0) break;
    s = s.slice(i + PREFIX.length);
  }

  s = s.split('?')[0].split('#')[0];

  const leadingSlash = s.startsWith('/');
  const cleaned = s
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
  return leadingSlash ? `/${cleaned}` : cleaned;
}

/** 相对键 / 历史 URL → 可访问的 `/api/files/<键>`（完整外链与 data/blob 原样返回） */
export function toFileUrl(raw?: string | null): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  const key = toStorageKey(s);
  return key ? `${PREFIX}${key}` : '';
}

/** 是否为 Excel 工作簿文件名（单据模板只收 `.xlsx`） */
export function isExcelTemplateFileName(name?: string | null): boolean {
  return /\.xlsx$/i.test(String(name ?? '').trim());
}

/**
 * **文件引用归一化（URL / 键 → 相对存储键）的单一实现**。
 *
 * 背景：数据库里同时存了相对键（`signed/x.pdf`）与公开 URL（`/api/files/2026-10/x.pdf`），
 * 历史上 archive / labor-excel / receipt-order / doc-template 各写了一份解析，规则容易漂移。
 * 本文件统一口径，供读盘、归档、Excel 导出与审计脚本共用。
 *
 * 口径：
 * - 相对键原样返回（只做空白/分隔符归一）；
 * - `/api/files/<键>` 与完整 `http(s)` URL 都取键；
 * - **循环剥离重复的 `/api/files/` 前缀**（历史上已写成双前缀的数据也能救回）；
 * - 其它绝对路径（如 `/etc/passwd`、`C:/...`）**不静默纠正**——保留前导斜杠，
 *   交给 `assertSafeStorageKey` 拒绝（静默改写会掩盖调用方 bug、削弱越权防线）。
 *
 * 零依赖，可被 `.mts` 单测直接加载。
 */

export const FILES_URL_PREFIX = '/api/files/';

/** URL / 公开地址 / 相对键 → StorageService 相对键（POSIX 分隔，去掉 `./` 与重复斜杠） */
export function storageKeyFromUrl(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';

  // Windows 反斜杠统一成正斜杠
  s = s.replace(/\\/g, '/');

  // 完整 URL：只取 pathname（忽略域名、端口、query、hash）
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      // 解析失败就按原字符串继续，最终交给安全校验
    }
  }

  // 循环剥离重复的 /api/files/ 前缀（含已写坏的双前缀）
  for (;;) {
    const i = s.indexOf(FILES_URL_PREFIX);
    if (i < 0) break;
    s = s.slice(i + FILES_URL_PREFIX.length);
  }

  // 去掉 query / hash
  s = s.split('?')[0].split('#')[0];

  const leadingSlash = s.startsWith('/');
  const cleaned = s
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
  // 前缀之外的绝对路径保留前导斜杠，让 assertSafeStorageKey 拒绝（不静默转成相对键）
  return leadingSlash ? `/${cleaned}` : cleaned;
}

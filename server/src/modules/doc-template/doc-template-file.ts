/**
 * **单据模板文件键 / 文件名的纯逻辑**（零依赖，可被 `.mts` 单测直接加载）。
 *
 * 背景（2026-10-18）：上传接口返回的是**公开 URL**（`/api/files/<键>`），而数据库与
 * `StorageService.read()` 的口径是**相对存储键**（`2026-10/x.xlsx`）。前端曾把 URL 原样存进
 * `ContractTemplate.fileUrl`，后端读盘时被 `assertSafeStorageKey` 当成绝对路径拒绝（400）——
 * 表现为「上传成功却无法生成单据」。这里把「URL/键 → 相对键」的归一化收敛成一处。
 *
 * 口径：
 * - 相对键原样返回（只做空白/分隔符归一）；
 * - `/api/files/<键>` 与完整 `http(s)` URL 都取键；
 * - **循环剥离重复的 `/api/files/` 前缀**（历史上已经写成 `/api/files//api/files/x` 的数据也能救回）；
 * - 其它绝对路径（如 `/etc/passwd`、`C:/...`）**不静默纠正**——留给 `assertSafeStorageKey` 拒绝，
 *   静默改写会掩盖调用方的 bug，也会削弱越权读盘的防线。
 */

const PREFIX = '/api/files/';

/** URL / 公开地址 / 相对键 → StorageService 相对键（POSIX 分隔，去掉 `./` 与重复斜杠） */
export function normalizeDocTemplateFileKey(raw: unknown): string {
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
    const i = s.indexOf(PREFIX);
    if (i < 0) break;
    s = s.slice(i + PREFIX.length);
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

/** 是否为 Excel 工作簿文件名（单据模板只收 `.xlsx`；`.xlsm` 宏会在写出时丢失，故不支持） */
export function isExcelTemplateFileName(name: unknown): boolean {
  return /\.xlsx$/i.test(String(name ?? '').trim());
}

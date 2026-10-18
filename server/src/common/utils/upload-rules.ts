/**
 * 通用上传的安全规则（零依赖，可被 `.mts` 单测直接加载）。
 *
 * 现状：上传接口只做 JWT 校验，`/api/files/**` 又是公开静态服务，且浏览器按扩展名推断 MIME——
 * 允许上传 `.html` / `.svg` / `.js` 等会被同源执行，形成存储型 XSS。
 * 这里只拦**可执行/可脚本**类型；业务常见格式（pdf / office / 图片 / 压缩包 / txt / csv / dwg…）不受影响。
 */

/** 拒绝上传的危险扩展名（小写，含点） */
export const DANGEROUS_UPLOAD_EXTS: readonly string[] = [
  '.html', '.htm', '.svg',
  '.js', '.mjs', '.cjs',
  '.exe', '.bat', '.cmd', '.com', '.scr', '.msi', '.dll',
  '.sh', '.ps1', '.vbs', '.vbe', '.wsf', '.wsh', '.hta',
  '.php', '.jsp', '.asp', '.aspx', '.cgi', '.pl', '.py',
  '.jar', '.war',
];

/** 文件名是否属于危险类型（按最后一个点取扩展名，大小写不敏感；无扩展名 → 放行） */
export function isDangerousUploadName(name: unknown): boolean {
  const s = String(name ?? '').trim().toLowerCase();
  if (!s) return false;
  const dot = s.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = s.slice(dot);
  return DANGEROUS_UPLOAD_EXTS.includes(ext);
}

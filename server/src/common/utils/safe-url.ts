/**
 * 附件/文件链接的协议白名单（第 8 轮审计新增）。
 *
 * 为什么需要：附件的 `url` 是**前端直接放进 `href`** 的字符串——
 * `web/src/pages/Contracts.tsx` 的附件列表就是 `<a href={a.url}>`，
 * `LaborAuth.tsx` 的 `href={detail.signedAuthFile}` 同理。
 * 后端过去只判非空就落库，于是有写权限的人存一条
 * `javascript:fetch('/api/auth/profile')…` 就能在任何打开该详情页的人
 * （通常是管理员）身上执行脚本，读走 localStorage 里的 token —— 典型的存储型 XSS。
 *
 * 白名单口径（与本系统实际用法一致）：
 * - 站内相对路径：`/api/files/...`、`/files/...` 等以单斜杠开头的地址；
 * - 完整 `http://` / `https://` 地址（历史数据里存在外链）。
 * 其余（`javascript:`、`data:`、`vbscript:`、`file:`、`//host`、纯相对文件名）一律拒绝。
 */
const SAFE_SCHEMES = ['http://', 'https://'];

/**
 * 判断一个链接是否可安全放进 `href`。
 * 说明：这里只做「协议」判断，不做可达性判断（离线/外网链接都允许）。
 */
export function isSafeFileUrl(value: unknown): boolean {
  const url = String(value ?? '').trim();
  if (!url) return false;
  // 站内相对地址：单斜杠开头（`//host` 是协议相对 URL，等同于外链，不放行）
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  const lower = url.toLowerCase();
  const scheme = lower.match(/^[a-z][a-z0-9+.-]*:/);
  if (!scheme) return false; // 没有协议头又不是站内路径 → 不放行
  return SAFE_SCHEMES.some((s) => lower.startsWith(s));
}

/** 空白视为「没填」，返回 null；非法协议返回 `{ error }`；合法返回原值 */
export function checkFileUrl(value: unknown, label = '附件地址'): { url?: string | null; error?: string } {
  const url = String(value ?? '').trim();
  if (!url) return { url: null };
  if (!isSafeFileUrl(url)) {
    return { error: `${label}只能填站内路径（以 / 开头）或 http(s) 链接，收到「${url.slice(0, 60)}」` };
  }
  return { url };
}

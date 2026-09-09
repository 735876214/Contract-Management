/** 为下载链接附加 token（window.open 无法携带 Authorization 头，后端 JWT 策略支持 ?token=） */
export function withToken(url: string): string {
  const token = localStorage.getItem('cms_token') || '';
  return url + (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
}

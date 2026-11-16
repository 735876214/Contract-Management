import { useAuthStore } from '@/store/auth';

/**
 * 下载链接的项目上下文：window.open 无法携带请求头，后端 `ProjectId` 装饰器支持 `?projectId=`。
 *
 * ⚠️ **不再把 JWT 拼进 URL**（2026-10-18 安全修复）：token 会进入 nginx 访问日志、浏览器历史与
 * Referer。文件/GET 下载的鉴权改由 httpOnly Cookie（`/auth/login` 与 `/auth/file-session` 下发，
 * 后端 JwtStrategy 仅对 GET 接受）完成；普通 API 仍走 Authorization 头。
 */
export function withToken(url: string): string {
  const projectId =
    localStorage.getItem('cms_project_id') || useAuthStore.getState().currentProjectId || '';
  if (!projectId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + `projectId=${encodeURIComponent(projectId)}`;
}

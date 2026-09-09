import { useAuthStore } from '@/store/auth';

/** 下载链接鉴权与项目上下文：window.open 无法携带请求头，后端 JWT 策略与 ProjectId 装饰器均支持 ?token= / ?projectId= */
export function withToken(url: string): string {
  const token = localStorage.getItem('cms_token') || '';
  const projectId =
    localStorage.getItem('cms_project_id') || useAuthStore.getState().currentProjectId || '';
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + `token=${encodeURIComponent(token)}` + `&projectId=${encodeURIComponent(projectId)}`;
}

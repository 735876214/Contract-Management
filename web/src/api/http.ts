import axios from 'axios';
import { message } from 'antd';
import { useAuthStore } from '@/store/auth';

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 30000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('cms_token');
  // 项目上下文：localStorage 优先，store 兜底（防止旧标签页 localStorage 被清导致 x-project-id 缺失）
  const projectId =
    localStorage.getItem('cms_project_id') || useAuthStore.getState().currentProjectId;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (projectId) config.headers['x-project-id'] = projectId;
  return config;
});

http.interceptors.response.use(
  (res) => {
    // `rawResponse: true`：调用方要读响应头（如 AI 回填返回的 x-ai-filled）或要拿完整 AxiosResponse，
    // 跳过「解包 body.data」这一步。除 AI 助手外暂无使用者。
    if ((res.config as any)?.rawResponse) return res as any;
    const body = res.data;
    if (body && typeof body === 'object' && 'code' in body) {
      if (body.code === 0) return body.data;
      message.error(body.message || '请求失败');
      if (body.code === 1401) {
        // 走完整的登出清理（菜单缓存/标签属于上一个会话），而不是只删 token——
        // 否则「登录已失效 → 重新登录」后残留的标签/菜单与失效项目 id 会引发一连串报错。
        useAuthStore.getState().logout();
        setTimeout(() => (window.location.href = '/login'), 500);
      }
      return Promise.reject(new Error(body.message || '请求失败'));
    }
    return body;
  },
  async (error) => {
    const status = error?.response?.status;
    const body = error?.response?.data;
    const msg =
      (body && typeof body === 'object' && 'message' in body ? body.message : null) ||
      error?.message || '网络异常';
    // 登录失效：后端以 HTTP 401 + code 1401 返回（走的是这里，不是成功拦截器）。
    // 走完整的 store.logout()：清 token/项目 id/菜单缓存/标签，再跳登录页。
    if (status === 401 || (body && typeof body === 'object' && body.code === 1401)) {
      useAuthStore.getState().logout();
      message.error(typeof msg === 'string' ? msg : '登录已失效，请重新登录');
      setTimeout(() => (window.location.href = '/login'), 500);
      return Promise.reject(new Error('登录已失效'));
    }
    // 当前项目已被删除 / 重建 / 无权访问：自动刷新项目列表并归位到第一个可用项目，
    // 替代过去「手动退出重新登录」才能恢复的体验；刷新失败仍按普通错误提示。
    const stale =
      typeof msg === 'string' &&
      (msg.includes('项目不存在') || msg.includes('无权访问该项目') || msg.includes('缺少项目上下文'));
    if (stale) {
      try {
        await useAuthStore.getState().refreshProjects();
        const retryId = useAuthStore.getState().currentProjectId;
        if (retryId && retryId !== error?.config?.headers?.['x-project-id']) {
          message.info('当前项目已失效，已切换到可用项目，请重试操作');
          return http(error.config); // 用新项目 id 重放一次原请求
        }
      } catch {
        // 刷新失败（如 token 也过期）→ 走普通错误提示
      }
    }
    message.error(msg);
    return Promise.reject(error);
  },
);

/**
 * 剥离 URL 开头的 baseURL（如 /api）：
 * 部分导入/上传助手返回的地址已含 baseURL 前缀，而调用方又走本 axios 实例（baseURL 再拼一次），
 * 会产生 /api/api/... 双前缀。此处统一归一化，一处修复覆盖全部调用方。
 */
export function stripApiBase(url: string): string {
  let base = http.defaults.baseURL || '/api';
  // baseURL 可能被配置成 '/'（如 VITE_API_BASE=/ 走根路径反向代理）：
  // 不能把它剥成空串，否则下面 startsWith('') 恒真、slice(0) 又不缩短字符串 → 死循环卡死页面。
  while (base.length > 1 && base.endsWith('/')) base = base.slice(0, -1);
  let result = url;
  while (base && result.startsWith(base)) result = result.slice(base.length);
  return result || url;
}

export default http;

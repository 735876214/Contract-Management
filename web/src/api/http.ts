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
    const msg = error?.response?.data?.message || error.message || '网络异常';
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

export default http;

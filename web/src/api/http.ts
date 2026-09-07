import axios from 'axios';
import { message } from 'antd';

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 30000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('cms_token');
  const projectId = localStorage.getItem('cms_project_id');
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
        localStorage.removeItem('cms_token');
        setTimeout(() => (window.location.href = '/login'), 500);
      }
      return Promise.reject(new Error(body.message || '请求失败'));
    }
    return body;
  },
  (error) => {
    const msg = error?.response?.data?.message || error.message || '网络异常';
    message.error(msg);
    return Promise.reject(error);
  },
);

export default http;

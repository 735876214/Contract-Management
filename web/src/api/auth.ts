import http from './http';

export interface LoginResult {
  token: string;
  user: { id: string; username: string; realName: string; isSuperAdmin: boolean; permissions: string[] };
  projects: any[];
}

export const authApi = {
  login: (username: string, password: string) => http.post<any, LoginResult>('/auth/login', { username, password }),
  profile: () => http.get<any, any>('/auth/profile'),
  /** 为已有本地 token 的会话补发文件 httpOnly Cookie（启动时调用） */
  fileSession: () => http.get<any, any>('/auth/file-session'),
  logout: () => http.post('/auth/logout'),
  changePassword: (oldPassword: string, newPassword: string) =>
    http.post('/auth/password', { oldPassword, newPassword }),
};

export const fileApi = {
  upload: (files: File[]) => {
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    return http.post<any, { fileName: string; url: string; key: string; size: number }[]>('/files/upload', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
};

export const systemApi = {
  users: (params?: any) => http.get('/system/users', { params }),
  createUser: (data: any) => http.post('/system/users', data),
  updateUser: (id: string, data: any) => http.put(`/system/users/${id}`, data),
  removeUser: (id: string) => http.delete(`/system/users/${id}`),
  resetPassword: (id: string, password: string) => http.post(`/system/users/${id}/reset-password`, { password }),
  roles: () => http.get('/system/roles'),
  createRole: (data: any) => http.post('/system/roles', data),
  updateRole: (id: string, data: any) => http.put(`/system/roles/${id}`, data),
  removeRole: (id: string) => http.delete(`/system/roles/${id}`),
  permissions: () => http.get('/system/permissions'),
  params: () => http.get('/system/params'),
  saveParams: (items: { key: string; value?: string }[]) => http.put('/system/params', items),
  operationLogs: (params?: any) => http.get('/system/logs/operations', { params }),
  loginLogs: (params?: any) => http.get('/system/logs/logins', { params }),
};

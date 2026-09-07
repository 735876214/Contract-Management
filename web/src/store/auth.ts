import { create } from 'zustand';
import { authApi } from '@/api/auth';

export interface UserInfo {
  id: string;
  username: string;
  realName: string;
  isSuperAdmin: boolean;
  permissions: string[];
  [key: string]: any;
}

interface AuthState {
  token: string;
  user: UserInfo | null;
  permissions: string[];
  projects: any[];
  currentProjectId: string;
  params: Record<string, string>;
  login: (username: string, password: string) => Promise<any>;
  loadProfile: () => Promise<void>;
  logout: () => void;
  setCurrentProject: (id: string) => void;
  hasPermission: (code: string) => boolean;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('cms_token') || '',
  user: null,
  permissions: [],
  projects: [],
  currentProjectId: localStorage.getItem('cms_project_id') || '',
  params: {},

  login: async (username, password) => {
    const res = await authApi.login(username, password);
    localStorage.setItem('cms_token', res.token);
    const projectId = res.projects?.[0]?.id || '';
    localStorage.setItem('cms_project_id', projectId);
    set({
      token: res.token,
      user: res.user,
      permissions: res.user?.permissions || [],
      projects: res.projects || [],
      currentProjectId: projectId,
    });
    return res;
  },

  loadProfile: async () => {
    const profile = await authApi.profile();
    const projects = profile.projects || [];
    const stored = localStorage.getItem('cms_project_id');
    const currentProjectId =
      stored && projects.some((p: any) => p.id === stored) ? stored : projects[0]?.id || '';
    localStorage.setItem('cms_project_id', currentProjectId);
    set({
      user: profile,
      permissions: profile.permissions || [],
      projects,
      currentProjectId,
      params: profile.params || {},
    });
  },

  logout: () => {
    localStorage.removeItem('cms_token');
    localStorage.removeItem('cms_project_id');
    set({ token: '', user: null, permissions: [], projects: [], currentProjectId: '' });
  },

  setCurrentProject: (id: string) => {
    localStorage.setItem('cms_project_id', id);
    set({ currentProjectId: id });
  },

  hasPermission: (code: string) => {
    const { user, permissions } = get();
    if (user?.isSuperAdmin) return true;
    return permissions.includes(code);
  },
}));

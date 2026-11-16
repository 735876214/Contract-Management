import { create } from 'zustand';
import { authApi } from '@/api/auth';
import { clearMenuCache } from '@/components/Sider/utils/storage';

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
  /** 只刷新项目列表并重新校验当前项目 id（新建/删除项目后调用，无需整页刷新） */
  refreshProjects: () => Promise<void>;
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

  refreshProjects: async () => {
    // 与 loadProfile 同口径，但只刷项目相关状态：新建/删除项目后让顶部下拉立即生效，
    // 并把失效的 cms_project_id 归位到第一个可用项目（避免带着已删除的项目 id 到处报错）。
    const profile = await authApi.profile();
    const projects = profile.projects || [];
    const stored = localStorage.getItem('cms_project_id');
    const currentProjectId =
      stored && projects.some((p: any) => p.id === stored) ? stored : projects[0]?.id || '';
    if (stored !== currentProjectId) localStorage.setItem('cms_project_id', currentProjectId);
    set({ projects, currentProjectId });
  },

  logout: () => {
    localStorage.removeItem('cms_token');
    localStorage.removeItem('cms_project_id');
    // 清除侧边栏菜单缓存，避免同标签页切换账号后读到上一账号的菜单树
    // （必须走 clearMenuCache：缓存键带版本后缀，原先写死无版本的键名导致从未真正清掉）
    clearMenuCache();
    // 标签同样属于上一个会话（含失效的项目上下文），一并重置——
    // 否则「登录已失效 → 重登」后恢复的旧标签会带着失效的项目 id 连环报错。
    import('@/store/tabs').then(({ useTabsStore }) => useTabsStore.getState().reset());
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

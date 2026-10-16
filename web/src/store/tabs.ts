import { create } from 'zustand';
import {
  type TabRecord,
  type TabsState,
  closeAll,
  closeOthers,
  closeSide,
  closeTab as closeTabPure,
  emptyTabs,
  deserializeTabs,
  openTab,
  refreshTab,
  retitleTab,
  serializeTabs,
} from '@/utils/tabs';
import { STORAGE_KEYS, readLocal, writeLocal } from '@/components/Sider/utils/storage';

/**
 * 多页签导航状态（纯逻辑在 `@/utils/tabs`，本文件只做状态容器与持久化）。
 *
 * 三件事必须放在同一个 store 里，否则会各写一套：
 * 1. **标签列表**（`tabs` / `lastActive`）—— 展示顺序稳定，淘汰看 `lastActive`；
 * 2. **活动标签信号**（`activeKey` / `activeToken`）—— 标签页被缓存后**不会重新挂载**，
 *    "我被重新显示出来了"这件事只能靠令牌传递：ECharts / rc-table 的重测量、
 *    工作台"当天首次登录浮窗"的复检都订阅它（`useTabActivate`）；
 * 3. **跨标签的刷新与脏数据**（`refreshTokens` / `dirtyKeys`）——
 *    编辑器标签保存后要让**另一个**（被缓存的）列表标签重新取数；关闭脏标签要拦一下。
 *
 * 持久化只存标签的"位置"，**且跳过编辑器标签**（见 `serializeTabs` 的注释）。
 */

interface TabsStoreState extends TabsState {
  /** 当前活动标签键 */
  activeKey: string;
  /** 活动标签变化时自增（含重新点击同一标签）——缓存的页面靠它知道"又被显示了" */
  activeToken: number;
  /** 跨标签刷新令牌：列表路径 → 次数 */
  refreshTokens: Record<string, number>;
  /** 有未保存内容的标签键（编辑器标签用来拦关闭） */
  dirtyKeys: string[];
  /**
   * 编辑器标签的**初始数据种子**（仅内存，不持久化）。
   *
   * 为什么需要它：编辑器标签与列表标签是**两个独立实例**，编辑器拿不到列表的 state；
   * 而本仓多数模块只有列表接口、没有"按 id 取详情"的接口。于是由列表页在打开编辑器时
   * 把选中行放进来，编辑器实例挂载时取用。
   * 不落 localStorage 是刻意的：编辑器标签本身就不持久化（刷新后不恢复），种子跟着一起失效。
   */
  editorSeeds: Record<string, unknown>;

  /** 路由变化时调用：登记/激活标签（已存在则只更新标题，保留 version） */
  syncRoute: (incoming: Omit<TabRecord, 'version'>) => void;
  /** 关闭单个标签；返回需要跳转的标签键（`null` = 不用跳） */
  closeTab: (key: string) => string | null;
  closeOthers: (key: string) => string | null;
  closeAll: () => string | null;
  closeSide: (key: string, side: 'left' | 'right') => string | null;
  /** 刷新标签（递增 version → 该标签内的页面重挂载并重新取数） */
  refresh: (key: string) => void;
  /** 改标签标题（编辑器加载完记录后调用） */
  retitle: (key: string, title: string) => void;

  /** 通知某个**列表路径**的标签重新取数（编辑器保存成功后调用） */
  bumpRefresh: (listPath: string) => void;
  /** 编辑器标签上报脏状态 */
  setDirty: (key: string, dirty: boolean) => void;
  /** 放下编辑器标签的初始数据（列表页打开编辑器时调用） */
  setEditorSeed: (key: string, data: unknown) => void;
  /** 取出编辑器标签的初始数据；`consume` 为 true 时取完即清（避免下次重挂载读到旧行） */
  takeEditorSeed: (key: string) => unknown;
  /** 退出登录等场景：重置为只剩首页（并清掉 localStorage） */
  reset: () => void;
}

/** 从 localStorage 恢复（脏数据一律降级为「只有首页」，见 deserializeTabs） */
function initialTabs(): TabsState {
  return deserializeTabs(readLocal<unknown>(STORAGE_KEYS.tabs, null));
}

function persist(state: TabsState): void {
  writeLocal(STORAGE_KEYS.tabs, serializeTabs(state));
}

export const useTabsStore = create<TabsStoreState>((set, get) => {
  const initial = initialTabs();

  /** 清掉已关闭标签的脏标记与数据种子（不清理会随使用时长无限增长） */
  const prune = (
    s: Pick<TabsStoreState, 'dirtyKeys' | 'editorSeeds'>,
    alive: Set<string>,
  ): { dirtyKeys: string[]; editorSeeds: Record<string, unknown> } => ({
    dirtyKeys: s.dirtyKeys.filter((k) => alive.has(k)),
    editorSeeds: Object.fromEntries(Object.entries(s.editorSeeds).filter(([k]) => alive.has(k))),
  });

  return {
    ...initial,
    activeKey: '',
    activeToken: 0,
    refreshTokens: {},
    dirtyKeys: [],
    editorSeeds: {},

    syncRoute: (incoming) => {
      const now = Date.now();
      const s = get();
      const next = openTab({ tabs: s.tabs, lastActive: s.lastActive }, incoming, now);
      // 标签集合没变时不必重复落盘（每次路由变化都会走到这里）
      if (next.tabs !== s.tabs) persist(next);
      set({
        tabs: next.tabs,
        lastActive: next.lastActive,
        activeKey: incoming.key,
        activeToken: s.activeToken + 1,
      });
    },

    closeTab: (key) => {
      const s = get();
      const { state, activate } = closeTabPure({ tabs: s.tabs, lastActive: s.lastActive }, key, s.activeKey);
      if (state.tabs !== s.tabs) {
        persist(state);
        set({ tabs: state.tabs, lastActive: state.lastActive, ...prune(s, new Set(state.tabs.map((t) => t.key))) });
      }
      return activate;
    },

    closeOthers: (key) => {
      const s = get();
      const { state, activate } = closeOthers({ tabs: s.tabs, lastActive: s.lastActive }, key, s.activeKey);
      if (state.tabs !== s.tabs) {
        persist(state);
        set({ tabs: state.tabs, lastActive: state.lastActive, ...prune(s, new Set(state.tabs.map((t) => t.key))) });
      }
      return activate;
    },

    closeAll: () => {
      const s = get();
      const { state, activate } = closeAll({ tabs: s.tabs, lastActive: s.lastActive }, s.activeKey);
      if (state.tabs !== s.tabs) {
        persist(state);
        set({ tabs: state.tabs, lastActive: state.lastActive, dirtyKeys: [], editorSeeds: {} });
      }
      return activate;
    },

    closeSide: (key, side) => {
      const s = get();
      const { state, activate } = closeSide({ tabs: s.tabs, lastActive: s.lastActive }, key, s.activeKey, side);
      if (state.tabs !== s.tabs) {
        persist(state);
        set({ tabs: state.tabs, lastActive: state.lastActive, ...prune(s, new Set(state.tabs.map((t) => t.key))) });
      }
      return activate;
    },

    refresh: (key) => {
      const s = get();
      const next = refreshTab({ tabs: s.tabs, lastActive: s.lastActive }, key);
      if (next.tabs === s.tabs) return;
      set({ tabs: next.tabs });
    },

    retitle: (key, title) => {
      const s = get();
      const next = retitleTab({ tabs: s.tabs, lastActive: s.lastActive }, key, title);
      if (next.tabs !== s.tabs) set({ tabs: next.tabs });
    },

    bumpRefresh: (listPath) => {
      const s = get();
      set({ refreshTokens: { ...s.refreshTokens, [listPath]: (s.refreshTokens[listPath] ?? 0) + 1 } });
    },

    setDirty: (key, dirty) => {
      const s = get();
      const has = s.dirtyKeys.includes(key);
      if (dirty === has) return;
      set({ dirtyKeys: dirty ? [...s.dirtyKeys, key] : s.dirtyKeys.filter((k) => k !== key) });
    },

    setEditorSeed: (key, data) => {
      set({ editorSeeds: { ...get().editorSeeds, [key]: data } });
    },

    takeEditorSeed: (key) => {
      const s = get();
      const data = s.editorSeeds[key];
      if (data !== undefined) {
        const rest = { ...s.editorSeeds };
        delete rest[key];
        set({ editorSeeds: rest });
      }
      return data;
    },

    reset: () => {
      const base = emptyTabs();
      persist(base);
      set({
        tabs: base.tabs,
        lastActive: base.lastActive,
        activeKey: '',
        activeToken: 0,
        refreshTokens: {},
        dirtyKeys: [],
        editorSeeds: {},
      });
    },
  };
});

/** 关标签时若它是脏的，先确认（TagsView 与编辑器页共用） */
export function isTabDirty(key: string): boolean {
  return useTabsStore.getState().dirtyKeys.includes(key);
}

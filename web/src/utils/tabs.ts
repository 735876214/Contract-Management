/**
 * 多页签导航的**纯逻辑层**。
 *
 * 为什么单独抽一个文件：本模块要同时被两处使用 ——
 * ① `web/src/store/tabs.ts`（zustand store，只管状态容器）；
 * ② `server/test/tabsStore.spec.mts`（Node 原生类型擦除直接加载本文件做单测）。
 * 因此本文件**刻意零 import**（`.mts` 硬约束：相对 import 必须带扩展名、且装饰器/JSX 不可用，
 * 见 `.claude/rules/testing.md`）——菜单标题的解析放在 `layouts/TagsView.tsx`，不进这里。
 *
 * 口径（与 `docs/供应链管理系统前端界面优化建议.md` 的评估结论一致）：
 * - 缓存的是**浏览器里的 React 组件实例**，与 Redis 之类的服务端数据缓存无关；
 * - 标签顺序**稳定**（不因激活而重排），淘汰顺序另记 `lastActive`；
 * - `version` 是"刷新标签"的唯一实现：键变了 React 就重挂载，等于重新取数。
 */

/** 首页固定标签（不可关闭）——与 `ROUTE_PERMISSION_EXCEPTIONS` 的默认落地页一致 */
export const HOME_TAB_KEY = '/dashboard';
export const HOME_TAB_TITLE = '工作台';

/** 标签数量上限：超出后淘汰**最久未激活**的可关闭标签（连同其缓存的页面实例） */
export const TAB_MAX = 12;

/** 编辑器标签的 query 参数名：`?editor=new` / `?editor=<id>` */
export const EDITOR_PARAM = 'editor';

export interface TabRecord {
  /** 唯一键：菜单页 = `pathname`；编辑器页 = `<pathname>?editor=<new|id>` */
  key: string;
  /** 路由路径（不含 query） */
  path: string;
  /** 完整地址（含 query）—— 标签点击时用它 `navigate()`，否则编辑器会退回列表 */
  href: string;
  title: string;
  /** 菜单图标名（`iconHelper.tsx` 的 ICON_MAP 键；仅激活态显示）。编辑器标签不存 */
  icon?: string;
  /** 是否可关闭：首页固定标签为 false */
  closable: boolean;
  /** 刷新版本：递增 → 缓存键变化 → 重挂载 */
  version: number;
}

export interface TabsState {
  /** **展示顺序**（稳定，不因激活而重排） */
  tabs: TabRecord[];
  /** 最近激活时间戳（仅内存，不持久化）—— 淘汰顺序的依据 */
  lastActive: Record<string, number>;
}

/** 一个只含首页标签的初始状态 */
export function emptyTabs(): TabsState {
  return {
    tabs: [
      {
        key: HOME_TAB_KEY,
        path: HOME_TAB_KEY,
        href: HOME_TAB_KEY,
        title: HOME_TAB_TITLE,
        icon: 'DashboardOutlined',
        closable: false,
        version: 0,
      },
    ],
    lastActive: {},
  };
}

/* ---------------- 键 ---------------- */

/** 编辑器标签键：`<列表路径>?editor=<new|id>`；列表页与编辑器页由此成为**两个独立实例** */
export function editorTabKey(path: string, editorId: string): string {
  return `${path}?${EDITOR_PARAM}=${encodeURIComponent(editorId)}`;
}

/** 是否编辑器标签（决定：不持久化、淘汰时让路、关闭后要回列表刷新） */
export function isEditorKey(key: string): boolean {
  return key.includes(`?${EDITOR_PARAM}=`);
}

/** 编辑器标签对应的**列表路径**（其余 key 原样返回） */
export function listPathOf(key: string): string {
  const i = key.indexOf('?');
  return i < 0 ? key : key.slice(0, i);
}

/** 标签键里 `editor` 参数的值（`null` = 不是编辑器标签） */
export function editorIdOf(key: string): string | null {
  const i = key.indexOf('?');
  if (i < 0) return null;
  for (const pair of key.slice(i + 1).split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq) === EDITOR_PARAM) return decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}

/**
 * 由**当前位置**算出标签键：只有 `editor` 参数会进入键，其余查询参数忽略。
 *
 * 为什么必须同步算、而不是等 store：页面要按标签键决定"我渲染列表还是渲染编辑器"。
 * 若走 `useLocation()`，被缓存的**列表标签**也会因为 URL 变成了 `?editor=…`
 * 而以为自己该渲染编辑器 —— 每个标签的键必须来自它**自己**的键（经 `TabScope` 上下文下发），
 * 这也是"用查询参数做编辑器页签"能成立的前提。
 */
export function tabKeyOf(pathname: string, search: string): string {
  const q = search.startsWith('?') ? search.slice(1) : search;
  if (!q) return pathname;
  const params = new URLSearchParams(q);
  const id = params.get(EDITOR_PARAM);
  if (id == null || id === '') return pathname;
  // 统一成「只有 editor 一个参数」的形态，避免参数顺序/噪声参数造出重复标签
  return editorTabKey(pathname, id);
}

/**
 * 缓存键 = 标签键 + 版本号。
 * 「右键 → 刷新」就是递增 `version`：键变了 → React 视为新元素 → **重挂载**（= 重新取数）。
 * 这是本方案里唯一的"刷新标签"实现，不额外写取数接口。
 */
export function cacheKeyOf(tab: TabRecord): string {
  return `${tab.key}#${tab.version}`;
}

/* ---------------- 打开 / 激活 ---------------- */

/**
 * 打开或激活一个标签。
 * ⚠️ 已存在时**只更新标题、保留 version** —— 否则每次切页都会因为派生出新键而重挂载，
 * 页面状态缓存（本方案的全部价值）会静默失效。
 */
export function openTab(
  state: TabsState,
  incoming: Omit<TabRecord, 'version'>,
  now: number,
  max: number = TAB_MAX,
): TabsState {
  const lastActive = { ...state.lastActive, [incoming.key]: now };
  const existing = state.tabs.find((t) => t.key === incoming.key);
  if (existing) {
    // 标题/图标允许被覆盖（编辑器加载完记录后会把「编辑」改成「编辑 · 编号」）
    const tabs =
      (incoming.title && incoming.title !== existing.title) || incoming.icon !== existing.icon
        ? state.tabs.map((t) =>
            t.key === incoming.key ? { ...t, title: incoming.title || t.title, icon: incoming.icon ?? t.icon } : t,
          )
        : state.tabs;
    return { tabs, lastActive };
  }
  let tabs = [...state.tabs, { ...incoming, version: 0 }];
  if (tabs.length > max) {
    const victim = evictKey(tabs, incoming.key, lastActive);
    if (victim) {
      tabs = tabs.filter((t) => t.key !== victim);
      delete lastActive[victim];
    }
    // 全是编辑器标签时**不淘汰**：宁可超限，也不在编辑到一半时把页面丢掉
  }
  return { tabs, lastActive };
}

/** 挑选淘汰对象：只淘汰"最久未激活的**非编辑器**可关闭标签"；全是编辑器标签时返回 null（不淘汰） */
function evictKey(
  tabs: TabRecord[],
  keepKey: string,
  lastActive: Record<string, number>,
): string | null {
  const candidates = tabs.filter((t) => t.closable && t.key !== keepKey && !isEditorKey(t.key));
  if (!candidates.length) return null;
  const at = (k: string) => lastActive[k] ?? 0;
  return candidates.reduce((min, t) => (at(t.key) < at(min.key) ? t : min), candidates[0]).key;
}

/* ---------------- 关闭 ---------------- */

export interface CloseResult {
  state: TabsState;
  /** 需要跳转到的标签键；`null` = 当前标签没被关掉，不用跳 */
  activate: string | null;
}

function dropKeys(state: TabsState, keys: Set<string>): TabsState {
  if (!keys.size) return state;
  const lastActive = { ...state.lastActive };
  for (const k of keys) delete lastActive[k];
  return { tabs: state.tabs.filter((t) => !keys.has(t.key)), lastActive };
}

/**
 * 关闭单个标签。关掉的是当前标签时，落点按"**右邻优先**，其次左邻，最后首页"——
 * 与主流 admin 多页签一致（关掉最后一页时回到首页，不会出现空内容区）。
 */
export function closeTab(state: TabsState, key: string, currentKey: string): CloseResult {
  const idx = state.tabs.findIndex((t) => t.key === key);
  if (idx < 0 || !state.tabs[idx].closable) return { state, activate: null };
  const next = state.tabs[idx + 1] ?? state.tabs[idx - 1];
  const nextState = dropKeys(state, new Set([key]));
  if (key !== currentKey) return { state: nextState, activate: null };
  return { state: nextState, activate: next?.key ?? HOME_TAB_KEY };
}

/** 关闭其他：留在被右键的那个标签上（它若不可关闭，行为等价于"关闭全部可关闭标签"） */
export function closeOthers(state: TabsState, key: string, currentKey: string): CloseResult {
  const target = state.tabs.find((t) => t.key === key);
  if (!target) return { state, activate: null };
  const keys = new Set(state.tabs.filter((t) => t.closable && t.key !== key).map((t) => t.key));
  return { state: dropKeys(state, keys), activate: currentKey === key ? null : key };
}

/** 关闭全部：只保留固定标签（首页） */
export function closeAll(state: TabsState, currentKey: string): CloseResult {
  const keys = new Set(state.tabs.filter((t) => t.closable).map((t) => t.key));
  return { state: dropKeys(state, keys), activate: currentKey === HOME_TAB_KEY ? null : HOME_TAB_KEY };
}

/** 关闭左侧/右侧：只关"可关闭"的标签，固定标签留在原位 */
export function closeSide(state: TabsState, key: string, currentKey: string, side: 'left' | 'right'): CloseResult {
  const idx = state.tabs.findIndex((t) => t.key === key);
  if (idx < 0) return { state, activate: null };
  const scope = side === 'left' ? state.tabs.slice(0, idx) : state.tabs.slice(idx + 1);
  const keys = new Set(scope.filter((t) => t.closable).map((t) => t.key));
  if (!keys.size) return { state, activate: null };
  const nextState = dropKeys(state, keys);
  const stillThere = nextState.tabs.some((t) => t.key === currentKey);
  return { state: nextState, activate: stillThere ? null : key };
}

/* ---------------- 刷新 ---------------- */

/** 刷新某个标签：递增 `version` → 缓存键变化 → 该标签内的页面重挂载并重新取数 */
export function refreshTab(state: TabsState, key: string): TabsState {
  if (!state.tabs.some((t) => t.key === key)) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.key === key ? { ...t, version: t.version + 1 } : t)) };
}

/** 改标题：编辑器标签在记录加载完后把「新增/编辑」改成带编号的具体标题 */
export function retitleTab(state: TabsState, key: string, title: string): TabsState {
  if (!title) return state;
  const hit = state.tabs.some((t) => t.key === key && t.title !== title);
  if (!hit) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.key === key ? { ...t, title } : t)) };
}

/* ---------------- 持久化 ---------------- */

export interface PersistedTabs {
  tabs: Array<Pick<TabRecord, 'key' | 'path' | 'href' | 'title' | 'closable' | 'icon'>>;
}

/**
 * 序列化：**跳过编辑器标签**。
 * 理由：编辑器里的未保存内容只活在组件 state 里，刷新后无法恢复；
 * 恢复一个"空的编辑页"比不恢复更糟（用户会以为内容还在）。
 * 恢复的标签只提供"位置"，页面实例仍按需挂载。
 */
export function serializeTabs(state: TabsState): PersistedTabs {
  return {
    tabs: state.tabs
      .filter((t) => !isEditorKey(t.key))
      .map(({ key, path, href, title, icon, closable }) => ({ key, path, href, title, icon, closable })),
  };
}

/** 反序列化：任何脏数据一律降级为「只有首页」，绝不让坏缓存把界面卡住 */
export function deserializeTabs(raw: unknown): TabsState {
  const base = emptyTabs();
  if (!raw || typeof raw !== 'object') return base;
  const list = (raw as PersistedTabs).tabs;
  if (!Array.isArray(list)) return base;
  const seen = new Set<string>([HOME_TAB_KEY]);
  const tabs: TabRecord[] = [...base.tabs];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { key, path, href, title } = item as TabRecord;
    if (typeof key !== 'string' || typeof path !== 'string' || typeof href !== 'string') continue;
    if (!key || key === HOME_TAB_KEY || seen.has(key)) continue;
    // 持久化里本就该被过滤掉；即便脏数据里混进了编辑器标签也不恢复（同上理由）
    if (isEditorKey(key)) continue;
    seen.add(key);
    tabs.push({
      key,
      path,
      href,
      title: typeof title === 'string' && title ? title : path,
      icon: typeof item.icon === 'string' && item.icon ? item.icon : undefined,
      closable: true,
      version: 0,
    });
  }
  return { tabs, lastActive: {} };
}

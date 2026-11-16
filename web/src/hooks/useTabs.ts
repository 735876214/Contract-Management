import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTabsStore } from '@/store/tabs';
import { useTabScope } from '@/layouts/tabScope';
import { editorTabKey, listPathOf } from '@/utils/tabs';

/**
 * 多页签导航的页面侧 Hook 集（状态在 `@/store/tabs`，纯逻辑在 `@/utils/tabs`）。
 */

/**
 * 标签被（**重新**）激活时回调。
 *
 * 为什么需要它：页面被缓存后**不会重新挂载**（这正是多页签要的效果），
 * 于是"我又被显示了"这件事没有任何生命周期可以挂。两处真实需求：
 * 1. `Dashboard` 的「当天首次进入工作台」浮窗复检 —— 页面整天挂着，只靠 `useEffect([])` 一辈子只跑一次；
 * 2. 需要重测量的图表/表格（ECharts 的 autoResize、rc-table 的行列测量）——
 *    全局的那一次 `resize` 派发在 `BasicLayout` 里，页面侧若还有 JS 派生值，用它再算一遍。
 *
 * @param tabKey 本标签的键（菜单页传 `location.pathname`；编辑器页从 `useEditorTab().tabKey` 取）
 */
export function useTabActivate(tabKey: string, cb: () => void): void {
  const activeKey = useTabsStore((s) => s.activeKey);
  const activeToken = useTabsStore((s) => s.activeToken);
  // 回调放 ref：调用方通常传行内箭头函数，进依赖会让 effect 每轮都跑
  const cbRef = useRef(cb);
  cbRef.current = cb;

  useEffect(() => {
    if (!tabKey || activeKey !== tabKey) return;
    // 等一帧：标签从 display:none 切回来时，元素尺寸要等这一帧才可测
    const id = window.requestAnimationFrame(() => cbRef.current());
    return () => window.cancelAnimationFrame(id);
  }, [tabKey, activeKey, activeToken]);
}

/**
 * 跨标签刷新令牌：`bumpRefresh(列表路径)` 之后，该列表标签的取数 `refreshKey` 会变化。
 * 用途只有一个但很关键 —— **编辑器标签保存成功后，让另一个（被缓存的）列表标签重新取数**，
 * 否则会出现"保存成功、列表还是旧数据"。
 */
export function useTabRefresh(listPath: string): number {
  return useTabsStore((s) => s.refreshTokens[listPath] ?? 0);
}

/** 上报"本标签有未保存内容"，TagsView 在关闭它时会先确认 */
export function useTabDirty(tabKey: string, dirty: boolean): void {
  const setDirty = useTabsStore((s) => s.setDirty);
  useEffect(() => {
    if (!tabKey) return;
    setDirty(tabKey, dirty);
  }, [tabKey, dirty, setDirty]);
  // 卸载时清掉标记，避免关掉的标签残留脏状态把后续同名标签也拦一次
  useEffect(() => {
    if (!tabKey) return;
    return () => setDirty(tabKey, false);
  }, [tabKey, setDirty]);
}

export interface EditorTabApi {
  /** `editor` 参数值：`'new'`（新增）/ 记录 id / `null`（本标签是列表页） */
  editorId: string | null;
  /** 本标签是否是编辑器 */
  isEditor: boolean;
  /** 本标签的键（`useTabDirty` / `useTabActivate` / `retitle` 都要它） */
  tabKey: string;
  /** 打开「新增」编辑器标签；`seed` 同 `openEdit`（如「新增收领单」需要先取号） */
  openCreate: (seed?: unknown) => void;
  /**
   * 打开「编辑」编辑器标签。
   * `seed` 是列表页交给编辑器实例的初始数据（列表行）—— 编辑器与列表是**两个独立实例**，
   * 而本仓多数模块没有"按 id 取详情"的接口，所以由列表页把整行递过去。
   */
  openEdit: (id: string, seed?: unknown) => void;
  /** 保存成功 / 取消：关掉编辑器标签并回到列表标签（并让列表重新取数） */
  closeEditor: (opts?: { refresh?: boolean }) => void;
  /** 改本标签的标题（编辑器加载完记录后把「新增/编辑」换成带编号的标题） */
  setTitle: (title: string) => void;
  /** 上报脏状态（关闭标签时确认） */
  setDirty: (dirty: boolean) => void;
  /** 打开编辑器时由列表页传入的初始数据（整行）；`undefined` 表示"新增" */
  seed: unknown;
}

/**
 * 列表页 / 编辑器页共用的入口。
 *
 * 约定：**不新增路由**，用查询参数表达"这一页标签是编辑器"：
 * `/settlement/order`（列表）与 `/settlement/order?editor=new|<id>`（编辑器）。
 * 好处：`routePermissionCodes()` 是精确匹配，加子路由会连带改权限表与
 * `routePermissionParity.spec.mts`；查询参数则零改动。
 *
 * ⚠️ 本 Hook 读的是 **`TabScope` 上下文**而不是 `useLocation()`：两个标签会同时挂在 DOM 上，
 * 用 URL 判断会让被缓存的列表标签也变成编辑器（见 `layouts/tabScope.ts` 的注释）。
 */
export function useEditorTab(listPath: string): EditorTabApi {
  const navigate = useNavigate();
  const scope = useTabScope();
  const tabKey = scope?.tabKey ?? listPath;
  const editorId = scope?.editorId ?? null;
  const isEditor = editorId != null;

  const store = useTabsStore;
  const setTitle = useCallback((title: string) => store.getState().retitle(tabKey, title), [store, tabKey]);
  const setDirty = useCallback((dirty: boolean) => store.getState().setDirty(tabKey, dirty), [store, tabKey]);

  const openCreate = useCallback(
    (seed?: unknown) => {
      const key = editorTabKey(listPath, 'new');
      if (seed !== undefined) store.getState().setEditorSeed(key, seed);
      navigate(key);
    },
    [navigate, listPath, store],
  );

  const openEdit = useCallback(
    (id: string, seed?: unknown) => {
      const key = editorTabKey(listPath, id);
      if (seed !== undefined) store.getState().setEditorSeed(key, seed);
      navigate(key);
    },
    [navigate, listPath, store],
  );

  const closeEditor = useCallback(
    (opts?: { refresh?: boolean }) => {
      if (opts?.refresh !== false) store.getState().bumpRefresh(listPath);
      // 先回列表标签再关自己：顺序反了会有一帧内容区为空
      navigate(listPath);
      store.getState().closeTab(tabKey);
    },
    [navigate, listPath, store, tabKey],
  );

  // 只在**首次渲染**读一次：种子在 store 里按标签键保存，读取不改动它（"刷新标签"重挂载
  // 时还要用）。挂在 ref 上是为了首帧就能初始化表单 —— 用 effect 会晚一帧、表单先渲染成空。
  const seedRef = useRef<unknown>(undefined);
  const seedTaken = useRef(false);
  if (isEditor && !seedTaken.current) {
    seedTaken.current = true;
    seedRef.current = store.getState().getEditorSeed(tabKey);
  }

  return {
    editorId,
    isEditor,
    tabKey,
    openCreate,
    openEdit,
    closeEditor,
    setTitle,
    setDirty,
    seed: seedRef.current,
  };
}

/** 列表路径（编辑器标签 → 它的列表；菜单标签 → 自身）；列表页取自己的刷新令牌时用 */
export function useListPathOf(tabKey: string): string {
  return listPathOf(tabKey);
}

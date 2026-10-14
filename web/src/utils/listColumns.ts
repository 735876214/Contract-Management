/**
 * 列表页「列显隐」的**纯逻辑**（零依赖、无 React / 无 DOM，故可被 `server/test/*.spec.mts` 直接单测）。
 *
 * 设计要点：
 * - **存「隐藏的列」而不是「可见的列」**：后加的新列默认可见，不会因旧配置而永远不出现。
 * - 存储落点是**每浏览器**的显示偏好（localStorage），**不落库**：
 *   列显隐是"我这个屏幕想看什么"，不是全局配置；且 `PUT /system/params` 需 `system:config` 权限，
 *   普通用户根本存不了。（`ledger.columns.config` 是**服务端共享**的另一套语义，勿混用。）
 * - 键名带版本号，改结构时递增即可让旧值自然失效（与 `Sider/utils/storage.ts` 的 `_v3` 同思路）。
 */

export const LIST_COLUMNS_STORAGE_PREFIX = 'cms.list-cols.';
export const LIST_COLUMNS_STORAGE_VERSION = '_v1';

/** 列配置的 localStorage 键（按页面/模块区分） */
export const listColumnsStorageKey = (configKey: string): string =>
  `${LIST_COLUMNS_STORAGE_PREFIX}${configKey}${LIST_COLUMNS_STORAGE_VERSION}`;

/** 取列的稳定标识：优先 `key`，退回 `dataIndex`（antd 两处都可能出现），都没有则空串（= 不可配置） */
export function columnKeyOf(col: { key?: unknown; dataIndex?: unknown } | null | undefined): string {
  const k = col?.key ?? col?.dataIndex;
  return k === null || k === undefined ? '' : String(k);
}

/** localStorage 的最小接口（便于单测注入假实现 / 处理隐私模式抛错） */
export interface ColumnStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 浏览器 localStorage（不可用时返回 null，如隐私模式 / 非浏览器环境） */
export const browserColumnStorage = (): ColumnStorageLike | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** 读取隐藏列集合（无配置 / 值损坏 / 存储不可用 → 空数组 = 全部可见） */
export function readHiddenColumns(
  storage: ColumnStorageLike | null | undefined,
  configKey: string,
): string[] {
  if (!storage || !configKey) return [];
  try {
    const raw = storage.getItem(listColumnsStorageKey(configKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const hidden = Array.isArray(parsed) ? parsed : parsed?.hidden;
    return Array.isArray(hidden) ? hidden.filter((k: unknown) => typeof k === 'string' && k !== '') : [];
  } catch {
    return [];
  }
}

/** 写入隐藏列集合（空集合直接删除键，保持存储干净） */
export function writeHiddenColumns(
  storage: ColumnStorageLike | null | undefined,
  configKey: string,
  hidden: string[],
): void {
  if (!storage || !configKey) return;
  try {
    if (!hidden.length) storage.removeItem(listColumnsStorageKey(configKey));
    else storage.setItem(listColumnsStorageKey(configKey), JSON.stringify({ hidden }));
  } catch {
    /* 存储不可写（配额/隐私模式）不该影响列表渲染 */
  }
}

/** 清除某页的列配置（恢复默认全显） */
export function clearHiddenColumns(storage: ColumnStorageLike | null | undefined, configKey: string): void {
  if (!storage || !configKey) return;
  try {
    storage.removeItem(listColumnsStorageKey(configKey));
  } catch {
    /* 同上 */
  }
}

/**
 * 计算「切换某一列显隐」后的隐藏集合。
 * 规则：受保护列（`lockedKeys`，如「操作」）不可隐藏；**至少保留一列可见**——否则表格只剩空壳，
 * 用户会以为页面坏了。返回原集合表示本次操作被拒绝（等价于把勾选框置灰）。
 */
export function nextHiddenColumns(
  hidden: string[],
  key: string,
  next: boolean,
  allKeys: string[],
  lockedKeys: string[] = [],
): string[] {
  const locked = new Set(lockedKeys);
  const all = allKeys.filter((k) => k !== '');
  if (!key || locked.has(key) || !all.includes(key)) return hidden;
  const current = hidden.filter((k) => all.includes(k));
  const nextHidden = next
    ? current.includes(key)
      ? current
      : [...current, key]
    : current.filter((k) => k !== key);
  // 「至少保留一列」的检查对**隐藏**方向生效（取消隐藏只会让列更多，必然通过）
  const visibleCount = all.filter((k) => !nextHidden.includes(k)).length;
  return visibleCount >= 1 ? nextHidden : current;
}

/** 按隐藏集合过滤列（无标识的列始终保留；受保护列即使被写入隐藏集合也强制显示） */
export function filterVisibleColumns<T extends { key?: unknown; dataIndex?: unknown }>(
  columns: T[],
  hidden: string[],
  lockedKeys: string[] = [],
): T[] {
  const hiddenSet = new Set(hidden);
  const locked = new Set(lockedKeys);
  return (columns || []).filter((col) => {
    const k = columnKeyOf(col);
    if (!k) return true;
    if (locked.has(k)) return true;
    return !hiddenSet.has(k);
  });
}

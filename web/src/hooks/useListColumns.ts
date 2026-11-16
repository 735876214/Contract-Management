import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  browserColumnStorage,
  clearHiddenColumnsByKey,
  hasStoredPreference,
  listColumnsMobileStorageKey,
  listColumnsStorageKey,
  mobileHiddenColumns,
  nextHiddenColumns,
  readHiddenColumnsByKey,
  writeHiddenColumnsByKey,
} from '@/utils/listColumns';

/**
 * 列表页「列显隐」偏好（**每浏览器**持久化在 localStorage，不落库）。
 *
 * 纯逻辑在 `@/utils/listColumns`（无 React/DOM，可被 `server/test/*.spec.mts` 单测），本文件只做 React 壳。
 * 与 `ledger.columns.config`（服务端共享配置）是**两套语义**：台账页继续用它自己的服务端列设置。
 *
 * 用法：`const cols = useListColumns({ configKey, allKeys, lockedKeys: ['op'] })`
 *
 * **移动端列模板**（2026-11-12，docs/09 §4 阶段 B）：
 * 传 `mobileDefaultKeys` + `narrow`（容器宽度 < 720）后，窄容器且**该模式下没存过偏好**时，
 * 只显示预设列（受保护列永远显示）；一旦在窄容器里动过列设置，就听用户的。
 * 移动端偏好存在**独立的存储键**（`@mobile` 后缀）——桌面上关掉列的偏好不会让手机端模板失效，反之亦然。
 */
export interface UseListColumnsOptions {
  /** 存储键（不传 = 不启用列配置） */
  configKey?: string;
  /** 当前全部列标识（用于「至少保留一列」的判断） */
  allKeys: string[];
  /** 不可隐藏的列标识（如「操作」列） */
  lockedKeys?: string[];
  /** 窄容器下的默认列集（4–6 列）；不传 = 不做移动端裁剪 */
  mobileDefaultKeys?: string[];
  /** 是否窄容器（由 `useContainerWidth` 的容器宽度决定，**不是视口**） */
  narrow?: boolean;
}

export interface UseListColumnsResult {
  /** 实际应隐藏的列标识（窄容器未自定义时为移动端预设算出的隐藏集合） */
  hiddenKeys: string[];
  isHidden: (key: string) => boolean;
  /**
   * 切换显隐。`hidden` 传**目标状态是否为「隐藏」**（不传 = 取反）。
   * ⚠️ 勾选框的 `checked` 语义是「**可见**」，两者相反——`Checkbox.onChange` 里必须传 `!e.target.checked`
   * （这里不替调用方取反，是为了让「显式设置」也说得清）。受保护列 / 会清空表格的操作为无效操作，状态不变。
   */
  toggle: (key: string, hidden?: boolean) => void;
  /** 恢复默认（全部可见；窄容器下即回到移动端预设） */
  reset: () => void;
  hiddenCount: number;
  /** 当前模式下是否已有用户自定义偏好（移动端列模板据此决定要不要让位） */
  customized: boolean;
}

export function useListColumns({
  configKey,
  allKeys,
  lockedKeys = [],
  mobileDefaultKeys,
  narrow = false,
}: UseListColumnsOptions): UseListColumnsResult {
  /**
   * 预设与受保护列都可能由调用方写成内联字面量（引用每轮渲染都变），
   * 用**值签名**参与 memo，避免 effect / 返回值抖动。
   */
  const mobileKeysSig = (mobileDefaultKeys ?? []).filter(Boolean).join('|');
  const mobileKeys = useMemo(() => (mobileKeysSig ? mobileKeysSig.split('|') : []), [mobileKeysSig]);
  const lockedKeysSig = lockedKeys.filter(Boolean).join('|');
  const locked = useMemo(() => (lockedKeysSig ? lockedKeysSig.split('|') : []), [lockedKeysSig]);

  /** 窄容器 + 有预设时才切到移动端存储键；桌面偏好完全不受影响 */
  const mobileMode = !!configKey && narrow && mobileKeys.length > 0;
  const storageKey = !configKey
    ? ''
    : mobileMode
      ? listColumnsMobileStorageKey(configKey)
      : listColumnsStorageKey(configKey);

  const [hiddenKeys, setHiddenKeys] = useState<string[]>([]);
  const [customized, setCustomized] = useState(false);

  // 首次挂载 / 切换页面 / 宽窄模式切换时，从**对应存储键**读取
  useEffect(() => {
    const storage = browserColumnStorage();
    setHiddenKeys(readHiddenColumnsByKey(storage, storageKey));
    setCustomized(hasStoredPreference(storage, storageKey));
  }, [storageKey]);

  // 列集合变化（如台账动态列）时剔除已不存在的列，避免隐藏集合无限膨胀
  const validKeys = useMemo(() => allKeys.filter((k) => k !== ''), [allKeys]);
  useEffect(() => {
    setHiddenKeys((prev) => {
      const kept = prev.filter((k) => validKeys.includes(k));
      if (kept.length === prev.length) return prev;
      writeHiddenColumnsByKey(browserColumnStorage(), storageKey, kept);
      return kept;
    });
  }, [storageKey, validKeys]);

  /** 移动端预设算出的隐藏集合；`null` = 不启用（听用户或不做裁剪） */
  const mobileHidden = useMemo(() => {
    if (!mobileMode || customized) return null;
    return mobileHiddenColumns(validKeys, mobileKeys, locked);
  }, [mobileMode, customized, validKeys, mobileKeys, locked]);

  const effectiveHidden = mobileHidden ?? hiddenKeys;

  const isHidden = useCallback((key: string) => effectiveHidden.includes(key), [effectiveHidden]);

  const toggle = useCallback(
    (key: string, hidden?: boolean) => {
      // 移动端预设生效时，第一次改动以「预设的可见集」为基线，避免用户取消勾选后其余列全冒出来
      const base = customized ? hiddenKeys : effectiveHidden;
      const target = hidden === undefined ? !base.includes(key) : hidden;
      const updated = nextHiddenColumns(base, key, target, validKeys, locked);
      if (updated === base) return;
      writeHiddenColumnsByKey(browserColumnStorage(), storageKey, updated);
      setHiddenKeys(updated);
      setCustomized(true);
    },
    [customized, hiddenKeys, effectiveHidden, storageKey, validKeys, locked],
  );

  const reset = useCallback(() => {
    clearHiddenColumnsByKey(browserColumnStorage(), storageKey);
    setHiddenKeys([]);
    setCustomized(false);
  }, [storageKey]);

  return { hiddenKeys: effectiveHidden, isHidden, toggle, reset, hiddenCount: effectiveHidden.length, customized };
}

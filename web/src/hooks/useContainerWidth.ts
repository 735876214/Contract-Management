import { useCallback, useEffect, useState } from 'react';
import {
  CONTAINER_BREAKPOINTS,
  resolveContainerSize,
  type ContainerSize,
} from '@/utils/containerSize';

export interface ContainerWidth<T extends HTMLElement> {
  /**
   * 挂到「被测容器」的根元素上（与 `.cq` 同元素即可）。
   *
   * ⚠️ 是**回调 ref**（不是 `useRef` 对象）：被测元素常常是**条件渲染**的
   * （如 `TaskViewModal` 的正文要等接口回来才渲染），而 `useRef` + `useEffect([])`
   * 会在挂载时读到 `null`、之后永远不再挂观察器 —— 那是个静默失效：
   * 容器明明变窄了，派生档位却一直停在「宽」。
   */
  ref: (node: T | null) => void;
  /** 实测容器宽度（px，内容盒宽）；未测量到时为 0 */
  width: number;
  /** 由宽度派生的容器档位；**未测量到时按「宽」返回**，避免首帧闪一下窄形态 */
  size: ContainerSize;
  /** 是否已拿到首次实测值 */
  measured: boolean;
}

/**
 * 组件级响应式的 **JS 侧**入口：用 `ResizeObserver` 测「自己所在容器」的宽度（docs/08 V2 阶段 1）。
 *
 * **用在哪里**：只用于 **CSS 表达不了的场景**——
 * - 传给 AntD 的 JS prop（如 `Descriptions column`、`Table size`）；
 * - 条件渲染（如编辑器工具条的「更多」按钮）；
 * - 需要按容器宽度算的值（如 `scroll.x`）。
 *
 * 能用 `@container` + `.cq` 表达的布局，一律走 CSS，**不要**用本 hook 到 JS 里判宽度
 * （多一处 JS 判断就多一处和 CSS 打架的机会）。
 *
 * 与 `useResponsive()` 的分工：**视口层归 `useResponsive()`，容器层归本 hook**，两者并存、不互替。
 * 仍然禁止 `window.innerWidth` / `matchMedia`。
 *
 * 首帧宽度未知时按**宽**处理（与 `useResponsive` 首帧按桌面同理），否则会先渲染窄形态再切回来。
 *
 * ⚠️ 测的是**内容盒宽**（`contentRect.width`），与 `@container` 的量法一致。
 * ⚠️ 别把这个 ref 挂在含 `position: fixed; inset: 0` 全屏层的组件根上：
 * 若同时挂了 `.cq`，containment 会让该 fixed 元素以本元素为包含块（`RichTextEditor` 即为此例，
 * 它只用本 hook、不挂 `.cq`）。
 */
export function useContainerWidth<T extends HTMLElement = HTMLDivElement>(): ContainerWidth<T> {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);

  // 回调 ref：元素**每次挂载/卸载**都会通知一次，条件渲染的元素也能被观察到
  const ref = useCallback((el: T | null) => setNode(el), []);

  useEffect(() => {
    if (!node) return;
    // 初始量一次（ResizeObserver 首次回调前先给出确定值，少一帧闪动）
    setWidth(node.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);

  const measured = width > 0;
  const size = measured ? resolveContainerSize(width) : resolveContainerSize(CONTAINER_BREAKPOINTS.lg);

  return { ref, width, size, measured };
}

export default useContainerWidth;

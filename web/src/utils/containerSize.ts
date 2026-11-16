/**
 * 容器断点（**组件级**响应式）的单一事实源 —— 见 DESIGN.md §10.2。
 *
 * 为什么断点值落在 TS 而不是 CSS 变量里：**`@container` 的条件不支持 `var()`**。
 * 2026-10-15 Edge 实测（`--cq-md: 720px` 定义在 `:root` 与容器元素自身两种写法都试过）：
 * `@container (max-width: var(--cq-md))` 整条规则被浏览器**丢弃**，同一条写 `720px` 或
 * `calc(720px)` 均正常升降级。故 CSS 侧只能写字面值。
 *
 * 于是「断点只有一个来源」由 `server/test/containerQuery.spec.mts` 钉住三处一致：
 * 本文件的 `CONTAINER_BREAKPOINTS` ↔ `index.css` 的 `--cq-*` ↔ `styles/containers.css` 的 `@container` 条件。
 * 改断点必须三处同步，漏一处即红。
 *
 * ⚠️ 本模块必须保持**零依赖**（不得有任何 `import`）：`containerQuery.spec.mts` 由 Node
 * 原生类型擦除加载，被它引用的模块一旦出现相对 import 就会加载失败
 * （见 .claude/rules/testing.md 的三条硬约束）。
 */

/** 容器断点（px）。语义见 `resolveContainerSize` */
export const CONTAINER_BREAKPOINTS = {
  /** 极窄（< 480）：手机级容器，表单/工具条降为单列 */
  sm: 480,
  /** 窄（< 720）：组件内部降为「紧凑形态」（单列、冻结列、内边距收敛） */
  md: 720,
  /** 宽（≥ 1024）：容器足够，用完整形态 */
  lg: 1024,
} as const;

export type ContainerBreakpointKey = keyof typeof CONTAINER_BREAKPOINTS;

export interface ContainerSize {
  /** 实测容器宽度（px）。未测量到时为 0 */
  width: number;
  /** 极窄容器（< `sm`） */
  isCompact: boolean;
  /** 窄容器（< `md`）—— 组件内部该换紧凑形态了 */
  isNarrow: boolean;
  /** 宽容器（≥ `lg`） */
  isWide: boolean;
}

/**
 * 由**容器**宽度派生档位（与视口无关）。
 *
 * 与 `@container` 的对照：`isNarrow` 对应 CSS 侧的 `@container (max-width: 720px)`，
 * 量的是同一段宽度（容器内容盒），故 JS 与 CSS 两套判断不会打架。
 *
 * 注：`width <= 0` 会原样算出「极窄」——调用方若在首帧还没量到宽度，应显式按宽处理
 * （`useContainerWidth()` 已如此）。
 */
export function resolveContainerSize(width: number): ContainerSize {
  return {
    width,
    isCompact: width < CONTAINER_BREAKPOINTS.sm,
    isNarrow: width < CONTAINER_BREAKPOINTS.md,
    isWide: width >= CONTAINER_BREAKPOINTS.lg,
  };
}

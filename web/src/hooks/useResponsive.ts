import { Grid } from 'antd';

const { useBreakpoint } = Grid;

/** antd 断点键（与 `ConfigProvider` 的默认断点一致） */
export type BreakpointKey = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

export interface Responsive {
  /**
   * 手机宽度（< 768px）：侧栏改抽屉、表格冻结关键列、表单单列。
   * 阈值取 antd 的 `md`，与 docs/08 的验收目标「≥768 平板完全可用；≥375 手机可读可操作」一致。
   */
  isMobile: boolean;
  /** 平板（768 ~ 991px） */
  isTablet: boolean;
  /** 桌面（≥ 992px） */
  isDesktop: boolean;
  /** antd 原始断点命中表，需要更细粒度判断时使用 */
  screens: Partial<Record<BreakpointKey, boolean>>;
}

/**
 * 全局断点唯一来源（docs/08 阶段 1 基建）。
 *
 * 使用约定：
 * - **不要在组件里用 `window.innerWidth` / `matchMedia`**——统一走本 hook，
 *   否则会出现多个断点来源互相不一致（这是改造前「0 处断点监听、布局不响应」的根因）。
 * - 首帧 `useBreakpoint()` 返回空对象（尚未订阅到断点），此时**按桌面处理**：
 *   若按手机处理，桌面端首帧会把侧栏渲染成抽屉再切回，出现闪动。
 */
export function useResponsive(): Responsive {
  const screens = useBreakpoint();
  const known = Object.keys(screens).length > 0;
  const isMobile = known ? !screens.md : false;
  const isTablet = known ? !!screens.md && !screens.lg : false;
  const isDesktop = known ? !!screens.lg : true;
  return { isMobile, isTablet, isDesktop, screens: screens as Responsive['screens'] };
}

export default useResponsive;

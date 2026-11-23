import type { useAppProps } from 'antd/es/app/context';
import type { MessageInstance } from 'antd/es/message/interface';

/**
 * antd **静态 API** 的主题桥 —— 让组件外的 message / modal 调用也能走当前主题。
 *
 * 为什么需要它：ConfigProvider theme={antdTheme}（见 src/theme.ts）只对 **React 树内**的组件生效。
 * 从 antd 直接 import 的静态 message / Modal.confirm 会在它们自己的 React 根里渲染：
 * 既拿不到动态主题（DESIGN token 不生效，弹出来的提示/确认框与全站风格不一致），
 * message 还会在控制台每次调用都报警：
 *   Warning: [antd: message] Static function can not consume context like dynamic theme
 *
 * 做法：App.tsx 在 <AntdApp> 内挂一个桥接组件，把 App.useApp() 的实例（**带主题上下文**）
 * 存到本模块；这里导出的 message / modal 是 Proxy，每次调用转发给已绑定的实例 ——
 * 于是全部调用点**一行都不用改**，只换 import 来源。
 *
 * 用法（与 antd 同名同形）：
 *   - 组件内新代码：可用 const { message, modal } = App.useApp()（官方推荐，等价效果）；
 *   - 组件外（src/api/http.ts 拦截器、工具函数）：只能用本模块，hooks 在那儿跑不起来。
 *
 * ⚠️ 绑定前的调用（例如首屏渲染前的同步报错）会退化成 no-op —— 与 antd 静态 API
 * 「挂载前调用无效」的既有行为一致；正常情况下桥接组件首次渲染时就已绑定。
 */

type AppMessage = MessageInstance;
type AppModal = useAppProps['modal'];

let boundMessage: AppMessage | null = null;
let boundModal: AppModal | null = null;

/** 仅供 App.tsx 的桥接组件调用；重复调用以后者为准（StrictMode 双跑即此场景） */
export function bindAntdStatic(instances: { message: AppMessage; modal: AppModal }): void {
  boundMessage = instances.message;
  boundModal = instances.modal;
}

const noop = (): undefined => undefined;

const FALLBACK_MESSAGE = {
  info: noop,
  success: noop,
  error: noop,
  warning: noop,
  loading: noop,
  open: noop,
  destroy: noop,
} as unknown as AppMessage;

const FALLBACK_MODAL = {
  info: noop,
  success: noop,
  error: noop,
  warning: noop,
  confirm: noop,
} as unknown as AppModal;

/**
 * 把「取当前实例」包成 Proxy：实例可以晚于调用点初始化（首帧绑定）。
 * 方法必须 bind 回去 —— antd 内部用 this 持有 notice / dialog 容器。
 */
function bridge<T extends object>(current: () => T, fallback: T): T {
  return new Proxy(fallback, {
    get(_target, prop) {
      const src = current();
      const value = (src as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(src) : value;
    },
  });
}

/** 全局提示（替代 antd 的静态 message） */
export const message: AppMessage = bridge(() => boundMessage ?? FALLBACK_MESSAGE, FALLBACK_MESSAGE);

/** 确认框/提示框（替代 antd 的静态 Modal.confirm、Modal.info 等） */
export const modal: AppModal = bridge(() => boundModal ?? FALLBACK_MODAL, FALLBACK_MODAL);

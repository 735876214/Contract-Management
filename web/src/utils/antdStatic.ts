import type { MessageInstance } from 'antd/es/message/interface';

/**
 * antd **静态 API** 的主题桥 —— 让组件外的 message.success(...) 也能走当前主题。
 *
 * 为什么需要它：ConfigProvider theme={antdTheme}（见 src/theme.ts）只对 **React 树内**的组件生效。
 * 从 antd 直接 import 的静态 message 会在它自己的 React 根里渲染：
 * 既拿不到动态主题（DESIGN token 不生效，提示样式与全站不一致），
 * 控制台每次调用还会报警：
 *   Warning: [antd: message] Static function can not consume context like dynamic theme
 *
 * 做法：App.tsx 在 <AntdApp> 内挂一个桥接组件，把 App.useApp().message
 * （**带主题上下文**的实例）存到本模块；这里的 message 是一个 Proxy，
 * 每次调用转发给已绑定的实例 —— 于是全部调用点**一行都不用改**，只换 import 来源。
 *
 * 用法（与 antd 同名同形）：
 *   - 组件内新代码：可用 const { message } = App.useApp()（官方推荐，等价效果）；
 *   - 组件外（src/api/http.ts 拦截器、工具函数）：只能用本模块，hooks 在那儿跑不起来。
 *
 * ⚠️ 绑定前的调用（例如首屏渲染前的同步报错）会退化成 no-op —— 与 antd 静态 API
 * 「挂载前调用无效」的既有行为一致；正常情况下桥接组件首次渲染时就已绑定。
 */
let bound: MessageInstance | null = null;

/** 仅供 App.tsx 的桥接组件调用；重复调用以后者为准（StrictMode 双跑即此场景） */
export function bindAntdMessage(instance: MessageInstance): void {
  bound = instance;
}

const noop = (): undefined => undefined;

const FALLBACK = {
  info: noop,
  success: noop,
  error: noop,
  warning: noop,
  loading: noop,
  open: noop,
  destroy: noop,
} as unknown as MessageInstance;

export const message: MessageInstance = new Proxy(FALLBACK, {
  get(_target, prop) {
    const src: MessageInstance = bound ?? FALLBACK;
    const value = (src as unknown as Record<string | symbol, unknown>)[prop];
    // 绑定实例的方法要 bind 回去，否则 this 丢失（antd 内部用 this 持有 notice 容器）
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(src) : value;
  },
});

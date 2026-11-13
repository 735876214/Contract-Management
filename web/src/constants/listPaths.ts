/**
 * 列表页路径常量（跨标签刷新 / 编辑器页签共用的字面量）。
 *
 * `useTabRefresh(path)`、`bumpRefresh(path)` 与 `useEditorTab(path)` 的键必须是**同一个字符串**，
 * 路由/菜单改名时只改这里，避免某处漏改后刷新静默失效（页面被缓存、看起来"保存成功了但列表没变"）。
 */
export const LIST_PATHS = {
  invoice: '/invoice',
  settlementLedger: '/settlement/ledger',
  contractLedger: '/contract/list',
  dashboard: '/dashboard',
} as const;

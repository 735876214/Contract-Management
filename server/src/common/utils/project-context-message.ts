/**
 * 「缺项目上下文」的唯一文案（零依赖，供装饰器 / service / 取行原语共用）。
 *
 * 前端按**错误码**（`API_CODE.PROJECT_CONTEXT_MISSING = 1412`）判定"刷新项目并重放请求"，
 * 文案只用于展示；两处都从这里取，避免再出现第四种写法（全仓曾有 5 处各写一份）。
 */
export const MISSING_PROJECT_CONTEXT =
  '缺少项目上下文（x-project-id），请刷新页面或重新登录选择项目';

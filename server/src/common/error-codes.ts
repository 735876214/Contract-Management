/**
 * 对外错误码（响应体 `code` 的单一事实源，零依赖）。
 *
 * 前端的**控制流**只认 code，文案只用于展示（2026-11-22 第 24 轮审计）：
 * 改造前 `web/src/api/http.ts` 用 `msg.includes('项目不存在')` 之类的中文文案判断
 * "当前项目已失效 → 刷新项目列表并重放请求"，后端改一个字这套自动恢复就静默失效。
 *
 * 已有码沿用既有约定（见 `common/utils/error-envelope.ts`）：
 * 1001 参数错 / 1401 未登录 / 1403 无权限 / 1404 不存在 / 1500 服务器错。
 * 本文件新增「项目上下文」三兄弟，供项目隔离链路（guard / 装饰器 / 取行原语）统一使用。
 *
 * 前端镜像：`web/src/constants/apiCodes.ts`，由 `test/errorCodesParity.spec.mts` 双向锁死。
 */
export const API_CODE = {
  /** 成功 */
  OK: 0,
  /** 参数/业务校验失败（400，含写冲突映射） */
  BAD_REQUEST: 1001,
  /** 未登录 / 登录失效（401） */
  UNAUTHORIZED: 1401,
  /** 无权限（403，通用权限码不足） */
  FORBIDDEN: 1403,
  /** 记录不存在（404，含 P2025） */
  NOT_FOUND: 1404,
  /** 项目不存在（404）—— 前端据此刷新项目列表 */
  PROJECT_NOT_FOUND: 1410,
  /** 不是该项目成员（403）—— 前端据此刷新项目列表 */
  PROJECT_NOT_MEMBER: 1411,
  /** 缺少项目上下文（400，漏带 `x-project-id`）—— 前端据此刷新项目列表 */
  PROJECT_CONTEXT_MISSING: 1412,
} as const;

export type ApiCode = (typeof API_CODE)[keyof typeof API_CODE];

/**
 * 「当前项目已失效」类错误码：前端收到这些要**刷新项目列表并重放一次**，
 * 而不是把用户丢回登录页（改造前靠中文文案匹配）。
 */
export const PROJECT_STALE_CODES: readonly number[] = [
  API_CODE.PROJECT_NOT_FOUND,
  API_CODE.PROJECT_NOT_MEMBER,
  API_CODE.PROJECT_CONTEXT_MISSING,
];

export function isProjectStaleCode(code: unknown): boolean {
  return typeof code === 'number' && PROJECT_STALE_CODES.includes(code);
}

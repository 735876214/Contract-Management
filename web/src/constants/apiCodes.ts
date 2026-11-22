/**
 * 对外错误码的**前端镜像**（与后端 `server/src/common/error-codes.ts` 一一对应）。
 *
 * 为什么前端要按 code 分支（2026-11-22 第 24 轮审计）：改造前 `api/http.ts` 用
 * `msg.includes('项目不存在')` 判断「当前项目已失效」，后端改一个字，这套
 * 「刷新项目列表并重放请求」的自动恢复就静默失效，用户只能手动退出重登。
 * 文案只用于展示，控制流一律看 code。
 *
 * ⚠️ 本文件与后端常量由 `server/test/errorCodesParity.spec.mts` 双向锁死，改一侧必须改另一侧。
 */
export const API_CODE = {
  OK: 0,
  BAD_REQUEST: 1001,
  UNAUTHORIZED: 1401,
  FORBIDDEN: 1403,
  NOT_FOUND: 1404,
  PROJECT_NOT_FOUND: 1410,
  PROJECT_NOT_MEMBER: 1411,
  PROJECT_CONTEXT_MISSING: 1412,
} as const;

/** 「当前项目已失效」类错误码：刷新项目列表并重放一次，不要把用户丢回登录页 */
export const PROJECT_STALE_CODES: readonly number[] = [
  API_CODE.PROJECT_NOT_FOUND,
  API_CODE.PROJECT_NOT_MEMBER,
  API_CODE.PROJECT_CONTEXT_MISSING,
];

export function isProjectStaleCode(code: unknown): boolean {
  return typeof code === 'number' && PROJECT_STALE_CODES.includes(code);
}

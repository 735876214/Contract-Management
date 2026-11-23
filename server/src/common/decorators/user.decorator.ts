import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { API_CODE } from '../error-codes';
import { MISSING_PROJECT_CONTEXT } from '../utils/project-context-message';

export interface JwtUser {
  userId: string;
  username: string;
  realName: string;
  isSuperAdmin: boolean;
  permissions: string[];
}

export const CurrentUser = createParamDecorator((data: keyof JwtUser, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  const user = request.user as JwtUser;
  return data ? user?.[data] : user;
});

/**
 * 当前项目ID：取自 `x-project-id` 请求头（守卫会把它连同 query 一起定到 `request.projectId`），
 * 缺失时返回明确 400，避免 Prisma 空参 500。
 *
 * ⚠️ **不接受 `body.projectId`**（2026-10-20 审计 P1）：守卫在 multer 之前跑，multipart 的 body
 * 那时还没解析，成员关系校验会因此被跳过；若这里再回落到 body，攻击者就能把项目 ID 放进表单字段
 * 读别人的数据。`window.open` 下载无法带请求头，走 `?projectId=`（query 在守卫阶段可见，仍受校验）。
 */
export const ProjectId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  const projectId = request.projectId || request.headers['x-project-id'] || request.query?.projectId;
  if (!projectId) {
    // 文案与错误码都走单一来源：前端按 code 1412 触发「刷新项目列表并重放请求」
    throw new BadRequestException({ code: API_CODE.PROJECT_CONTEXT_MISSING, message: MISSING_PROJECT_CONTEXT });
  }
  return projectId;
});

export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.ip || request.headers['x-forwarded-for'] || request.connection?.remoteAddress || '';
});

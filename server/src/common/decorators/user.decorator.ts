import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface JwtUser {
  userId: string;
  username: string;
  realName: string;
  isSuperAdmin: boolean;
  permissions: string[];
  deptId?: string;
}

export const CurrentUser = createParamDecorator((data: keyof JwtUser, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  const user = request.user as JwtUser;
  return data ? user?.[data] : user;
});

/** 当前项目ID：取自请求头 x-project-id，兼容 query/body */
export const ProjectId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.projectId || request.headers['x-project-id'] || request.query?.projectId || request.body?.projectId || null;
});

export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.ip || request.headers['x-forwarded-for'] || request.connection?.remoteAddress || '';
});

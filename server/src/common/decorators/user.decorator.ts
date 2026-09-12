import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';

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

/** 当前项目ID：取自请求头 x-project-id，兼容 query/body；缺失时返回明确 400，避免 Prisma 空参 500 */
export const ProjectId = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  const projectId =
    request.projectId || request.headers['x-project-id'] || request.query?.projectId || request.body?.projectId;
  if (!projectId) {
    throw new BadRequestException('缺少项目上下文（x-project-id），请刷新页面或重新登录选择项目');
  }
  return projectId;
});

export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.ip || request.headers['x-forwarded-for'] || request.connection?.remoteAddress || '';
});

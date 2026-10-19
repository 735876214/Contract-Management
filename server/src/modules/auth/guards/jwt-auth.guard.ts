import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { JwtUser } from '../../../common/decorators/user.decorator';
import { ProjectAccessService } from '../../../common/services/project-access.service';

/**
 * 项目上下文**不属于**鉴权白名单的路由：这些接口是「找回可用项目」的入口
 * （登录信息、我的项目列表），若也按 x-project-id 校验成员关系，
 * 用户被移出某个项目后会因残留的旧项目 ID 被 403 锁死、无法切换回自己的项目。
 */
const PROJECT_CHECK_SKIP_PREFIXES = ['/api/auth', '/api/projects'];

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private projectAccess: ProjectAccessService,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return ok;

    /**
     * 项目隔离（2026-10-19 全量审查 P1）：JWT 只证明「是谁」，`x-project-id` 只表达
     * 「想进哪个项目」；权限码是全局 RBAC，**必须**再按 projectMember 校验成员归属，
     * 否则换个项目 ID 就能按 id 读走/改掉别的项目的数据。
     * 请求未带项目上下文时不在这里拦（由 `ProjectId` 装饰器给出明确 400）。
     */
    const request = context.switchToHttp().getRequest();
    const projectId = request.headers['x-project-id'] || request.query?.projectId || request.body?.projectId;
    if (!projectId) return ok;
    const path: string = request.originalUrl || request.url || '';
    if (PROJECT_CHECK_SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) return ok;
    const user = request.user as JwtUser | undefined;
    if (!user?.userId) return ok;
    await this.projectAccess.assertAccess(user.userId, String(projectId), user.isSuperAdmin);
    return ok;
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw err || new UnauthorizedException('登录已失效，请重新登录');
    }
    return user;
  }
}

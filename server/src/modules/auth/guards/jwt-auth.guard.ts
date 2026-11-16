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
    /**
     * ⚠️ **只认 header 与 query，绝不读 body**（2026-10-20 审计 P1）。
     *
     * 守卫跑在 multer 之前：multipart 请求的 `req.body` 此刻还是空对象，于是
     * 「没读到 projectId」被放行；而参数装饰器在 handler 阶段又能读到 `body.projectId`，
     * 攻击者只要不带 `x-project-id`、把项目 ID 放进表单字段，就能读别的项目的数据。
     * body 里的 projectId 一律不作数（前端所有请求都带 header；`window.open` 下载走 query，
     * query 在守卫阶段可见，因此仍会被成员关系校验）。
     */
    const projectId = request.headers['x-project-id'] || request.query?.projectId;
    // 定上下文：装饰器只读这里，避免「守卫校验 A 项目、handler 用 B 项目」的口径分裂
    if (projectId) request.projectId = String(projectId);
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

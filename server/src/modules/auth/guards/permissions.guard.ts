import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { JwtUser } from '../../../common/decorators/user.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtUser;
    if (!user) throw new ForbiddenException('未登录');
    if (user.isSuperAdmin) return true;
    const has = required.some((code) => user.permissions?.includes(code));
    if (!has) throw new ForbiddenException(`缺少权限：${required.join(' 或 ')}`);
    return true;
  }
}

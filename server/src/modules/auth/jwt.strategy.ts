import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaClient, private authService: AuthService) {
    super({
      // 支持 Bearer 头与 URL ?token= 两种方式（后者用于文件下载链接，window.open 无法携带请求头）
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => req?.query?.token || null,
      ]),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'cms-super-secret-key',
    });
  }

  async validate(payload: any) {
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.status !== 1) return null;
    const permissions = await this.authService.getPermissions(user.id, user.isSuperAdmin);
    return {
      userId: user.id,
      username: user.username,
      realName: user.realName,
      isSuperAdmin: user.isSuperAdmin,
      deptId: user.deptId,
      permissions,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaClient } from '@prisma/client';
import { AuthService } from './auth.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaClient, private authService: AuthService) {
    super({
      // 支持 Bearer 头；文件/下载等 GET 请求额外接受 httpOnly Cookie（由 /auth/login 与
      // /auth/file-session 下发）。**不再接受 URL ?token=**：JWT 会落在访问日志/浏览器历史里。
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => {
          if (req?.method !== 'GET') return null;
          const raw = String(req?.headers?.cookie || '');
          const m = raw.match(/(?:^|;\s*)cms_token=([^;]+)/);
          return m ? decodeURIComponent(m[1]) : null;
        },
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
      permissions,
    };
  }
}

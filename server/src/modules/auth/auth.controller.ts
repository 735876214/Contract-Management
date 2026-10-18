import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser, ClientIp, JwtUser } from '../../common/decorators/user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

class LoginDto {
  @IsString()
  @IsNotEmpty({ message: '用户名不能为空' })
  username: string;

  @IsString()
  @IsNotEmpty({ message: '密码不能为空' })
  password: string;
}

class ChangePwdDto {
  @IsString()
  @IsNotEmpty({ message: '旧密码不能为空' })
  oldPassword: string;

  @IsString()
  @MinLength(6, { message: '新密码长度不能少于 6 位' })
  newPassword: string;
}

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() body: LoginDto, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    const ua = (res.req as any)?.headers?.['user-agent'] || '';
    const result = await this.authService.login(body.username, body.password, ip, ua);
    // 文件/下载链接无法带 Authorization 头：登录时同步下发 httpOnly Cookie（仅 GET 接受）
    setFileCookie(res, result.token);
    return result;
  }

  /**
   * 为“已有本地 token 的会话”补发文件 Cookie（前端启动时调用一次）。
   * 只接受 Authorization: Bearer，不读取 URL query token（避免 JWT 落在日志/历史里）。
   */
  @UseGuards(JwtAuthGuard)
  @Get('file-session')
  fileSession(@Req() req: any, @Res({ passthrough: true }) res: Response) {
    const auth = String(req?.headers?.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token) setFileCookie(res, token);
    return { ok: !!token };
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async profile(@CurrentUser() user: JwtUser) {
    return this.authService.profile(user.userId, user.isSuperAdmin);
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout() {
    return true;
  }

  @UseGuards(JwtAuthGuard)
  @Post('password')
  async changePassword(@CurrentUser() user: JwtUser, @Body() body: ChangePwdDto) {
    return this.authService.changePassword(user.userId, body.oldPassword, body.newPassword);
  }
}

/**
 * 文件读取 Cookie（httpOnly）：`/api/files/**` 与 GET 下载链接无法携带 Authorization 头，
 * 由浏览器自动带上该 Cookie。**JwtStrategy 只对 GET 请求接受它**，POST/PUT/DELETE 仍必须 Bearer，
 * 避免引入 CSRF 面。生产 HTTPS 下自动加 Secure。
 */
function setFileCookie(res: Response, token: string): void {
  const req: any = res.req;
  const secure = !!req?.secure || req?.headers?.['x-forwarded-proto'] === 'https';
  res.cookie('cms_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

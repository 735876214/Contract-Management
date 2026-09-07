import { Body, Controller, Get, Post, Res, UseGuards } from '@nestjs/common';
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
    return this.authService.login(body.username, body.password, ip, ua);
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

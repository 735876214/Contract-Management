import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';

@Module({
  imports: [
    PassportModule,
    /**
     * 用 registerAsync + ConfigService 而不是顶层 `process.env.X`：
     * 模块装饰器参数在**导入期**求值，此时 ConfigModule 还没加载 `.env`，
     * 于是签发用的是兜底密钥、而 JwtStrategy 在构造期读到了真密钥 → 签出来的 token 一律校验失败
     * （表现为「本地 .env 跑后端，登录成功但所有接口 1401」）。工厂在依赖注入期执行，顺序正确。
     */
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.get<string>('JWT_SECRET') || 'cms-super-secret-key',
        signOptions: { expiresIn: cfg.get<string>('JWT_EXPIRES_IN') || '7d' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtAuthGuard, PermissionsGuard],
  exports: [AuthService, JwtAuthGuard, PermissionsGuard],
})
export class AuthModule {}

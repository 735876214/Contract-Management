import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { OperationLogInterceptor } from './common/interceptors/operation-log.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LogService } from './common/services/log.service';
import { PrismaClient } from '@prisma/client';
import { StorageService } from './common/services/storage.service';
import { runStartupSeed } from './seed';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix('api');
  // 授权委托书等需要返回「打印就绪 HTML」的接口，跳过统一 JSON 包装，
  // 否则前端拿到的会是 {code,data,message} 而非可直接 write 的文档
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(
    new ResponseInterceptor((ctx) => {
      const req = ctx.switchToHttp().getRequest();
      return req.headers['x-raw-response'] === '1';
    }),
    // 需求 2.6：全部写操作（增删改、导入）自动留痕
    new OperationLogInterceptor(app.get(PrismaClient), app.get(LogService)),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // 静态文件服务：把存储根目录整体暴露为 `/api/files/**`（本地磁盘实现的对外读取口）。
  // 目录的创建/解析**统一走 StorageService**（服务端唯一的文件 I/O 入口，见该服务文件头）；
  // ⚠️ 将来换 MinIO/S3 时，要改为代理或 302 重定向（本轮不做：无对象存储基础设施时无法验收）。
  const absUploadDir = app.get(StorageService).ensureRoot();
  app.useStaticAssets(absUploadDir, { prefix: '/api/files' });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`CMS server running on http://localhost:${port}/api`);

  // 启动播种（空库首启初始化 + 每次启动的历史数据修正）统一入口。
  // ⚠️ 必须走这一条：它用事务级咨询锁把整段播种**串行化**，避免多进程同时启动时
  // 在字典/参数的唯一键上撞 P2002 导致"播种中断、后面的项漏播"（CI 的并发集成测试必现）。
  // 内部顺序：admin → 默认项目（依赖 admin）→ 字典/参数 → 历史数据修正。
  const prisma = app.get<PrismaClient>(PrismaClient);
  await runStartupSeed(prisma);
}
bootstrap();

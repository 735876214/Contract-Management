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
import { seedAdmin, seedDictAndParams, seedDefaultProject, fixLegacyData } from './seed';

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

  // 首次部署空库时，自动 seed 一个默认管理员账号，保证可直接登录
  const prisma = app.get<PrismaClient>(PrismaClient);
  await seedAdmin(prisma);
  // 首次部署空库时，创建一个默认项目，解决 admin 登录报「缺少项目上下文（x-project-id）」的问题
  // （顺序须位于 seedAdmin 之后，因为默认项目 seed 依赖 admin 已存在）
  await seedDefaultProject(prisma);
  // 首次部署空库时，写入字典类型 / 字典项 / 系统参数初始数据，保证字典与系统参数页面有内容
  await seedDictAndParams(prisma);
  // 每次启动修正有明确缺陷的历史数据（幂等，见函数注释）
  await fixLegacyData(prisma);
}
bootstrap();

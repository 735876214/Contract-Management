import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { OperationLogInterceptor } from './common/interceptors/operation-log.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LogService } from './common/services/log.service';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';
import { seedAdmin } from './seed';

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

  const uploadDir = process.env.UPLOAD_DIR || './uploads';
  const absUploadDir = path.isAbsolute(uploadDir) ? uploadDir : path.join(process.cwd(), uploadDir);
  if (!fs.existsSync(absUploadDir)) fs.mkdirSync(absUploadDir, { recursive: true });
  app.useStaticAssets(absUploadDir, { prefix: '/api/files' });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  console.log(`CMS server running on http://localhost:${port}/api`);

  // 首次部署空库时，自动 seed 一个默认管理员账号，保证可直接登录
  const prisma = app.get<PrismaClient>(PrismaClient);
  await seedAdmin(prisma);
}
bootstrap();

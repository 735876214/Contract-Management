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

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(
    new ResponseInterceptor(),
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
}
bootstrap();

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { OperationLogInterceptor } from './common/interceptors/operation-log.interceptor';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LogService } from './common/services/log.service';
import { PrismaClient } from '@prisma/client';
import { StorageService } from './common/services/storage.service';
import { requestContext } from './common/services/request-context';
import { randomUUID } from 'node:crypto';
import { runStartupSeed } from './seed';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 请求上下文（项目 id）→ AsyncLocalStorage：service 里按 id 取行的查询靠它补
  // `projectId` 过滤，堵住「守卫只管"能不能进这个项目"、不管这条数据属不属于它」的跨项目 IDOR。
  // 必须在路由之前注册；只认 header 与 query（multipart 的 body 在守卫阶段还读不到）。
  app.use((req: any, res: any, next: any) => {
    const raw = req?.headers?.['x-project-id'] ?? req?.query?.projectId;
    const projectId = Array.isArray(raw) ? String(raw[0] ?? '').trim() : String(raw ?? '').trim();
    /**
     * 链路 id（2026-11-24）：上游（nginx / 网关）给了就沿用，否则生成一个短 uuid。
     * 必须在 `next()` **之前**写响应头——否则异常分支先返回，头就丢了（恰恰是最需要它的场景）。
     */
    const incoming = String(req?.headers?.['x-request-id'] ?? '').trim();
    const requestId = incoming && incoming.length <= 64 ? incoming : randomUUID().slice(0, 8);
    res?.setHeader?.('x-request-id', requestId);
    requestContext.run({ projectId: projectId || undefined, requestId }, () => next());
  });

  // 优雅关闭：容器 stop / 滚动更新时触发 onModuleDestroy → PrismaService.$disconnect()，
  // 否则连接只能等 PostgreSQL 侧超时回收（2026-11-21 P0-3）。
  app.enableShutdownHooks();

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

  // 本地存储根目录的创建仍走 StorageService；读取不再用 useStaticAssets（那是公开的），
  // 改由 FileServeController（JwtAuthGuard）代理 /api/files/**，URL 形态保持不变。
  app.get(StorageService).ensureRoot();

  const port = process.env.PORT || 3000;
  await app.listen(port);
  new Logger('Bootstrap').log(`CMS server running on http://localhost:${port}/api`);

  // 启动播种（空库首启初始化 + 每次启动的历史数据修正）统一入口。
  // ⚠️ 必须走这一条：它用事务级咨询锁把整段播种**串行化**，避免多进程同时启动时
  // 在字典/参数的唯一键上撞 P2002 导致"播种中断、后面的项漏播"（CI 的并发集成测试必现）。
  // 内部顺序：admin → 默认项目（依赖 admin）→ 字典/参数 → 历史数据修正。
  const prisma = app.get<PrismaClient>(PrismaClient);
  await runStartupSeed(prisma);
}
bootstrap();

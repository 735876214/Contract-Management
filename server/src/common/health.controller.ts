import { Controller, Get, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Public } from './decorators/public.decorator';

/**
 * 健康检查（2026-11-21 质量评估 P2：可观测性缺口）。
 *
 * 为什么需要它：`docker-compose.yml` 现在的 app healthcheck 只做 **TCP 连通**探测
 * （`net.connect(8080)`）——数据库挂了端口照样通，容器仍被判 healthy，
 * 于是「服务在、业务全 500」没有人发现。
 *
 * 口径：
 * - `GET /api/health`：**就绪探针**，真打一次 `SELECT 1`；DB 不可用 → 503（error 信封）。
 * - 不需要登录：探针不该依赖凭据；返回体不含任何业务数据（只放开 uptime/耗时）。
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  private readonly startedAt = Date.now();

  constructor(private readonly prisma: PrismaClient) {}

  @Public()
  @Get()
  async check() {
    const dbStartedAt = Date.now();
    let db = 'down';
    let dbError: string | null = null;
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      db = 'up';
    } catch (e: any) {
      dbError = e?.message ? String(e.message).split('\n')[0] : 'unknown';
      this.logger.error(`健康检查：数据库不可用 -> ${dbError}`);
    }
    const payload = {
      status: db === 'up' ? 'ok' : 'down',
      db,
      dbLatencyMs: Date.now() - dbStartedAt,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
    if (db !== 'up') throw new ServiceUnavailableException(payload);
    return payload;
  }
}

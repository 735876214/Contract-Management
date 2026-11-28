import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Redis 全局模块：**没有 REDIS_URL 也能启动**（自动降级进程内），
 * 所以不需要 `@Optional()` 注入，调用方直接 `constructor(private readonly redis: RedisService)`。
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}

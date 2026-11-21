import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma 连接的生命周期宿主（2026-11-21 质量评估 P0-3）。
 *
 * 背景：原实现是 `useFactory: () => new PrismaClient(...)` —— 没有任何生命周期钩子，
 * 既不在启动时 `$connect()` 预热（首个请求承担建连成本），也不在容器停止/滚动更新时
 * `$disconnect()`（连接只能等 PostgreSQL 侧超时回收）。
 *
 * 两条硬约束（改动时别破坏）：
 * 1. **注入 token 仍是 `PrismaClient`**：`main.ts` 与 `test-integration/helpers.ts` 用
 *    `app.get(PrismaClient)`，57 个 service 的构造器按类型注入 `private prisma: PrismaClient`。
 *    故 `PrismaModule` 用 `useExisting` 把本实例同时挂在 `PrismaService` 与 `PrismaClient`
 *    两个 token 上（见 `prisma.module.ts`）。
 * 2. **不要在别处再 `new PrismaClient()`**（`server/prisma/seed.ts` 等独立进程脚本除外）：
 *    多实例会各自占一条连接池，且 `$transaction` / 咨询锁的可见性对不上。
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // 与改造前的实例选项保持一致（只放 error/warn，避免每个查询都刷日志）
    super({ log: ['error', 'warn'] });
  }

  async onModuleInit(): Promise<void> {
    // 快速失败：连不上就在启动期暴露，不要在第一个用户请求上才报错
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    // 依赖 main.ts 的 `app.enableShutdownHooks()` 才能在 SIGTERM/SIGINT 时走到这里
    await this.$disconnect();
  }
}

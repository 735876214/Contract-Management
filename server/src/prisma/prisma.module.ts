import { Global, Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from './prisma.service';

/**
 * 全局 Prisma 提供者。
 *
 * 用 `useExisting` 把**同一个实例**同时挂在两个 token 上（2026-11-21 P0-3）：
 * - `PrismaClient`：供既有代码零改动地按类型注入（57 个 service、`main.ts`、集成测试 helper）；
 * - `PrismaService`：供需要生命周期钩子（$connect/$disconnect）的地方使用。
 */
@Global()
@Module({
  providers: [PrismaService, { provide: PrismaClient, useExisting: PrismaService }],
  exports: [PrismaService, PrismaClient],
})
export class PrismaModule {}

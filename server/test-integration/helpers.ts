import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AppModule } from '../src/app.module';
import { fixLegacyData, seedDictAndParams } from '../src/seed';

/**
 * DB 集成测试的公共设施（**需要真实 PostgreSQL**，与 `server/test/*.spec.*` 的纯函数套件分开）。
 *
 * 设计要点：
 * - 用 `NestFactory.createApplicationContext(AppModule)` 拿到**真实 DI** 后直接调 service
 *   （不引入 `@nestjs/testing`——未安装且非必需），因此覆盖的是真事务、真约束、真闸门；
 * - **每个用例自建独立 `Project`**：业务表都带 `projectId`，天然互不干扰；
 *   测试库是一次性的，故不做删表清理（CI 每次都是全新库，本地重复跑只会多几行数据）；
 * - **防呆**：库名不含 `test`/`int` 时**拒绝启动**，避免误连开发库/生产库写数据。
 *
 * 本地跑法见 docs/development.md §5「DB 集成测试」。
 */

export interface IntContext {
  app: INestApplicationContext;
  prisma: PrismaClient;
  get<T>(token: any): T;
}

/** 唯一后缀，避免同一次运行内多次建库实体撞名 */
export const uniq = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL || '';
  if (!url) {
    throw new Error(
      '集成测试需要 DATABASE_URL（示例：postgresql://cms:cms123456@localhost:15432/cms_int?schema=public）',
    );
  }
  const dbName = (url.split('/').pop() || '').split('?')[0];
  if (!/test|int/i.test(dbName)) {
    throw new Error(`拒绝在疑似正式库上跑集成测试：库名「${dbName}」必须含 test 或 int`);
  }
}

/** 字典与系统参数只需初始化一次（幂等 upsert）；`dict.validate()` 依赖它们存在 */
let dictsReady = false;

export async function bootIntApp(): Promise<IntContext> {
  assertTestDatabase();
  if (!process.env.UPLOAD_DIR) {
    process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'cms-int-uploads-'));
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaClient) as PrismaClient;
  if (!dictsReady) {
    // 空测试库只有表结构，没有字典项；`dict.validate()` 会因字典项缺失而 400
    await seedDictAndParams(prisma);
    await fixLegacyData(prisma);
    dictsReady = true;
  }
  return { app, prisma, get: <T>(token: any) => app.get(token) as T };
}

export async function makeProject(prisma: PrismaClient, tag: string) {
  const code = uniq(`INT-${tag}`).toUpperCase();
  return prisma.project.create({ data: { code, name: `集成测试项目 ${code}` } });
}

export async function makeSupplier(prisma: PrismaClient, projectId: string, tag = 'sup') {
  return prisma.supplier.create({ data: { name: `集成测试供应商 ${uniq(tag)}`, projectId } as any });
}

export async function makeContract(
  prisma: PrismaClient,
  params: {
    projectId: string;
    code?: string;
    name?: string;
    amount?: number | null;
    status?: string | null;
    supplierId?: string | null;
    taskId?: string | null;
    /** 补充协议：`'Y'` + `parentContractId` 指向主合同 */
    isSupplement?: string | null;
    parentContractId?: string | null;
    supplementTypeCode?: string | null;
    /** 带符号增量（合同当前金额 = 主合同 + Σ changeAmount） */
    changeAmount?: number | null;
  },
) {
  const code = params.code ?? uniq('INT-HT').toUpperCase();
  return prisma.contract.create({
    data: {
      projectId: params.projectId,
      code,
      name: params.name ?? `集成测试合同 ${code}`,
      amount: params.amount === undefined ? null : params.amount,
      status: params.status === undefined ? null : params.status,
      supplierId: params.supplierId ?? null,
      taskId: params.taskId ?? null,
      isSupplement: params.isSupplement ?? null,
      parentContractId: params.parentContractId ?? null,
      supplementTypeCode: params.supplementTypeCode ?? null,
      changeAmount: params.changeAmount === undefined ? null : params.changeAmount,
    } as any,
  });
}

export async function makeTask(
  prisma: PrismaClient,
  params: { projectId: string; type?: string; status?: string; stage?: number },
) {
  return prisma.procurementTask.create({
    data: {
      projectId: params.projectId,
      taskNo: uniq('INT-TASK').toUpperCase(),
      type: params.type ?? 'SINGLE',
      content: '集成测试用采购任务',
      status: params.status ?? 'NOT_STARTED',
      stage: params.stage ?? 0,
    } as any,
  });
}

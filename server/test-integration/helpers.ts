import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { AppModule } from '../src/app.module';
import { runStartupSeed } from '../src/seed';

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

/**
 * 读 `web/src/api/types/*.ts` 里 `export const NAME = [ ... ] as const;` 的键名清单。
 *
 * 为什么按**文本**解析而不是 import：`web/package.json` 是 `"type": "module"`，
 * CJS 的 int spec `require` 它会 `ERR_REQUIRE_ESM`。抽不到时直接抛错（别让用例静默空转）。
 *
 * 用法：`readWebTypeKeys('web/src/api/types/payment.ts', 'PAYMENT_RECORD_ROW_KEYS')`。
 */
export function readWebTypeKeys(relPath: string, constName: string): string[] {
  const abs = path.join(__dirname, '..', '..', relPath);
  const src = readFileSync(abs, 'utf8');
  const m = src.match(new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\] as const;`));
  if (!m) throw new Error(`没在 ${relPath} 里找到 ${constName}（契约解析锚点已失效）`);
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/** 从 service 源码里抽 `query.*` 实际读取的键（+ page/pageSize，它们由 paginate() 消费）。 */
export function readQueryParamKeys(absFile: string, methodAnchor: string, nextAnchor: string): string[] {
  const src = readFileSync(absFile, 'utf8');
  const start = src.indexOf(methodAnchor);
  if (start < 0) throw new Error(`没找到 ${methodAnchor}（切片锚点已失效）`);
  const body = src.slice(start, src.indexOf(nextAnchor, start));
  const used = new Set([...body.matchAll(/query\.([a-zA-Z_][\w]*)/g)].map((m) => m[1]));
  used.add('page');
  used.add('pageSize');
  return [...used].sort();
}

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
  // 集成测试无生产凭据：JWT_SECRET 未设置时给一个固定测试值（jwt.strategy 会拒绝缺省/占位值）
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'cms-int-test-secret';
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaClient) as PrismaClient;
  if (!dictsReady) {
    // 空测试库只有表结构，没有字典项；`dict.validate()` 会因字典项缺失而 400。
    // ⚠️ 必须走 `runStartupSeed()` 而不是直接调两个 seed 函数：
    // `node --test` **每个 spec 文件一个进程**，而每个进程都会走到这里（`dictsReady` 是进程内的），
    // 空库上它们会**并发**插入同一批字典 → Prisma 的 upsert 非原子 → 撞 P2002 → 播种中断 → 用例红。
    // `runStartupSeed` 用事务级咨询锁把播种串行化（生产多副本启动同理）。
    await runStartupSeed(prisma);
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

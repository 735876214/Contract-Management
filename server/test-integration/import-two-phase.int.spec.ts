import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { ImportTaskService } from '../src/common/services/import-task.service';
import { ImportRunnerService, RowError } from '../src/common/services/import-runner.service';

/**
 * 集成测试 · **导入两阶段（全成功或全失败）与幂等去重**。
 *
 * 覆盖（对应用户点名的「关键流程」里的导入）：
 * ① 一行非法 → **零写入**（不是"写一半再回滚一半"）且返回行级错误；
 * ② 全部合法 → 写入并给出 created 计数；
 * ③ 同一份文件（模块+文件名+行数+内容摘要）并发重复提交 → **复用同一个任务**（挡双击）。
 *
 * ⚠️ 异步路径（>1000 行）在本套件里用「无副作用的小行集 + 1001 行触发异步」覆盖到
 * **任务创建与去重**这一层；完整异步执行（进度心跳/错误报告落盘）由
 * `scripts/verify-async-import.js` 与单测 `test/importTask.spec.mts` 覆盖。
 */
describe('集成 · 导入两阶段与去重', () => {
  let ctx: IntContext;
  let tasks: ImportTaskService;
  let runner: ImportRunnerService;

  before(async () => {
    ctx = await bootIntApp();
    tasks = ctx.get<ImportTaskService>(ImportTaskService);
    runner = ctx.get<ImportRunnerService>(ImportRunnerService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('一行非法 → 全失败且零写入（行级错误可定位）', async () => {
    const project = await makeProject(ctx.prisma, 'IMP-BAD');
    const prefix = uniq('IMPBAD').toUpperCase();
    let writeCalls = 0;
    const rows = [{ name: `${prefix}-A` }, { name: '' }, { name: `${prefix}-C` }];

    const outcome = await runner.run(rows, {
      plan: async (r: any) => {
        const name = String(r.name ?? '').trim();
        if (!name) throw new RowError('名称必填', 'name');
        return { name };
      },
      write: async (plans: any[], tx: any) => {
        writeCalls += 1;
        await tx.supplier.createMany({ data: plans.map((p: any) => ({ name: p.name, projectId: project.id })) });
        return { created: plans.length };
      },
    });

    assert.equal(outcome.errors.length, 1, '应报告 1 行错误');
    assert.equal(outcome.errors[0].row, 4, '行号应为第 4 行（startRowNo 默认 3）');
    assert.equal(outcome.created, 0);
    assert.equal(writeCalls, 0, '有错误时**不得**执行写入');
    assert.equal(
      await ctx.prisma.supplier.count({ where: { name: { startsWith: prefix } } }),
      0,
      '全失败时数据库里不应留下任何本批数据',
    );
  });

  it('全部合法 → 写入并返回 created 计数', async () => {
    const project = await makeProject(ctx.prisma, 'IMP-OK');
    const prefix = uniq('IMPOK').toUpperCase();
    const rows = [1, 2, 3].map((i) => ({ name: `${prefix}-${i}` }));

    const outcome = await runner.run(rows, {
      plan: async (r: any) => ({ name: String(r.name).trim() }),
      write: async (plans: any[], tx: any) => {
        for (const p of plans) await tx.supplier.create({ data: { name: p.name, projectId: project.id } });
        return { created: plans.length };
      },
    });

    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.created, 3);
    assert.equal(await ctx.prisma.supplier.count({ where: { name: { startsWith: prefix } } }), 3, '数据应真写入');
  });

  it('同一份文件并发提交 → 复用同一个任务（幂等去重）', async () => {
    const project = await makeProject(ctx.prisma, 'IMP-DEDUP');
    const fileName = `${uniq('dedup')}.xlsx`;
    // > 1000 行才走异步路径（去重只在该路径生效）
    const rows = Array.from({ length: 1001 }, (_, i) => ({ no: i + 1 }));
    const opts = {
      plan: async (r: any) => ({ no: r.no }),
      write: async (plans: any[]) => ({ created: 0, updated: 0 } as any),
    };
    const make = (tag: string) =>
      tasks.submit({ module: 'supplier', moduleName: `集成测试-${tag}`, projectId: project.id, fileName }, rows, opts);

    const [a, b] = await Promise.all([make('A'), make('B')]);

    assert.ok(a.taskId, '应返回任务 ID（异步路径）');
    assert.equal(a.async, true, '1001 行应走异步');
    assert.equal(b.taskId, a.taskId, '并发提交同一份文件应复用同一任务');
    assert.equal(
      await ctx.prisma.importTask.count({ where: { fileName, projectId: project.id } }),
      1,
      '同一份文件只应产生一个导入任务',
    );

    // 等后台执行收尾，避免进程退出时留下半截任务（仅为了日志干净，断言不依赖结果）
    for (let i = 0; i < 40; i++) {
      const t = await ctx.prisma.importTask.findUnique({ where: { id: a.taskId! } });
      if (t && ['SUCCESS', 'FAILED'].includes(String(t.status))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundException } from '@nestjs/common';
import { requestContext } from '../src/common/services/request-context';
import { findScopedOrThrow, projectWhere } from '../src/common/utils/project-scope';

/**
 * 项目口径的单据读取（第 3 轮审计的收口设施）。
 *
 * 背景：`@ProjectId()` 只回答「你能不能进这个项目」，不回答「URL 里这条数据的 id 属不属于它」。
 * 本轮把若干 `findUnique({ where: { id } })` 改成 `findFirst({ where: projectWhere(id) })`，
 * 这条 spec 锁住三个语义：有上下文就带 projectId、没上下文保持原样、查不到抛 404。
 */

const P1 = 'proj-aaa';
const P2 = 'proj-bbb';

/** 在指定项目上下文里执行（模拟中间件注入） */
function inProject<T>(projectId: string | undefined, fn: () => T): T {
  return requestContext.run({ projectId }, fn);
}

describe('projectWhere：按请求上下文补 projectId', () => {
  it('没有上下文时不追加过滤（启动任务/单测/跨项目聚合保持原行为）', () => {
    assert.deepEqual(inProject(undefined, () => projectWhere('row-1')), { id: 'row-1' });
  });

  it('有上下文时追加 projectId', () => {
    assert.deepEqual(inProject(P1, () => projectWhere('row-1')), { id: 'row-1', projectId: P1 });
  });

  it('额外条件与 projectId 合并，且调用方传的 projectId 不会覆盖上下文', () => {
    assert.deepEqual(
      inProject(P1, () => projectWhere('row-1', { statusCode: 'NORMAL' })),
      { id: 'row-1', projectId: P1, statusCode: 'NORMAL' },
    );
    // 反例：调用方硬塞别的项目 id —— 上下文优先（最后展开）
    assert.deepEqual(inProject(P1, () => projectWhere('row-1', { projectId: P2 })), { id: 'row-1', projectId: P1 });
  });

  it('上下文是空串/未设置都按「没有上下文」处理', () => {
    assert.deepEqual(inProject('', () => projectWhere('row-1')), { id: 'row-1' });
    assert.deepEqual(projectWhere('row-2'), { id: 'row-2' });
  });
});

describe('findScopedOrThrow：跨项目 id 一律 404', () => {
  /** 假 delegate：只认 where.id + where.projectId */
  const rows = [
    { id: 'row-1', projectId: P1, amount: 100 },
    { id: 'row-2', projectId: P2, amount: 200 },
  ];
  const delegate = {
    findFirst: async (args: any) => {
      const where = args?.where || {};
      return rows.find((r) => r.id === where.id && (!where.projectId || r.projectId === where.projectId)) || null;
    },
  };

  it('同项目的记录正常返回', async () => {
    const row = await inProject(P1, () => findScopedOrThrow(delegate, 'row-1', '记录不存在'));
    assert.equal((row as any).amount, 100);
  });

  it('别的项目的 id 抛 404（文案不含「无权访问」，不暴露存在性）', async () => {
    await assert.rejects(
      () => inProject(P1, () => findScopedOrThrow(delegate, 'row-2', '记录不存在')),
      (e: any) => {
        assert.ok(e instanceof NotFoundException);
        assert.equal(e.message, '记录不存在');
        return true;
      },
    );
  });

  it('完全不存在的 id 同样 404', async () => {
    await assert.rejects(() => inProject(P1, () => findScopedOrThrow(delegate, 'nope', '记录不存在')), NotFoundException);
  });

  it('没有上下文时按 id 直读（与改造前一致，供 seed/定时任务使用）', async () => {
    const row = await findScopedOrThrow(delegate, 'row-2', '记录不存在');
    assert.equal((row as any).amount, 200);
  });
});

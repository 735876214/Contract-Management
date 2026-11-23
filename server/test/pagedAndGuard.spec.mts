import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pagedAll } from '../src/common/utils/paged.ts';
import { assertInProject, buildResult, paginate } from '../src/common/utils/helpers.ts';

/**
 * 共用原语锁：`pagedAll`（按页取全量）与 `assertInProject`（项目归属 404）。
 *
 * 为什么单独锁：这两段逻辑此前被复制到 8 个模块各一份（导出截断）与 8 个模块各一份
 * （按 id 越权），2026-10 的五轮审计里同一 bug 反复出现。收敛成单一实现后，
 * 行为一旦被改动（例如 pagedAll 少取最后一页、assertInProject 把不存在当 403），
 * 影响的是全站，必须有测试钉住。
 */

describe('pagedAll：按页取全量', () => {
  const pageOf = (all: number[], pageSize: number) => async (page: number) => {
    const start = (page - 1) * pageSize;
    return { list: all.slice(start, start + pageSize), total: all.length };
  };

  it('跨多页取全，且不重复、不遗漏', async () => {
    const all = Array.from({ length: 1234 }, (_, i) => i);
    const calls: number[] = [];
    const out = await pagedAll(async (page, pageSize) => {
      calls.push(page);
      return pageOf(all, pageSize)(page);
    }, 500);
    assert.equal(out.length, 1234);
    assert.deepEqual(out, all);
    // 500*3 页足够（1234 = 500+500+234），第 4 页不该再查
    assert.deepEqual(calls, [1, 2, 3]);
  });

  it('恰好整页时也能结束（不会丢最后一条，也不无限循环）', async () => {
    const all = Array.from({ length: 1000 }, (_, i) => i);
    const out = await pagedAll(pageOf(all, 500), 500);
    assert.equal(out.length, 1000);
  });

  it('只有一页时只查一次', async () => {
    let calls = 0;
    const out = await pagedAll(async () => {
      calls += 1;
      return { list: [1, 2, 3], total: 3 };
    }, 500);
    assert.deepEqual(out, [1, 2, 3]);
    assert.equal(calls, 1);
  });

  it('空结果集返回空数组', async () => {
    const out = await pagedAll(async () => ({ list: [], total: 0 }), 500);
    assert.deepEqual(out, []);
  });

  it('后端不给 total 时靠「不足一页」终止', async () => {
    const pages = [[1, 2], [3, 4], [5]];
    let i = 0;
    const out = await pagedAll(async () => ({ list: pages[i++] ?? [] }), 2);
    assert.deepEqual(out, [1, 2, 3, 4, 5]);
  });

  it('maxPages 是防空转保险丝', async () => {
    // 永远返回整页（模拟后端不认 page 参数的病态实现）
    const out = await pagedAll(async () => ({ list: [1, 2] }), 2, 3);
    assert.equal(out.length, 6);
  });
});

describe('assertInProject：按 id 的记录归属', () => {
  it('属于本项目 → 原样返回', () => {
    const row = { id: 'x', projectId: 'p1' };
    assert.equal(assertInProject(row, 'p1', '发票不存在'), row);
  });

  it('记录不存在 → 404（用调用方给的文案）', () => {
    assert.throws(() => assertInProject(null, 'p1', '发票不存在'), /发票不存在/);
  });

  it('不属于本项目 → 同样 404（不暴露记录存在性）', () => {
    assert.throws(() => assertInProject({ projectId: 'p2' }, 'p1', '发票不存在'), /发票不存在/);
  });

  it('未传 projectId（内部调用/集成测试）→ 只校验存在', () => {
    const row = { projectId: 'p2' };
    assert.equal(assertInProject(row, undefined), row);
    assert.throws(() => assertInProject(null, undefined), /记录不存在/);
  });

  it('记录的 projectId 为空时，带项目上下文一律拒绝', () => {
    assert.throws(() => assertInProject({ projectId: null }, 'p1'), /记录不存在/);
  });
});

describe('buildResult：分页元数据必须与真实切片同一口径', () => {
  it('默认口径与 paginate 一致（pageSize 20）', () => {
    const out = buildResult([], 0, {});
    assert.equal(out.page, 1);
    assert.equal(out.pageSize, 20);
  });

  it('**放宽上限时**（导出/批量场景）响应 pageSize 必须跟着放宽，不能恒夹 500', () => {
    // 改造前 buildResult 恒 `Math.min(500, …)`：paginate(query, 5000) 真取 5000 行，
    // 响应却写 pageSize=500 → 前端"每页 N 条"与真实切片不符（2026-11-22 审计）
    assert.equal(paginate({ page: 1, pageSize: 5000 }, 5000).take, 5000);
    const out = buildResult([], 0, { page: 2, pageSize: 5000 }, 5000);
    assert.equal(out.pageSize, 5000);
    assert.equal(out.page, 2);
  });

  it('pageSize 超过该接口上限时按上限夹（与 paginate 的 take 相同）', () => {
    const out = buildResult([], 0, { pageSize: 99999 }, 5000);
    assert.equal(out.pageSize, paginate({ pageSize: 99999 }, 5000).pageSize);
  });

  it('非法页码/页大小走兜底（与 paginate 完全一致）', () => {
    for (const q of [{ page: 0 }, { page: -3 }, { pageSize: 0 }, { pageSize: 'abc' }, { page: null }]) {
      const p = paginate(q);
      const b = buildResult([], 0, q);
      assert.equal(b.page, p.page, JSON.stringify(q));
      assert.equal(b.pageSize, p.pageSize, JSON.stringify(q));
    }
  });
});

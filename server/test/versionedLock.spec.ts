import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { versionedUpdate } from '../src/common/utils/helpers';

/**
 * 乐观锁的**原子**写入（第 24 轮审计）。
 *
 * 原来的写法是「`assertVersion` 读一次 → 按 id 无条件 update」：校验与写入之间没有互斥，
 * 另一个请求在这个窗口提交后，本次写入照样覆盖对方（lost update），version 还 +1 ——
 * 系统认为一切正常。`versionedUpdate` 把版本条件放进 `where`，并统一把 P2025 转 409。
 *
 * 用假 delegate 锁住**调用形态**（参数怎么拼、失败怎么映射），无需数据库。
 */
const fakeDelegate = (behaviour: 'ok' | 'missing') => {
  const calls: any[] = [];
  return {
    calls,
    update: async (args: any) => {
      calls.push(args);
      if (behaviour === 'missing') {
        const e: any = new Error('Record to update not found.');
        e.code = 'P2025';
        throw e;
      }
      return { id: args.where.id, version: args.where.version + 1 };
    },
  };
};

describe('versionedUpdate：版本条件写入', () => {
  it('把 version 放进 where，并在同一次写入里 +1', async () => {
    const d = fakeDelegate('ok');
    const row: any = await versionedUpdate(d, 'c1', 3, { name: 'x' });
    assert.equal(d.calls.length, 1);
    assert.deepEqual(d.calls[0].where, { id: 'c1', version: 3 });
    assert.deepEqual(d.calls[0].data, { name: 'x', version: { increment: 1 } });
    assert.equal(row.id, 'c1');
  });

  it('调用方在 data 里塞的 version 会被覆盖（否则锁又失效）', async () => {
    const d = fakeDelegate('ok');
    await versionedUpdate(d, 'c1', 3, { version: 99, name: 'x' });
    assert.deepEqual(d.calls[0].data.version, { increment: 1 });
  });

  it('版本号按数字比较：字符串 "3" 与 3 等价', async () => {
    const d = fakeDelegate('ok');
    await versionedUpdate(d, 'c1', '3', {});
    assert.equal(d.calls[0].where.version, 3);
  });

  it('命中不了行（版本不符/已被删除）→ 409，而不是 404 或 500', async () => {
    const d = fakeDelegate('missing');
    await assert.rejects(
      () => versionedUpdate(d, 'c1', 3, {}),
      (e: any) => e instanceof ConflictException && /刷新后重试/.test(e.message),
    );
  });

  it('非 P2025 的错误原样抛出（不要把真实故障伪装成并发冲突）', async () => {
    const d = {
      update: async () => {
        const e: any = new Error('boom');
        e.code = 'P2003';
        throw e;
      },
    };
    await assert.rejects(
      () => versionedUpdate(d, 'c1', 3, {}),
      (e: any) => e.code === 'P2003',
    );
  });

  it('include 透传（物资清单行需要带 materialBase 回前端）', async () => {
    const d = fakeDelegate('ok');
    await versionedUpdate(d, 'c1', 1, {}, { include: { materialBase: true } });
    assert.deepEqual(d.calls[0].include, { materialBase: true });
  });
});

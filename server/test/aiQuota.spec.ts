import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { AiQuota } from '../src/modules/ai/ai-quota';

/**
 * AI 配额（每用户每小时）。
 *
 * 2026-10-20 审计 P2：原来「调用前扣、失败也计」—— 上游一挂（超时/5xx/空正文），
 * 用户连点几下就把额度烧光并被锁一小时，而一次结果都没拿到。
 * `refund()` 让失败不占额度；这里锁住「退还有效、且不会退成负数」。
 */
describe('AiQuota：滑动窗口计数与失败退还', () => {
  it('未超限时逐次计数', () => {
    const q = new AiQuota();
    for (let i = 0; i < 3; i++) q.consume('u1', 5);
    assert.equal(q.used('u1'), 3);
  });

  it('达到上限后抛 429', () => {
    const q = new AiQuota();
    q.consume('u1', 2);
    q.consume('u1', 2);
    assert.throws(
      () => q.consume('u1', 2),
      (e: unknown) => e instanceof HttpException && e.getStatus() === 429,
    );
  });

  it('limit<=0 视为不限次', () => {
    const q = new AiQuota();
    for (let i = 0; i < 50; i++) q.consume('u1', 0);
    assert.equal(q.used('u1'), 50);
  });

  it('不同用户各自计数', () => {
    const q = new AiQuota();
    q.consume('u1', 1);
    q.consume('u2', 1);
    assert.equal(q.used('u1'), 1);
    assert.equal(q.used('u2'), 1);
  });

  it('refund 退还一次（失败不占额度）', () => {
    const q = new AiQuota();
    q.consume('u1', 1);
    q.refund('u1');
    assert.equal(q.used('u1'), 0);
    // 退还后还能再调一次，不会撞上「已达上限」
    q.consume('u1', 1);
    assert.equal(q.used('u1'), 1);
  });

  it('refund 不会退成负数（重复退还/没调用过也安全）', () => {
    const q = new AiQuota();
    q.refund('nobody');
    assert.equal(q.used('nobody'), 0);
    q.consume('u1', 3);
    q.refund('u1');
    q.refund('u1');
    assert.equal(q.used('u1'), 0);
  });

  it('窗口滑过后旧计数失效', async () => {
    const q = new AiQuota();
    q.consume('u1', 1, 40);
    assert.throws(() => q.consume('u1', 1, 40));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(q.used('u1', 40), 0);
    q.consume('u1', 1, 40); // 窗口已过，可再次调用
  });
});

/**
 * 2026-10-22 第 22 轮审计 P3：`hits` 只在「同一用户再次调用」时才过滤自己那条，
 * 调用过 AI 却再不回来的用户条目永久留着 —— 单实例常驻进程下 Map 只增不减（慢速内存泄漏）。
 * 修复：条目数超过 `PRUNE_THRESHOLD` 时顺手扫一遍，把窗口内已无命中的用户整体删掉。
 * 下面把「阈值以下不扫（常态零成本）/ 阈值以上必须回收」钉成回归。
 */
describe('AiQuota：过期用户条目回收（防内存泄漏）', () => {
  it('条目数未超阈值时不回收（常态零成本）', async () => {
    const q = new AiQuota();
    for (let i = 0; i < 150; i++) q.consume(`u${i}`, 0, 20);
    await new Promise((r) => setTimeout(r, 35));
    q.consume('fresh', 0, 20);
    assert.ok(q.userCount() > 150, `未超阈值不应回收，实际 ${q.userCount()}`);
  });

  it('条目数超阈值时回收窗口内已无命中的用户', async () => {
    const q = new AiQuota();
    for (let i = 0; i < 250; i++) q.consume(`u${i}`, 0, 20);
    assert.equal(q.userCount(), 250);
    await new Promise((r) => setTimeout(r, 35)); // 250 个用户全部过期
    q.consume('fresh', 0, 20);
    assert.equal(q.userCount(), 1, `过期用户应被回收，只剩 fresh，实际 ${q.userCount()}`);
    assert.equal(q.used('fresh', 20), 1);
  });

  it('回收不影响窗口内仍活跃用户的计数', async () => {
    const q = new AiQuota();
    for (let i = 0; i < 250; i++) q.consume(`u${i}`, 0, 200);
    q.consume('keep', 0, 200);
    q.consume('keep', 0, 200);
    await new Promise((r) => setTimeout(r, 30));
    q.consume('fresh', 0, 200); // 触发 prune：仍在窗口内的用户不得被删
    assert.equal(q.userCount(), 252, `窗口内用户应被保留，实际 ${q.userCount()}`);
    assert.equal(q.used('keep', 200), 2);
  });
});

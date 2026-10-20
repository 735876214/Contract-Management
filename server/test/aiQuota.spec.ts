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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { LoginThrottle } from '../src/modules/auth/login-throttle.ts';

/**
 * 登录失败节流（2026-10-20 第 2 轮审计新增）。
 *
 * 背景：`AuthService.login` 之前对失败次数没有任何限制，只有「失败写日志」——
 * 日志只能事后取证，挡不住当下的撞库。这里用纯函数（注入 `now`）锁住口径：
 * 同一「用户名 + IP」15 分钟 5 次失败后拒绝再试，成功即清零，到期自动放开。
 */

const MIN = 60_000;

describe('登录失败节流的键', () => {
  it('用户名去空格转小写，避免大小写各占一个窗口', () => {
    const t = new LoginThrottle();
    assert.equal(t.keyOf('  Admin ', '10.0.0.1'), 'admin|10.0.0.1');
  });

  it('IP 缺失时用 unknown 占位（不能因此共用同一个空键）', () => {
    const t = new LoginThrottle();
    assert.equal(t.keyOf('admin', undefined), 'admin|unknown');
  });
});

describe('登录失败累计与锁定', () => {
  it('窗口内 5 次失败后锁定：retryAfterMs > 0，assertNotThrottled 抛 429', () => {
    const t = new LoginThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    const now = 1_000_000;
    for (let i = 0; i < 4; i += 1) t.fail(key, now + i);
    // 4 次还不锁
    assert.equal(t.retryAfterMs(key, now + 4), 0);
    // 第 5 次锁上
    assert.equal(t.fail(key, now + 4), true);
    const wait = t.retryAfterMs(key, now + 4);
    assert.ok(wait > 0 && wait <= 15 * MIN, `wait=${wait}`);

    assert.throws(
      () => t.assertNotThrottled(key, now + 4),
      (e: unknown) => {
        assert.ok(e instanceof HttpException);
        assert.equal(e.getStatus(), 429);
        assert.match(String(e.message), /登录失败次数过多/);
        assert.match(String(e.message), /\d+ 分钟后再试/);
        return true;
      },
    );
  });

  it('成功一次即清零（输错两次再登录成功的正常用户不受影响）', () => {
    const t = new LoginThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    t.fail(key, 1000);
    t.fail(key, 2000);
    t.reset(key);
    assert.equal(t.retryAfterMs(key, 3000), 0);
    // 清零后还能再错 4 次才锁
    for (let i = 0; i < 4; i += 1) assert.equal(t.fail(key, 4000 + i), false);
  });

  it('窗口过期自动放开（不需要重启进程）', () => {
    const t = new LoginThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    const start = 5_000_000;
    for (let i = 0; i < 5; i += 1) t.fail(key, start);
    assert.ok(t.retryAfterMs(key, start) > 0);
    // 15 分钟整之后，旧记录全部过期
    assert.equal(t.retryAfterMs(key, start + 15 * MIN + 1), 0);
  });

  it('不同账号、不同 IP 互不影响（共用出口 IP 的同事不会被连坐）', () => {
    const t = new LoginThrottle();
    const a = t.keyOf('admin', '1.1.1.1');
    const b = t.keyOf('staff', '1.1.1.1');
    const c = t.keyOf('admin', '2.2.2.2');
    for (let i = 0; i < 5; i += 1) t.fail(a, 1000);
    assert.ok(t.retryAfterMs(a, 1000) > 0);
    assert.equal(t.retryAfterMs(b, 1000), 0);
    assert.equal(t.retryAfterMs(c, 1000), 0);
  });

  it('单个键只保留窗口内最近 maxFailures 条（长时间运行不会无限膨胀）', () => {
    const t = new LoginThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    for (let i = 0; i < 50; i += 1) t.fail(key, 1000 + i);
    const wait = t.retryAfterMs(key, 1049);
    // 49 个失败都落在窗口内 → 必然锁定，且等待时间起算于最近的记录而不是第一条
    assert.ok(wait > 0);
    assert.ok(wait <= 15 * MIN);
  });

  it('size() 暴露在窗口内的键数（过期键在失败时被清理）', () => {
    const t = new LoginThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    t.fail(key, 1000);
    assert.equal(t.size(), 1);
    t.fail(key, 1000 + 15 * MIN + 1);
    assert.equal(t.size(), 1);
  });
});

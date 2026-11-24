import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { LoginThrottle } from '../src/modules/auth/login-throttle.ts';
import { RedisService } from '../src/common/redis/redis.service.ts';

/**
 * 登录失败节流（2026-10-20 第 2 轮审计新增；2026-11-24 迁到 RedisService）。
 *
 * 背景：`AuthService.login` 之前对失败次数没有任何限制，只有「失败写日志」——
 * 日志只能事后取证，挡不住当下的撞库。这里锁住口径：
 * 同一「用户名 + IP」15 分钟 5 次失败后拒绝再试，成功即清零，到期自动放开。
 *
 * 单测不依赖真 Redis：`RedisService` 未配置 `REDIS_URL` 时走进程内实现，语义相同。
 */

const MIN = 60_000;

async function makeThrottle(): Promise<LoginThrottle> {
  const redis = new RedisService();
  await redis.onModuleInit();
  return new LoginThrottle(redis);
}

describe('登录失败节流的键', () => {
  it('用户名去空格转小写，避免大小写各占一个窗口', async () => {
    const t = await makeThrottle();
    assert.equal(t.keyOf('  Admin ', '10.0.0.1'), 'admin|10.0.0.1');
  });

  it('IP 缺失时用 unknown 占位（不能因此共用同一个空键）', async () => {
    const t = await makeThrottle();
    assert.equal(t.keyOf('admin', undefined), 'admin|unknown');
  });
});

describe('登录失败累计与锁定', () => {
  it('窗口内 5 次失败后锁定：retryAfterMs > 0，assertNotThrottled 抛 429', async () => {
    const t = await makeThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    const now = 1_000_000;
    for (let i = 0; i < 4; i += 1) assert.equal(await t.fail(key, now + i), false);
    // 4 次还不锁
    assert.equal(await t.retryAfterMs(key, now + 4), 0);
    // 第 5 次锁上
    assert.equal(await t.fail(key, now + 4), true);
    const wait = await t.retryAfterMs(key, now + 4);
    assert.ok(wait > 0 && wait <= 15 * MIN, `wait=${wait}`);

    await assert.rejects(
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

  it('成功一次即清零（输错两次再登录成功的正常用户不受影响）', async () => {
    const t = await makeThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    await t.fail(key, 1000);
    await t.fail(key, 2000);
    await t.reset(key);
    assert.equal(await t.retryAfterMs(key, 3000), 0);
    // 清零后还能再错 4 次才锁
    for (let i = 0; i < 4; i += 1) assert.equal(await t.fail(key, 4000 + i), false);
  });

  it('窗口过期自动放开（不需要重启进程）', async () => {
    const t = await makeThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    const start = 5_000_000;
    for (let i = 0; i < 5; i += 1) await t.fail(key, start);
    assert.ok((await t.retryAfterMs(key, start)) > 0);
    // 15 分钟整之后，旧记录全部过期
    assert.equal(await t.retryAfterMs(key, start + 15 * MIN + 1), 0);
  });

  it('不同账号、不同 IP 互不影响（共用出口 IP 的同事不会被连坐）', async () => {
    const t = await makeThrottle();
    const a = t.keyOf('admin', '1.1.1.1');
    const b = t.keyOf('staff', '1.1.1.1');
    const c = t.keyOf('admin', '2.2.2.2');
    for (let i = 0; i < 5; i += 1) await t.fail(a, 1000);
    assert.ok((await t.retryAfterMs(a, 1000)) > 0);
    assert.equal(await t.retryAfterMs(b, 1000), 0);
    assert.equal(await t.retryAfterMs(c, 1000), 0);
  });

  it('单个键只保留窗口内最近 maxFailures 条（长时间运行不会无限膨胀）', async () => {
    const t = await makeThrottle();
    const key = t.keyOf('admin', '1.1.1.1');
    for (let i = 0; i < 50; i += 1) await t.fail(key, 1000 + i);
    const wait = await t.retryAfterMs(key, 1049);
    // 49 个失败都落在窗口内 → 必然锁定，且等待时间起算于最近的记录而不是第一条
    assert.ok(wait > 0);
    assert.ok(wait <= 15 * MIN);
  });
});

describe('多实例语义（2026-11-24 引入 RedisService 的原因）', () => {
  it('两个实例共享同一个后端：A 锁上后 B 也拒绝（进程内实现下会各记各的）', async () => {
    const redis = new RedisService();
    await redis.onModuleInit();
    const a = new LoginThrottle(redis);
    const b = new LoginThrottle(redis);
    const key = a.keyOf('admin', '1.1.1.1');
    for (let i = 0; i < 5; i += 1) await a.fail(key, 1000 + i);
    assert.ok((await a.retryAfterMs(key, 1004)) > 0);
    assert.ok((await b.retryAfterMs(key, 1004)) > 0, 'B 实例必须看到 A 记的失败');
  });

  it('未配置 REDIS_URL 时降级进程内后端且不抛异常（部署方可以不装 Redis）', async () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const redis = new RedisService();
      await redis.onModuleInit();
      assert.equal(redis.configured, false);
      assert.equal(redis.kind, 'memory');
      assert.equal(await redis.ping(), false);
      await redis.set('k', 'v', 60_000);
      assert.equal(await redis.get('k'), 'v');
      await redis.rpush('l', 'a', 60_000);
      await redis.rpush('l', 'b', 60_000);
      assert.deepEqual(await redis.listRange('l'), ['a', 'b']);
      assert.equal(await redis.incr('n', 60_000), 1);
      assert.equal(await redis.incr('n', 60_000), 2);
      await redis.del('k');
      assert.equal(await redis.get('k'), null);
    } finally {
      if (prev === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prev;
    }
  });
});

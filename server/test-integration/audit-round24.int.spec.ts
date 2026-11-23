import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { bootIntApp, uniq, type IntContext } from './helpers';
import { AuthService } from '../src/modules/auth/auth.service';
import { SysParamService } from '../src/common/services/sys-param.service';
import { versionedUpdate } from '../src/common/utils/helpers';

/**
 * 集成测试 · **第 24 轮审计的三条安全/一致性修复**（需要真 DB、真事务）。
 *
 * 纯函数套件只能证明"函数写得对"，证明不了"闸门接上没有"。这里用真库锁三件事：
 * ① **乐观锁是原子的**：同一版本号并发两次写入，只能有一个成功——旧实现
 *    （`assertVersion` + 按 id 无条件 update）两个都会成功、后写静默覆盖前写；
 * ② **`/auth/profile` 不再回吐 `ai.apiKey`**（产品口径「密钥只写不读」），
 *    同时服务端自己仍读得到（过滤只发生在对外出口）；
 * ③ **改密即失效旧令牌**：`User.tokenVersion` +1，JWT 载荷里的 `tv` 随之变化。
 */
describe('集成 · 第 24 轮审计修复', () => {
  let ctx: IntContext;
  let auth: AuthService;
  let sysParam: SysParamService;

  before(async () => {
    ctx = await bootIntApp();
    auth = ctx.get<AuthService>(AuthService);
    sysParam = ctx.get<SysParamService>(SysParamService);
  });
  after(async () => {
    await ctx.app.close();
  });

  it('乐观锁：同一版本并发写入只有一个成功，version 只涨 1', async () => {
    const p = await ctx.prisma.project.create({
      data: { code: uniq('INT-LOCK').toUpperCase(), name: '并发锁测试项目' },
    });
    assert.equal(p.version, 0);

    const results = await Promise.allSettled([
      versionedUpdate(ctx.prisma.project, p.id, p.version, { name: '写入方A' }),
      versionedUpdate(ctx.prisma.project, p.id, p.version, { name: '写入方B' }),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(ok.length, 1, '必须恰好一个成功（旧实现两个都会成功 = 静默覆盖）');
    assert.equal(failed.length, 1);
    assert.ok(
      failed[0].reason instanceof ConflictException,
      `失败方应是 409 冲突，实际是 ${failed[0].reason?.name}`,
    );

    const after = await ctx.prisma.project.findUnique({ where: { id: p.id } });
    assert.equal(after?.version, p.version + 1, 'version 只能涨 1（两个都写才会变 2）');
    assert.ok(['写入方A', '写入方B'].includes(String(after?.name)));
  });

  it('/auth/profile 的 params 不含 ai.apiKey，但服务端仍读得到', async () => {
    const secret = 'sk-int-should-not-leak-0123456789';
    await sysParam.set('ai.apiKey', secret);
    await sysParam.refresh();

    const user = await ctx.prisma.user.create({
      data: {
        username: uniq('int-profile'),
        password: await bcrypt.hash('int-pass-123', 10),
        realName: '画像测试用户',
        status: 1,
      },
    });

    const profile: any = await auth.profile(user.id, false);
    assert.equal('ai.apiKey' in (profile.params ?? {}), false, '密钥不得出现在 profile.params 里');
    // 对照：服务端内部读取不受影响（过滤只在对外出口）
    assert.equal(await sysParam.get('ai.apiKey'), secret);
  });

  it('改密即失效旧令牌：tokenVersion +1，新 JWT 的 tv 跟着变', async () => {
    const username = uniq('int-tv');
    const user = await ctx.prisma.user.create({
      data: { username, password: await bcrypt.hash('old-pass-123', 10), realName: '令牌版本用户', status: 1 },
    });
    assert.equal(user.tokenVersion, 0);

    const first: any = await auth.login(username, 'old-pass-123', '127.0.0.1', 'int-spec');
    const payloadOf = (token: string): any =>
      JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(payloadOf(first.token).tv, 0, '登录签发的 token 必须带当前令牌版本');

    await auth.changePassword(user.id, 'old-pass-123', 'new-pass-1234');

    const bumped = await ctx.prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(bumped?.tokenVersion, 1, '改密必须把 tokenVersion +1（旧 token 立即失效）');

    // 旧口令不能再登录，新口令可以，且新 token 的 tv 已更新
    await assert.rejects(() => auth.login(username, 'old-pass-123', '127.0.0.1', 'int-spec'));
    const second: any = await auth.login(username, 'new-pass-1234', '127.0.0.1', 'int-spec');
    assert.equal(payloadOf(second.token).tv, 1);
  });
});

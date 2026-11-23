// @domains: auth, system
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { bootIntApp, uniq, type IntContext } from './helpers';
import { AuthService } from '../src/modules/auth';

/**
 * 集成测试 · **登录 / 改密的真实写路径**（此前只有纯函数层的口令策略与 JWT 校验）。
 *
 * 纯函数测试只能证明 `checkPasswordStrength()` 判得对、`jwt.strategy` 的比对逻辑对，
 * 证明不了这些规则**真的接在登录与改密上**。这里用真库 + 真 bcrypt 锁五条契约：
 *
 * ① 账号枚举防线：密码错与用户不存在返回**同一句**文案（先比密码、再判停用）；
 * ② 停用账号：**密码正确**时才提示「账号已停用」（不知道口令的人看不到这句）；
 * ③ 口令策略：弱口令改密 400，且**不落库**；
 * ④ 改密成功 → `tokenVersion` +1（旧 token 立即失效，这是"改完密码别处还能用"的修复点）；
 * ⑤ 撞库节流：同「用户名+IP」连错 5 次 → **429**（不是继续校验密码）。
 */
describe('集成 · 登录与改密', () => {
  let ctx: IntContext;
  let svc: AuthService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<AuthService>(AuthService);
  });
  after(async () => {
    await ctx.app.close();
  });

  async function makeUser(tag: string, opts: { password?: string; status?: number; isSuperAdmin?: boolean } = {}) {
    const username = uniq(tag);
    const plain = opts.password ?? 'int-pass-1a';
    const user = await ctx.prisma.user.create({
      data: {
        username,
        password: await bcrypt.hash(plain, 10),
        realName: '集成测试账号',
        status: opts.status ?? 1,
        isSuperAdmin: opts.isSuperAdmin ?? false,
      } as any,
    });
    return { user, username, plain };
  }

  it('① 账号枚举：密码错与用户不存在返回同一句文案', async () => {
    const { username } = await makeUser('auth-enum');

    let wrongMsg = '';
    await assert.rejects(
      () => svc.validateUser(username, 'definitely-wrong-1'),
      (e: any) => {
        assert.ok(e instanceof UnauthorizedException);
        wrongMsg = e.message;
        return true;
      },
      '密码错必须 401',
    );

    await assert.rejects(
      () => svc.validateUser(uniq('no-such-user'), 'any-password-1'),
      (e: any) => {
        assert.ok(e instanceof UnauthorizedException);
        assert.equal(e.message, wrongMsg, '用户不存在与密码错必须同一句（否则等于给了枚举信标）');
        return true;
      },
    );
  });

  it('② 停用账号：只有密码正确时才提示「账号已停用」', async () => {
    const { username, plain } = await makeUser('auth-off', { status: 0 });

    await assert.rejects(
      () => svc.validateUser(username, 'wrong-password-1'),
      (e: any) => e instanceof UnauthorizedException && /用户名或密码错误/.test(e.message),
      '不知道口令的人不该看到"账号已停用"',
    );
    await assert.rejects(
      () => svc.validateUser(username, plain),
      (e: any) => e instanceof UnauthorizedException && /已停用/.test(e.message),
      '密码正确时停用提示才有意义',
    );
  });

  it('③④ 改密：弱口令 400 且不落库；成功则 tokenVersion +1', async () => {
    const { user, plain } = await makeUser('auth-pwd', { password: 'int-pass-1a' });
    assert.equal(user.tokenVersion, 0);

    await assert.rejects(
      () => svc.changePassword(user.id, plain, 'abcdefgh'),
      (e: any) => e instanceof BadRequestException && /密码/.test(e.message),
      '纯字母 8 位必须拒',
    );
    const untouched = await ctx.prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(untouched?.tokenVersion, 0, '弱口令被拒后不得有任何写入');

    await svc.changePassword(user.id, plain, 'new-pass-2b');
    const after1 = await ctx.prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(after1?.tokenVersion, 1, '改密必须把 tokenVersion +1（旧 token 立即失效）');
    // 新口令可用、旧口令不可用
    assert.ok(await svc.validateUser(user.username, 'new-pass-2b'));
    await assert.rejects(
      () => svc.validateUser(user.username, plain),
      (e: any) => e instanceof UnauthorizedException,
      '改密后旧口令必须失效',
    );
    // 原密码错误 → 403（不是 401：已登录场景下这是权限问题，且要计入节流）
    await assert.rejects(
      () => svc.changePassword(user.id, 'not-the-old-1', 'third-pass-3c'),
      (e: any) => e instanceof ForbiddenException,
    );
  });

  it('⑤ 撞库节流：同用户名+IP 连错 5 次 → 429', async () => {
    const { username } = await makeUser('auth-throttle');
    const ip = '10.9.' + Math.floor(Math.random() * 250) + '.' + Math.floor(Math.random() * 250);

    let saw429 = false;
    for (let i = 0; i < 5; i++) {
      try {
        await svc.login(username, 'wrong-password-1', ip, 'int-test');
        assert.fail('错误口令不该登录成功');
      } catch (e: any) {
        if (e instanceof HttpException && e.getStatus() === 429) saw429 = true;
        else assert.ok(e instanceof UnauthorizedException, `第 ${i + 1} 次应为 401，实际 ${e?.status || e?.message}`);
      }
    }
    assert.ok(saw429, '窗口内第 5 次失败必须触发锁定（429）');

    // 锁定后即使密码正确也先被拦（连 bcrypt 都不做）
    await assert.rejects(
      () => svc.login(username, 'whatever-1', ip, 'int-test'),
      (e: any) => e instanceof HttpException && e.getStatus() === 429,
      '锁定期间必须直接 429，不能再校验口令',
    );
  });
});

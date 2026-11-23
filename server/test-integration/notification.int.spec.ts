// @domains: notification
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { bootIntApp, makeProject, uniq, type IntContext } from './helpers';
import { NotificationService } from '../src/modules/notification';

/**
 * 集成测试 · **站内通知的读写边界**（纯函数层只覆盖 where 构造，这里补真库读写）。
 *
 * ① `send` 必须给收件人：`userId = null` 的行永远查不到（孤儿通知），一律 **400**；
 * ② **只能读自己的**：A 的通知 B 去标记已读 → **404**（不暴露"存在但不属于你"）；
 * ③ `readAll` 只影响自己（别人的未读不能被顺手清掉）；
 * ④ 列表/未读数按用户过滤，`isRead` 兼容历史的 `'read'/'unread'` 取值。
 */
describe('集成 · 通知的读写边界', () => {
  let ctx: IntContext;
  let svc: NotificationService;

  before(async () => {
    ctx = await bootIntApp();
    svc = ctx.get<NotificationService>(NotificationService);
  });
  after(async () => {
    await ctx.app.close();
  });

  /** 造两个真实用户（Notification.userId 有外键到 User） */
  async function makeUser(tag: string) {
    return ctx.prisma.user.create({
      data: {
        username: uniq(`int-${tag}`).toLowerCase(),
        password: 'x',
        realName: `集成测试用户 ${tag}`,
      } as any,
    });
  }

  it('① send 必须指定收件人（否则是查不到的孤儿通知）', async () => {
    await assert.rejects(
      () => svc.send({ userId: null, title: '无收件人' }),
      (e: any) => e instanceof BadRequestException && /收件人/.test(e.message),
    );
  });

  it('② 只能标记自己的通知为已读（别人的 → 404）', async () => {
    const a = await makeUser('ntf-a');
    const b = await makeUser('ntf-b');
    const n: any = await svc.send({ userId: a.id, title: '给 A 的通知' });

    await assert.rejects(
      () => svc.read(n.id, { userId: b.id }),
      (e: any) => e instanceof NotFoundException,
      '跨用户标记已读必须 404，且不暴露记录存在性',
    );

    const read: any = await svc.read(n.id, { userId: a.id });
    assert.equal(read.isRead, true);
    assert.equal((await svc.unreadCount({ userId: a.id })).count, 0);
  });

  it('③ readAll 只清自己的未读', async () => {
    const a = await makeUser('ntf-c');
    const b = await makeUser('ntf-d');
    await svc.send({ userId: a.id, title: 'A-1' });
    await svc.send({ userId: a.id, title: 'A-2' });
    await svc.send({ userId: b.id, title: 'B-1' });

    await svc.readAll({ userId: a.id });

    assert.equal((await svc.unreadCount({ userId: a.id })).count, 0, 'A 的未读应清零');
    assert.equal((await svc.unreadCount({ userId: b.id })).count, 1, 'B 的未读不能被动到');
  });

  it('④ 列表按用户过滤，isRead 兼容 read/unread 历史取值', async () => {
    const a = await makeUser('ntf-e');
    const b = await makeUser('ntf-f');
    const project = await makeProject(ctx.prisma, 'NTF');
    await svc.send({ userId: a.id, title: 'A 未读', projectId: project.id });
    const readOne: any = await svc.send({ userId: a.id, title: 'A 已读', projectId: project.id });
    await svc.read(readOne.id, { userId: a.id });
    await svc.send({ userId: b.id, title: 'B 的' });

    const all: any = await svc.findAll({ page: 1, pageSize: 50 }, { userId: a.id });
    assert.equal(all.total, 2, '只应看到自己的 2 条');
    assert.ok(all.list.every((r: any) => r.userId === a.id));

    // 历史前端传 'read' / 'unread'（不是 true/false）
    const onlyRead: any = await svc.findAll({ page: 1, pageSize: 50, isRead: 'read' }, { userId: a.id });
    assert.equal(onlyRead.total, 1);
    assert.equal(onlyRead.list[0].title, 'A 已读');

    const onlyUnread: any = await svc.findAll({ page: 1, pageSize: 50, isRead: 'unread' }, { userId: a.id });
    assert.equal(onlyUnread.total, 1);
    assert.equal(onlyUnread.list[0].title, 'A 未读');
  });
});

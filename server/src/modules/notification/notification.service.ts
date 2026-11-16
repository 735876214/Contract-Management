import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult } from '../../common/utils/helpers';

@Injectable()
export class NotificationService {
  constructor(private prisma: PrismaClient) {}

  async findAll(query: any = {}, user: any) {
    const { skip, take } = paginate(query);
    const where: any = { userId: user.userId };
    if (query.isRead !== undefined && query.isRead !== '') {
      // 兼容历史前端传的 'read'/'unread'：否则任何取值都落到 false，「已读」筛选恒返回未读
      const raw = String(query.isRead);
      where.isRead = raw === 'true' || raw === '1' || raw === 'read';
    }
    if (query.projectId) where.projectId = query.projectId;
    const [list, total] = await Promise.all([
      this.prisma.notification.findMany({ where, skip, take, orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }] }),
      this.prisma.notification.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async unreadCount(user: any) {
    const count = await this.prisma.notification.count({ where: { userId: user.userId, isRead: false } });
    return { count };
  }

  /** 只能标记**自己的**通知已读（防跨用户抑制他人提醒） */
  async read(id: string, user: any) {
    const row = await this.prisma.notification.findFirst({ where: { id, userId: user.userId } });
    if (!row) throw new NotFoundException('通知不存在');
    return this.prisma.notification.update({ where: { id }, data: { isRead: true } });
  }

  async readAll(user: any) {
    await this.prisma.notification.updateMany({ where: { userId: user.userId, isRead: false }, data: { isRead: true } });
    return true;
  }

  /**
   * 通知发送：站内信（邮件/短信/企微/钉钉接口预留）。
   *
   * `userId` 现在必须给（第 13/14 轮审计）：`findAll` / `unreadCount` / `readAll`
   * 全部按 `userId = 当前用户` 过滤，落一条 `userId = null` 的行等于**永远查不到的孤儿**，
   * 而且不留任何痕迹。调用方真没有收件人时，宁可报错让它显式处理（打日志/换收件人），
   * 也不要静默丢弃。
   */
  async send(data: { userId?: string | null; title: string; content?: string; type?: string; projectId?: string; bizType?: string; bizId?: string }) {
    if (!data?.userId) throw new BadRequestException('通知必须指定收件人（userId）');
    return this.prisma.notification.create({ data: data as any });
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult } from '../../common/utils/helpers';

@Injectable()
export class NotificationService {
  constructor(private prisma: PrismaClient) {}

  async findAll(query: any = {}, user: any) {
    const { skip, take } = paginate(query);
    const where: any = { userId: user.userId };
    if (query.isRead !== undefined && query.isRead !== '') where.isRead = query.isRead === 'true' || query.isRead === true;
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

  async read(id: string) {
    return this.prisma.notification.update({ where: { id }, data: { isRead: true } });
  }

  async readAll(user: any) {
    await this.prisma.notification.updateMany({ where: { userId: user.userId, isRead: false }, data: { isRead: true } });
    return true;
  }

  /** 通知发送：站内信（邮件/短信/企微/钉钉接口预留） */
  async send(data: { userId?: string; title: string; content?: string; type?: string; projectId?: string; bizType?: string; bizId?: string }) {
    return this.prisma.notification.create({ data: data as any });
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class LogService {
  constructor(private prisma: PrismaClient) {}

  async operation(data: {
    userId?: string;
    username?: string;
    module?: string;
    action?: string;
    method?: string;
    url?: string;
    params?: any;
    ip?: string;
  }) {
    try {
      await this.prisma.operationLog.create({
        data: {
          userId: data.userId,
          username: data.username,
          module: data.module,
          action: data.action,
          method: data.method,
          url: data.url?.slice(0, 500),
          params: data.params ? JSON.stringify(data.params).slice(0, 4000) : null,
          ip: data.ip,
        },
      });
    } catch {
      // 日志失败不阻断业务
    }
  }

  async login(data: { userId?: string; username?: string; ip?: string; userAgent?: string; result?: string }) {
    try {
      await this.prisma.loginLog.create({ data: data as any });
    } catch {
      /* ignore */
    }
  }
}

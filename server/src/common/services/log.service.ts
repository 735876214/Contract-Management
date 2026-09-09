import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class LogService {
  constructor(private prisma: PrismaClient) {}

  /** 记录一条操作日志（需求 2.6：操作人、时间、IP、模块、动作、前后数据、结果、耗时） */
  async operation(data: {
    userId?: string;
    username?: string;
    module?: string;
    action?: string;
    method?: string;
    url?: string;
    params?: any;
    ip?: string;
    beforeData?: string | null;
    afterData?: string | null;
    result?: string;
    message?: string;
    duration?: number;
    bizType?: string;
    bizId?: string;
    projectId?: string;
    importFile?: string;
    importRows?: number;
    successCount?: number;
    failCount?: number;
    errorFileUrl?: string;
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
          beforeData: data.beforeData ?? null,
          afterData: data.afterData ?? null,
          result: data.result ?? 'SUCCESS',
          message: data.message ?? null,
          duration: data.duration ?? null,
          bizType: data.bizType ?? null,
          bizId: data.bizId ?? null,
          projectId: data.projectId ?? null,
          importFile: data.importFile ?? null,
          importRows: data.importRows ?? null,
          successCount: data.successCount ?? null,
          failCount: data.failCount ?? null,
          errorFileUrl: data.errorFileUrl ?? null,
        } as any,
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

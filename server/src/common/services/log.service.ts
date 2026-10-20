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
      /**
       * 参数只在这里序列化一次（拦截器若已序列化再 stringify 会变双重转义串，
       * 前端 `tryPretty` 只解一层，展示成一坨 `\\"`）。
       * 超长时截断到 4000，并在切断处补省略号而不是硬切在转义序列中间。
       */
      const params =
        data.params == null
          ? null
          : (() => {
              const text = typeof data.params === 'string' ? data.params : JSON.stringify(data.params);
              return text.length > 4000 ? `${text.slice(0, 3960)}…(已截断)` : text;
            })();
      await this.prisma.operationLog.create({
        data: {
          userId: data.userId,
          username: data.username,
          module: data.module,
          action: data.action,
          method: data.method,
          url: data.url?.slice(0, 500),
          params,
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

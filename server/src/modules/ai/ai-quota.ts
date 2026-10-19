import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * AI 调用配额：**每用户滑动 1 小时窗口**，进程内计数。
 *
 * 单实例是部署的最终形态（见 rules），所以不需要 Redis；
 * 做成独立 provider 是因为「模板填报」和「文件登记」要共享同一份额度——
 * 两个功能各自计数会让上限形同虚设。
 */
@Injectable()
export class AiQuota {
  private readonly hits = new Map<string, number[]>();

  consume(userId: string, limit: number, windowMs = 3600_000): void {
    const now = Date.now();
    const windowStart = now - windowMs;
    const list = (this.hits.get(userId) ?? []).filter((t) => t > windowStart);
    if (limit > 0 && list.length >= limit) {
      this.hits.set(userId, list);
      throw new HttpException(`AI 调用过于频繁（每用户每小时 ${limit} 次），请稍后再试`, HttpStatus.TOO_MANY_REQUESTS);
    }
    list.push(now);
    this.hits.set(userId, list);
  }

  /** 仅供测试/诊断：当前窗口内已用次数 */
  used(userId: string, windowMs = 3600_000): number {
    const windowStart = Date.now() - windowMs;
    return (this.hits.get(userId) ?? []).filter((t) => t > windowStart).length;
  }
}

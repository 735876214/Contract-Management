import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * AI 调用配额：**每用户滑动 1 小时窗口**，进程内计数。
 *
 * 单实例是部署的最终形态（见 rules），所以不需要 Redis；
 * 做成独立 provider 是因为「模板填报」和「文件登记」要共享同一份额度——
 * 两个功能各自计数会让上限形同虚设。
 */
/** 触发全表清理的用户条目阈值：单实例常驻进程里，用户数增长不能让 Map 无限膨胀 */
const PRUNE_THRESHOLD = 200;

@Injectable()
export class AiQuota {
  private readonly hits = new Map<string, number[]>();

  /**
   * 清理**过期用户条目**（2026-10-22 第 22 轮审计）。
   *
   * 原来只在「同一个用户再次调用」时才过滤自己那一条：调用过 AI 却再不回来的用户
   * （离职、换人、试一次就走）条目永久留着，单实例长期运行下 Map 只增不减 —— 慢速内存泄漏。
   * 这里在条目数超过阈值时顺手扫一遍，把窗口内已无命中的用户整体删掉。
   * 阈值判断放在最前面，常态下是 O(1)，不会给每次调用加成本。
   */
  private prune(now: number, windowMs: number): void {
    if (this.hits.size <= PRUNE_THRESHOLD) return;
    const windowStart = now - windowMs;
    for (const [userId, list] of this.hits) {
      const alive = list.filter((t) => t > windowStart);
      if (alive.length) this.hits.set(userId, alive);
      else this.hits.delete(userId);
    }
  }

  consume(userId: string, limit: number, windowMs = 3600_000): void {
    const now = Date.now();
    const windowStart = now - windowMs;
    this.prune(now, windowMs);
    const list = (this.hits.get(userId) ?? []).filter((t) => t > windowStart);
    if (limit > 0 && list.length >= limit) {
      this.hits.set(userId, list);
      throw new HttpException(`AI 调用过于频繁（每用户每小时 ${limit} 次），请稍后再试`, HttpStatus.TOO_MANY_REQUESTS);
    }
    list.push(now);
    this.hits.set(userId, list);
  }

  /**
   * 退还一次计数（调用失败时用，2026-10-20 审计 P2）。
   *
   * 原来「调用前扣、失败也计」，上游一挂（超时/5xx/空正文）用户连点几下就把
   * 每小时 60 次烧光并被锁一小时，而他自己一次结果都没拿到。
   * 现在三个 LLM 入口都在 catch 里退还 —— 失败不占额度，成功才消耗。
   */
  refund(userId: string, windowMs = 3600_000): void {
    const windowStart = Date.now() - windowMs;
    const list = (this.hits.get(userId) ?? []).filter((t) => t > windowStart);
    list.pop();
    this.hits.set(userId, list);
  }

  /** 仅供测试/诊断：当前窗口内已用次数 */
  used(userId: string, windowMs = 3600_000): number {
    const windowStart = Date.now() - windowMs;
    return (this.hits.get(userId) ?? []).filter((t) => t > windowStart).length;
  }

  /** 仅供测试/诊断：当前占用的用户条目数（超过阈值后由 prune 回收） */
  userCount(): number {
    return this.hits.size;
  }
}

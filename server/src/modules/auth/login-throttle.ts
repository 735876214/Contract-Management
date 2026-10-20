import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * 登录 / 改密失败的节流（进程内滑动窗口）。
 *
 * 为什么要有它（2026-10-20 第 2 轮审计）：`auth.controller` 的 login 完全没有次数限制，
 * 只有「失败也写登录日志」——日志能事后取证，却拦不住当下每秒几十次的撞库。
 * admin/admin123 这种默认口令在未改密的部署里，几小时就能被跑穿。
 *
 * 口径：
 * - 键 = `用户名|IP`（改密用 `pwd:<userId>`）：同一个账号从不同 IP 试、或同一 IP 试不同账号，
 *   都不会互相顶掉；共用出口 IP 的办公室用户也不会因为别人输错而全体被锁。
 * - 窗口内失败 `maxFailures` 次后**拒绝再试**（而不是继续校验），到期自动放开。
 * - 成功一次即清零（正常用户输错一两次不会留下痕迹）。
 * - 进程内实现：与本项目「单实例部署」的既有口径一致（同 `AiQuota`）；多副本会各记各的，
 *   不会更宽松，只是各自窗口独立。
 */
@Injectable()
export class LoginThrottle {
  /** key → 失败时间戳（升序） */
  private readonly hits = new Map<string, number[]>();

  /**
   * 参数不放进构造器：本项目单测用 `node --experimental-strip-types`（strip-only 模式），
   * 不支持 TS「构造函数参数属性」语法，写成 `private readonly maxFailures = 5` 会直接加载失败。
   */
  private readonly maxFailures = 5;
  private readonly windowMs = 15 * 60_000;

  /** 规范化键：用户名去空格转小写（否则 `Admin`/`admin ` 各占一个窗口），IP 去空格 */
  keyOf(username: unknown, ip: unknown): string {
    return `${String(username ?? '').trim().toLowerCase()}|${String(ip ?? '').trim() || 'unknown'}`;
  }

  /** 还要等多久（ms）；0 = 现在可以试 */
  retryAfterMs(key: string, now: number = Date.now()): number {
    const list = this.prune(key, now);
    if (list.length < this.maxFailures) return 0;
    return Math.max(1000, this.windowMs - (now - list[0]));
  }

  /** 记一次失败；返回「这次是不是刚好被锁上」 */
  fail(key: string, now: number = Date.now()): boolean {
    const list = this.prune(key, now);
    list.push(now);
    // 只留窗口内、且最多 maxFailures 条：Map 不会因为长时间运行无限长
    this.hits.set(key, list.slice(-this.maxFailures));
    if (this.hits.size > 5000) this.sweep(now);
    return list.length >= this.maxFailures;
  }

  /** 成功一次即清零（同一账号换了 IP 也清，因为他确实知道密码） */
  reset(key: string): void {
    this.hits.delete(key);
  }

  /** 当前在窗口内的键数量（运维/测试观察用） */
  size(): number {
    return this.hits.size;
  }

  /** 到点就抛 429，文案带上还要等多久（用户才知道不是密码错了） */
  assertNotThrottled(key: string, now: number = Date.now()): void {
    const wait = this.retryAfterMs(key, now);
    if (!wait) return;
    const mins = Math.max(1, Math.ceil(wait / 60_000));
    throw new HttpException(
      `登录失败次数过多，请 ${mins} 分钟后再试（15 分钟内连续输错 5 次会临时锁定）`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private prune(key: string, now: number): number[] {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (!list.length) this.hits.delete(key);
    return list;
  }

  /** 兜底清扫：长期运行下把整张表过一遍，避免只剩过期条目的键一直占内存 */
  private sweep(now: number): void {
    for (const key of [...this.hits.keys()]) this.prune(key, now);
  }
}

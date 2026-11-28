import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis';

/**
 * 登录 / 改密失败的节流。
 *
 * 由来（2026-10-20 第 2 轮审计）：`auth.controller` 的 login 原本完全没有次数限制，
 * 只有「失败也写登录日志」——日志能事后取证，却拦不住当下每秒几十次的撞库。
 * admin/admin123 这种默认口令在未改密的部署里，几小时就能被跑穿。
 *
 * 口径（语义沿用改造前，逐条有用例锁）：
 * - 键 = `用户名|IP`（改密用 `pwd:<userId>`）：同一账号换 IP 试、或同一 IP 试不同账号都不互相顶掉；
 *   共用出口 IP 的办公室同事不会因为别人输错而全体被锁。
 * - 窗口内失败 `maxFailures` 次后**拒绝再试**（不是继续校验密码），到期自动放开。
 * - 成功一次即清零（正常用户输错一两次不留痕迹）。
 *
 * 2026-11-24 改造：状态从进程内 `Map` 挪到 `RedisService`（未配 `REDIS_URL` 时仍是进程内）。
 * 为什么值得动：节流是本项目**唯一**直接挡撞库的闸门，进程内实现下多副本各记各的，
 * 等于把「15 分钟 5 次」放大成「15 分钟 5 次 × 副本数」。
 * 存法用列表存**失败时间戳**（不是计数器）：窗口要能自然滑动，计数器还得额外存首击时间，
 * 而列表天然是「窗口内最近 N 次」。
 */
@Injectable()
export class LoginThrottle {
  /**
   * 参数不放进构造器参数属性：本项目 `.mts` 单测用 Node **strip-only** 类型擦除加载，
   * 不支持「构造函数参数属性」语法，写成参数属性会直接加载失败。
   */
  private readonly maxFailures = 5;
  private readonly windowMs = 15 * 60_000;
  /** 列表 TTL 比窗口长 1 分钟：窗口内的记录必须活着，超窗记录交给 TTL 自动清 */
  private readonly listTtlMs = 16 * 60_000;

  constructor(private readonly redis: RedisService) {}

  /** 规范化键：用户名去空格转小写（否则 `Admin`/`admin ` 各占一个窗口），IP 去空格 */
  keyOf(username: unknown, ip: unknown): string {
    return `${String(username ?? '').trim().toLowerCase()}|${String(ip ?? '').trim() || 'unknown'}`;
  }

  private static key(key: string): string {
    return 'login-throttle:' + key;
  }

  /** 窗口内的失败时间戳（升序） */
  private async hits(key: string, now: number): Promise<number[]> {
    const raw = await this.redis.listRange(LoginThrottle.key(key));
    return raw
      .map((v) => Number(v))
      .filter((t) => Number.isFinite(t) && now - t < this.windowMs);
  }

  /** 还要等多久（ms）；0 = 现在可以试 */
  async retryAfterMs(key: string, now: number = Date.now()): Promise<number> {
    const list = await this.hits(key, now);
    if (list.length < this.maxFailures) return 0;
    return Math.max(1000, this.windowMs - (now - list[0]));
  }

  /** 记一次失败；返回「这次是不是刚好被锁上」 */
  async fail(key: string, now: number = Date.now()): Promise<boolean> {
    const list = await this.hits(key, now);
    list.push(now);
    // 只留窗口内最近 maxFailures 条：列表不会因为长期运行无限长
    const kept = list.slice(-this.maxFailures);
    const store = LoginThrottle.key(key);
    // 先清后写：窗口滑动后旧记录必须整体替换（列表是「最近 N 次」，不是只追加的流水）
    await this.redis.del(store);
    for (const t of kept) await this.redis.rpush(store, String(t), this.listTtlMs);
    return kept.length >= this.maxFailures;
  }

  /** 成功一次即清零（同一账号换了 IP 也清，因为他确实知道密码） */
  async reset(key: string): Promise<void> {
    await this.redis.del(LoginThrottle.key(key));
  }

  /** 到点就抛 429，文案带上还要等多久（用户才知道不是密码错了） */
  async assertNotThrottled(key: string, now: number = Date.now()): Promise<void> {
    const wait = await this.retryAfterMs(key, now);
    if (!wait) return;
    const mins = Math.max(1, Math.ceil(wait / 60_000));
    throw new HttpException(
      `登录失败次数过多，请 ${mins} 分钟后再试（15 分钟内连续输错 5 次会临时锁定）`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

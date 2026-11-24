import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * 可选的 Redis 接入层：**没有 `REDIS_URL` 时自动退化到进程内实现**。
 *
 * 为什么现在引（2026-11-24）：
 * - 此前所有「短期状态」都在进程内（登录节流 `LoginThrottle`、AI 配额 `AiQuota`、流式缓冲），
 *   口径是「单实例部署」——多副本会各记各的，撞库防护削 5 倍。
 * - AI 问数的「断线续传」要求任意实例都能读到同一个 run 的事件流，进程内 Map 做不到。
 * - 借 ApeAdmin 的取舍（`backend/src/core/`）：Redis **不是硬依赖**，缺失自动降级进程内，
 *   NAS 单容器部署可以完全不装；装了才拿到跨实例语义。
 *
 * 降级语义（写死在这里，避免调用方各自猜测）：
 * - 未配置 `REDIS_URL` → `kind === 'memory'`，行为等同改造前（各实例各记各的）。
 * - 配了但连不上 / 运行中报错 → 记警告并**永久降级 memory**，直到进程重启。
 *   不做「每次调用重试」：故障时每次都要等连接超时，会把登录这种高频路径拖死。
 */
export type RedisBackendKind = 'redis' | 'memory';

interface MemoryEntry {
  value?: string;
  list?: string[];
  /** 0 = 不主动过期 */
  expireAt: number;
}

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis | null = null;
  private backendKind: RedisBackendKind = 'memory';
  private prefix = 'cms:';
  private lastError: string | null = null;
  /** memory 后端的存储：键含前缀，与 Redis 侧命名一致，降级/恢复时不会出现两套键名 */
  private readonly mem = new Map<string, MemoryEntry>();

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  /** 当前真正在用的后端（健康检查/日志观察用） */
  get kind(): RedisBackendKind {
    return this.backendKind;
  }

  /** 最近一次连接/命令错误（没出错为 null） */
  get lastFailure(): string | null {
    return this.lastError;
  }

  /** 是否显式配置了 REDIS_URL（区分「没配」和「配了但挂了」） */
  get configured(): boolean {
    return Boolean((process.env.REDIS_URL ?? '').trim());
  }

  private async connect(): Promise<void> {
    this.prefix = (process.env.REDIS_KEY_PREFIX ?? 'cms:').trim();
    const url = (process.env.REDIS_URL ?? '').trim();
    if (!url) {
      this.logger.log('[redis] 未配置 REDIS_URL → 进程内后端（单实例口径）');
      return;
    }
    let client: Redis | null = null;
    try {
      client = new Redis(url, {
        lazyConnect: true,
        connectTimeout: 3000,
        maxRetriesPerRequest: 2,
        // 断线时立刻失败而不是排队等：排队会让登录请求挂在半空，比快速降级更糟
        enableOfflineQueue: false,
      });
      // ⚠️ error 监听必须挂：ioredis 的 'error' 事件没人接会直接打崩进程
      client.on('error', (e: Error) => this.degrade(e, '连接异常'));
      await client.connect();
      await client.ping();
      this.client = client;
      this.backendKind = 'redis';
      this.lastError = null;
      this.logger.log('[redis] 已连接 ' + this.redact(url));
    } catch (e) {
      this.degrade(e, '连接失败');
      try {
        client?.disconnect();
      } catch {
        // 连接都没建立，disconnect 失败无需处理
      }
    }
  }

  /** 降级到 memory（幂等；只在第一次打日志，避免刷屏） */
  private degrade(e: unknown, what: string): void {
    const msg = e instanceof Error ? e.message : String(e ?? 'unknown');
    if (this.backendKind === 'memory' && this.lastError === msg) return;
    this.lastError = msg;
    this.backendKind = 'memory';
    const dead = this.client;
    this.client = null;
    // 必须 disconnect：ioredis 掉线后会挂着重连定时器，不主动断开会拖住进程退出
    // （冒烟验证时真的遇到过：停掉 Redis 后进程 90 秒不退出）
    try {
      dead?.disconnect();
    } catch {
      // 已经断了，忽略
    }
    this.logger.warn('[redis] ' + what + ' → 降级进程内后端：' + msg);
  }

  /** 日志里打印连接串时抹掉口令 */
  private redact(url: string): string {
    return url.replace(/(\/\/[^:]+:)[^@]+@/, '$1***@');
  }

  private key(key: string): string {
    return this.prefix + key;
  }

  private memEntry(key: string, now: number): MemoryEntry | null {
    const hit = this.mem.get(key);
    if (!hit) return null;
    if (hit.expireAt && hit.expireAt <= now) {
      this.mem.delete(key);
      return null;
    }
    return hit;
  }

  /** 统一兜底：Redis 命令抛错就地降级到 memory，调用方拿不到异常（可用性优先） */
  private async run<T>(redisOp: (client: Redis) => Promise<T>, memoryOp: () => T): Promise<T> {
    const client = this.client;
    if (this.backendKind !== 'redis' || !client) return memoryOp();
    try {
      return await redisOp(client);
    } catch (e) {
      this.degrade(e, '命令失败');
      return memoryOp();
    }
  }

  async ping(): Promise<boolean> {
    const client = this.client;
    if (this.backendKind !== 'redis' || !client) return false;
    try {
      return (await client.ping()) === 'PONG';
    } catch (e) {
      this.degrade(e, 'ping 失败');
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    const k = this.key(key);
    return this.run(
      (c) => c.get(k),
      () => this.memEntry(k, Date.now())?.value ?? null,
    );
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    const k = this.key(key);
    await this.run(
      async (c) => {
        if (ttlMs && ttlMs > 0) await c.set(k, value, 'PX', ttlMs);
        else await c.set(k, value);
      },
      () => {
        this.mem.set(k, { value, expireAt: ttlMs && ttlMs > 0 ? Date.now() + ttlMs : 0 });
      },
    );
  }

  async del(key: string): Promise<void> {
    const k = this.key(key);
    await this.run(
      async (c) => {
        await c.del(k);
      },
      () => {
        this.mem.delete(k);
      },
    );
  }

  /** 自增（登录节流/AI 配额这类计数用）；ttlMs 只在键刚创建时设一次 */
  async incr(key: string, ttlMs?: number): Promise<number> {
    const k = this.key(key);
    return this.run(
      async (c) => {
        const next = await c.incr(k);
        if (next === 1 && ttlMs && ttlMs > 0) await c.pexpire(k, ttlMs);
        return next;
      },
      () => {
        const now = Date.now();
        const hit = this.memEntry(k, now);
        const next = Number(hit?.value ?? '0') + 1;
        const expireAt = hit?.expireAt || (ttlMs && ttlMs > 0 ? now + ttlMs : 0);
        this.mem.set(k, { value: String(next), expireAt });
        return next;
      },
    );
  }

  async expire(key: string, ttlMs: number): Promise<void> {
    const k = this.key(key);
    await this.run(
      async (c) => {
        await c.pexpire(k, ttlMs);
      },
      () => {
        const hit = this.memEntry(k, Date.now());
        if (hit) hit.expireAt = Date.now() + ttlMs;
      },
    );
  }

  /** 追加到列表尾部（AI run 的事件流：序号即列表下标） */
  async rpush(key: string, value: string, ttlMs?: number): Promise<void> {
    const k = this.key(key);
    await this.run(
      async (c) => {
        await c.rpush(k, value);
        if (ttlMs && ttlMs > 0) await c.pexpire(k, ttlMs);
      },
      () => {
        const now = Date.now();
        const hit = this.memEntry(k, now);
        const list = hit?.list ?? [];
        list.push(value);
        this.mem.set(k, { list, expireAt: ttlMs && ttlMs > 0 ? now + ttlMs : (hit?.expireAt ?? 0) });
      },
    );
  }

  /** 只保留 [start, stop] 区间（负数从尾部算，语义同 Redis LTRIM） */
  async trimList(key: string, start: number, stop: number): Promise<void> {
    const k = this.key(key);
    await this.run(
      async (c) => {
        await c.ltrim(k, start, stop);
      },
      () => {
        const hit = this.memEntry(k, Date.now());
        if (!hit?.list) return;
        const len = hit.list.length;
        const from = start < 0 ? Math.max(0, len + start) : start;
        const to = stop < 0 ? len + stop : stop;
        hit.list = hit.list.slice(from, to + 1);
      },
    );
  }

  async listRange(key: string, start = 0, stop = -1): Promise<string[]> {
    const k = this.key(key);
    return this.run(
      (c) => c.lrange(k, start, stop),
      () => {
        const list = this.memEntry(k, Date.now())?.list ?? [];
        const len = list.length;
        const from = start < 0 ? Math.max(0, len + start) : start;
        const to = stop < 0 ? len + stop : stop;
        return list.slice(from, to + 1);
      },
    );
  }

  async listLength(key: string): Promise<number> {
    const k = this.key(key);
    return this.run(
      (c) => c.llen(k),
      () => this.memEntry(k, Date.now())?.list?.length ?? 0,
    );
  }

  /** 测试/运维观察：memory 后端里现存的键数（redis 后端返回 -1，键数不可知） */
  memorySize(): number {
    if (this.backendKind === 'redis') return -1;
    const now = Date.now();
    let n = 0;
    for (const k of [...this.mem.keys()]) if (this.memEntry(k, now)) n += 1;
    return n;
  }
}

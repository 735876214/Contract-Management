import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** 系统参数默认值 + 内存缓存 */
@Injectable()
export class SysParamService {
  private readonly logger = new Logger(SysParamService.name);
  private cache: Record<string, string> = {};
  private loaded = false;
  /** 上次加载失败时间：DB 抖动时避免每个 get() 都去打一次库 */
  private lastFailAt = 0;
  /** 加载失败后的重试间隔 */
  private static readonly RETRY_MS = 5000;

  constructor(private prisma: PrismaClient) {}

  private async load() {
    if (this.loaded) return;
    if (this.lastFailAt && Date.now() - this.lastFailAt < SysParamService.RETRY_MS) return;
    try {
      const list = await this.prisma.sysParam.findMany();
      this.cache = list.reduce((acc: any, p: any) => ({ ...acc, [p.key]: p.value ?? '' }), {});
      this.loaded = true;
      this.lastFailAt = 0;
    } catch (e: any) {
      // ⚠️ 不能把 loaded 置 true：否则一次启动抖动会让整个进程生命周期都用默认值
      // （供应商共享范围、超付策略、台账列配置等口径全部静默回落），只能靠人工点「刷新缓存」恢复。
      this.lastFailAt = Date.now();
      this.logger.error(
        `系统参数加载失败，本次回落默认值，${SysParamService.RETRY_MS / 1000}s 后重试：${e?.message || e}`,
        e?.stack,
      );
    }
  }

  async refresh() {
    this.loaded = false;
    // 手动刷新不受失败退避限制（运维点「刷新缓存」就是要立刻生效）
    this.lastFailAt = 0;
    await this.load();
  }

  async get(key: string, def = ''): Promise<string> {
    await this.load();
    return this.cache[key] ?? def;
  }

  async set(key: string, value: string, remark?: string) {
    await this.prisma.sysParam.upsert({
      where: { key },
      update: { value },
      create: { key, value, remark },
    });
    this.cache[key] = value;
  }

  async getAll() {
    await this.load();
    return this.cache;
  }
}

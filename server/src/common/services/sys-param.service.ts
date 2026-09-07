import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** 系统参数默认值 + 内存缓存 */
@Injectable()
export class SysParamService {
  private readonly logger = new Logger(SysParamService.name);
  private cache: Record<string, string> = {};
  private loaded = false;

  constructor(private prisma: PrismaClient) {}

  private async load() {
    if (this.loaded) return;
    try {
      const list = await this.prisma.sysParam.findMany();
      this.cache = list.reduce((acc: any, p: any) => ({ ...acc, [p.key]: p.value ?? '' }), {});
      this.loaded = true;
    } catch (e) {
      this.logger.warn('系统参数加载失败，使用默认值');
      this.loaded = true;
    }
  }

  async refresh() {
    this.loaded = false;
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

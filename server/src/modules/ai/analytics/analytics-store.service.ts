import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { JwtUser } from '../../../common/decorators/user.decorator';

export interface CreateAnalyticsReportInput {
  projectId: string;
  createdBy?: string | null;
  createdByName?: string | null;
  title: string;
  rawText?: string | null;
  intentJson?: unknown;
  scopeJson?: unknown;
  datasetKeys?: string[];
  factsJson?: unknown;
  warningsJson?: unknown;
  unknownNumbersJson?: unknown;
  discardedNumbersJson?: unknown;
  scopeMode?: string | null;
  projectCount?: number;
  periodFrom?: Date | null;
  periodTo?: Date | null;
  periodLabel?: string | null;
  compareMode?: string | null;
  narrative?: boolean;
  source?: string | null;
  markdown?: string | null;
  hasReport?: boolean;
  workbookKey?: string | null;
  workbookName?: string | null;
  workbookSize?: number | null;
  hasWorkbook?: boolean;
}

export interface ListAnalyticsReportsQuery {
  page?: string | number;
  pageSize?: string | number;
  keyword?: string;
  /** `report` | `workbook`（按 hasReport / hasWorkbook 过滤） */
  has?: string;
  /** 可选筛选项；**不传 = 本人全部**（跨项目生成的「全部项目」报告切项目后仍可见） */
  projectId?: string;
  from?: string;
  to?: string;
  all?: string | number;
}

const pageInt = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
};

/**
 * AI 经营数据助手 · 记录存取（Phase 2）。
 *
 * 访问控制（业务 2026-11-12 确认）：
 * - 历史按**创建人**可见，跨项目可见；`projectId` 只作元数据与文件目录，不参与默认过滤；
 * - 超管可 `all=1` 看全部；非创建人一律 **404**（不泄露存在性）；
 * - 记录是快照：重新生成 = 新增一条。
 */
@Injectable()
export class AnalyticsStore {
  constructor(private prisma: PrismaClient) {}

  async create(input: CreateAnalyticsReportInput) {
    return this.prisma.aiAnalyticsReport.create({
      data: {
        projectId: input.projectId,
        createdBy: input.createdBy ?? null,
        createdByName: input.createdByName ?? null,
        title: input.title,
        rawText: input.rawText ?? null,
        intentJson: (input.intentJson ?? undefined) as any,
        scopeJson: (input.scopeJson ?? undefined) as any,
        datasetKeys: input.datasetKeys ?? [],
        factsJson: (input.factsJson ?? undefined) as any,
        warningsJson: (input.warningsJson ?? undefined) as any,
        unknownNumbersJson: (input.unknownNumbersJson ?? undefined) as any,
        discardedNumbersJson: (input.discardedNumbersJson ?? undefined) as any,
        scopeMode: input.scopeMode ?? null,
        projectCount: input.projectCount ?? 0,
        periodFrom: input.periodFrom ?? null,
        periodTo: input.periodTo ?? null,
        periodLabel: input.periodLabel ?? null,
        compareMode: input.compareMode ?? null,
        narrative: input.narrative ?? false,
        source: input.source ?? 'template',
        markdown: input.markdown ?? null,
        hasReport: input.hasReport ?? false,
        workbookKey: input.workbookKey ?? null,
        workbookName: input.workbookName ?? null,
        workbookSize: input.workbookSize ?? null,
        hasWorkbook: input.hasWorkbook ?? false,
      },
    });
  }

  async list(user: JwtUser, query: ListAnalyticsReportsQuery) {
    const page = pageInt(query?.page, 1, 1, 100000);
    const pageSize = pageInt(query?.pageSize, 20, 1, 100);
    const where: any = {};
    const seeAll = !!user?.isSuperAdmin && ['1', 'true', 'yes'].includes(String(query?.all ?? '').toLowerCase());
    if (!seeAll) {
      if (!user?.userId) throw new NotFoundException('记录不存在');
      where.createdBy = user.userId;
    }
    if (query?.projectId) where.projectId = String(query.projectId);
    const has = String(query?.has ?? '').toLowerCase();
    if (has === 'report') where.hasReport = true;
    if (has === 'workbook') where.hasWorkbook = true;
    if (query?.keyword) where.title = { contains: String(query.keyword), mode: 'insensitive' };
    if (query?.from || query?.to) {
      where.createdAt = {};
      if (query.from) where.createdAt.gte = new Date(`${query.from}T00:00:00`);
      if (query.to) where.createdAt.lte = new Date(`${query.to}T23:59:59.999`);
    }

    const [total, list] = await Promise.all([
      this.prisma.aiAnalyticsReport.count({ where }),
      this.prisma.aiAnalyticsReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          title: true,
          projectId: true,
          createdBy: true,
          createdByName: true,
          scopeMode: true,
          projectCount: true,
          periodLabel: true,
          compareMode: true,
          datasetKeys: true,
          hasReport: true,
          hasWorkbook: true,
          narrative: true,
          source: true,
          createdAt: true,
        },
      }),
    ]);
    return { list, total, page, pageSize };
  }

  /** 把工作簿挂到已有记录（报告记录「同时生成表格」的场景） */
  async attachWorkbook(id: string, user: JwtUser, file: { key: string; name: string; size: number }) {
    const row = await this.detail(id, user);
    return this.prisma.aiAnalyticsReport.update({
      where: { id: row.id },
      data: {
        workbookKey: file.key,
        workbookName: file.name,
        workbookSize: file.size,
        hasWorkbook: true,
      },
    });
  }

  /**
   * 详情（本人或超管）；非创建人 404，不泄露存在性。
   * `allowedDatasetKeys`（可选）：调用方传入当前用户仍可读的数据集集合；
   * 历史里任一数据集已被收回权限 → 同样按 404 处理（计划 §2.5：权限被收回后历史也看不到）。
   */
  async detail(id: string, user: JwtUser, allowedDatasetKeys?: ReadonlySet<string>) {
    const row = await this.prisma.aiAnalyticsReport.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('记录不存在');
    if (!user?.isSuperAdmin && row.createdBy !== user?.userId) throw new NotFoundException('记录不存在');
    if (allowedDatasetKeys && Array.isArray(row.datasetKeys)) {
      const revoked = row.datasetKeys.filter((k) => !allowedDatasetKeys.has(k));
      if (revoked.length) throw new NotFoundException('记录不存在');
    }
    return row;
  }

  /** 删除记录（只删 DB 行；文件留给 `storage-audit.mjs` 人工审计） */
  async remove(id: string, user: JwtUser) {
    const row = await this.detail(id, user);
    await this.prisma.aiAnalyticsReport.delete({ where: { id: row.id } });
    return { id: row.id, deleted: true };
  }
}

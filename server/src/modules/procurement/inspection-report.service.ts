import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult } from '../../common/utils/helpers';

/**
 * 考察报告（批次二 · 任务 3.7）：独立模块
 *
 * - 不挂在采购任务阶段链上，按项目维度管理（一次考察一份报告）
 * - 状态仅「编辑中 → 已完成」（发布后回填 publishedAt；发布后仍可重新编辑）
 * - 考察单位名称即供应商名称（导出 Word 命名：{项目简称}-{供应商名称}-考察报告.docx）
 * - 考察照片 photos：JSON 数组 [{ fileName, url, size }]，由 /api/files/upload 上传
 */
@Injectable()
export class InspectionReportService {
  constructor(private prisma: PrismaClient) {}

  /** 序列化：photos 反序列化为数组，状态由 publishedAt 推导 */
  private serialize(r: any) {
    let photos: { fileName: string; url: string; size?: number }[] = [];
    if (r.photos) {
      try {
        const parsed = JSON.parse(r.photos);
        if (Array.isArray(parsed)) photos = parsed;
      } catch {
        photos = [];
      }
    }
    const published = !!r.publishedAt;
    return {
      ...r,
      photos,
      published,
      status: published ? 'COMPLETED' : 'EDITING',
      statusLabel: published ? '已完成' : '编辑中',
    };
  }

  /** 校验并规整照片数组（最多 20 张，每项必须含 url） */
  private parsePhotos(input: unknown) {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new BadRequestException('考察照片格式不正确');
    const photos = input
      .filter((p) => p && typeof p === 'object' && typeof (p as any).url === 'string' && (p as any).url)
      .map((p: any) => ({
        fileName: String(p.fileName ?? ''),
        url: String(p.url),
        size: Number(p.size) || 0,
      }));
    if (photos.length > 20) throw new BadRequestException('考察照片最多上传 20 张');
    return photos;
  }

  private normalizeBody(body: any) {
    const data: any = {};
    if (body?.unitName !== undefined) {
      const unitName = String(body.unitName ?? '').trim();
      if (!unitName) throw new BadRequestException('考察单位名称不能为空');
      data.unitName = unitName;
    }
    if (body?.inspectionTime !== undefined) {
      data.inspectionTime = body.inspectionTime ? new Date(body.inspectionTime) : null;
    }
    if (body?.inspectionPlace !== undefined) data.inspectionPlace = body.inspectionPlace ?? null;
    if (body?.inspectors !== undefined) data.inspectors = body.inspectors ?? null;
    if (body?.content !== undefined) data.content = body.content ?? null;
    if (body?.conclusion !== undefined) data.conclusion = body.conclusion ?? null;
    if (body?.photos !== undefined) data.photos = JSON.stringify(this.parsePhotos(body.photos));
    return data;
  }

  /** 分页列表（按项目 + 可选关键字搜考察单位名称） */
  async findAll(query: any, projectId: string) {
    const where: any = { projectId };
    if (query?.keyword) {
      where.unitName = { contains: String(query.keyword) };
    }
    const { skip, take } = paginate(query);
    const [items, total] = await Promise.all([
      this.prisma.inspectionReport.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.inspectionReport.count({ where }),
    ]);
    return buildResult(
      items.map((r) => this.serialize(r)),
      total,
      query,
    );
  }

  /** 全量列表（不分页，供导出/下拉用） */
  async listAll(projectId: string) {
    const rows = await this.prisma.inspectionReport.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((r) => this.serialize(r));
  }

  async findOne(id: string) {
    const r = await this.prisma.inspectionReport.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('考察报告不存在');
    return this.serialize(r);
  }

  async create(projectId: string, body: any) {
    const data = this.normalizeBody(body);
    if (!data.unitName) throw new BadRequestException('考察单位名称不能为空');
    const r = await this.prisma.inspectionReport.create({
      data: { ...data, projectId },
    });
    return this.serialize(r);
  }

  /** 更新（发布后仍可重新编辑） */
  async update(id: string, body: any) {
    const existing = await this.prisma.inspectionReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('考察报告不存在');
    const data = this.normalizeBody(body);
    const r = await this.prisma.inspectionReport.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    });
    return this.serialize(r);
  }

  /** 发布：编辑中 → 已完成（回填 publishedAt；不改变任何采购任务状态） */
  async publish(id: string) {
    const existing = await this.prisma.inspectionReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('考察报告不存在');
    if (!String(existing.unitName ?? '').trim()) {
      throw new BadRequestException('请先填写「考察单位名称」再发布');
    }
    if (!existing.publishedAt) {
      await this.prisma.inspectionReport.update({
        where: { id },
        data: { publishedAt: new Date() },
      });
    }
    return this.findOne(id);
  }

  /** 撤回发布：已完成 → 编辑中（清空 publishedAt） */
  async unpublish(id: string) {
    const existing = await this.prisma.inspectionReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('考察报告不存在');
    await this.prisma.inspectionReport.update({
      where: { id },
      data: { publishedAt: null },
    });
    return this.findOne(id);
  }

  async remove(id: string) {
    const existing = await this.prisma.inspectionReport.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('考察报告不存在');
    await this.prisma.inspectionReport.delete({ where: { id } });
    return { success: true };
  }
}

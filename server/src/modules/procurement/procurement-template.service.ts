import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** 允许的采购模块类型（批次一 · 任务 1.2） */
const MODULE_TYPES = [
  'INITIATE', 'PRE_MEETING', 'NOTICE', 'DOCUMENT',
  'RESULT_REPORT', 'PRICE_COMPARE', 'FRAMEWORK',
] as const;

type ModuleType = (typeof MODULE_TYPES)[number];

const isModuleType = (v: unknown): v is ModuleType =>
  typeof v === 'string' && (MODULE_TYPES as readonly string[]).includes(v);

/**
 * 采购模板服务。
 * 业务 2026-10-17：采购模板**全项目通用**（projectId 列已弃用，恒 null），
 * 每个业务类型全局仅一个模板；**能力对齐合同模板**（版本历史/回滚/标签/状态）。
 */
@Injectable()
export class ProcurementTemplateService {
  constructor(private prisma: PrismaClient) {}

  /** 模板列表（全局，按模块类型排序） */
  async findAll() {
    const rows = await this.prisma.procurementTemplate.findMany({
      orderBy: [{ moduleType: 'asc' }, { updatedAt: 'desc' }],
    });
    return rows.map((r) => this.serialize(r));
  }

  async findOne(id: string) {
    const r = await this.prisma.procurementTemplate.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('采购模板不存在');
    return this.serialize(r);
  }

  /** 更新前的旧版本快照（对齐合同模板：每次更新入版本表，version 递增） */
  private async snapshotVersion(current: {
    id: string; templateName: string; content: string; variables: string | null; tags: string | null; version: number;
  }, operator?: string) {
    await this.prisma.procurementTemplateVersion.create({
      data: {
        templateId: current.id,
        templateName: current.templateName,
        content: current.content,
        variables: current.variables,
        tags: current.tags,
        version: current.version,
        operator: operator ?? null,
      },
    });
  }

  /**
   * 创建模板。全局同一业务类型仅保留一个模板：
   * 已存在同类型模板时执行覆盖（前端已做覆盖前确认）。
   */
  async create(
    data: { moduleType?: string; templateName?: string; content?: string; variables?: string[]; tags?: string; status?: number },
    operator?: string,
  ) {
    const moduleType = data?.moduleType;
    if (!isModuleType(moduleType)) throw new BadRequestException('无效的采购模块类型');
    const templateName = String(data?.templateName ?? '').trim();
    if (!templateName) throw new BadRequestException('请填写模板名称');
    const content = String(data?.content ?? '');
    if (!content.trim()) throw new BadRequestException('请填写模板内容');

    const vars = Array.isArray(data?.variables) ? data.variables.filter((v) => typeof v === 'string') : [];
    const existing = await this.prisma.procurementTemplate.findUnique({
      where: { moduleType },
    });
    if (existing) {
      // 覆盖前把旧版本快照入版本表（同"更新"语义）
      await this.snapshotVersion(existing, operator);
      const updated = await this.prisma.procurementTemplate.update({
        where: { id: existing.id },
        data: {
          templateName,
          content,
          variables: JSON.stringify(vars),
          tags: data?.tags ?? existing.tags,
          status: data?.status ?? existing.status,
          version: { increment: 1 },
        },
      });
      return { ...this.serialize(updated), overwritten: true };
    }
    const created = await this.prisma.procurementTemplate.create({
      data: {
        projectId: null,
        moduleType,
        templateName,
        content,
        variables: JSON.stringify(vars),
        tags: data?.tags ?? null,
        status: data?.status ?? 1,
      },
    });
    return this.serialize(created);
  }

  /** 更新模板（模块类型变更时同样执行同类型唯一性覆盖；旧版本入版本表） */
  async update(
    id: string,
    data: { moduleType?: string; templateName?: string; content?: string; variables?: string[]; tags?: string; status?: number },
    operator?: string,
  ) {
    const current = await this.prisma.procurementTemplate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购模板不存在');

    const patch: {
      moduleType?: string; templateName?: string; content?: string; variables?: string; tags?: string; status?: number;
    } = {};
    if (data?.moduleType != null) {
      if (!isModuleType(data.moduleType)) throw new BadRequestException('无效的采购模块类型');
      patch.moduleType = data.moduleType;
    }
    if (data?.templateName != null) {
      const name = String(data.templateName).trim();
      if (!name) throw new BadRequestException('模板名称不能为空');
      patch.templateName = name;
    }
    if (data?.content != null) patch.content = String(data.content);
    if (data?.tags !== undefined) patch.tags = data.tags;
    if (data?.status !== undefined) patch.status = Number(data.status) === 0 ? 0 : 1;
    if (Array.isArray(data?.variables)) {
      patch.variables = JSON.stringify(data.variables.filter((v) => typeof v === 'string'));
    }

    const nextModuleType = patch.moduleType ?? current.moduleType;
    if (nextModuleType !== current.moduleType) {
      const conflict = await this.prisma.procurementTemplate.findUnique({
        where: { moduleType: nextModuleType },
      });
      if (conflict && conflict.id !== id) {
        // 覆盖同类型旧模板：旧版本入版本表后删除旧记录
        await this.snapshotVersion(conflict, operator);
        await this.prisma.procurementTemplate.delete({ where: { id: conflict.id } });
      }
    }

    await this.snapshotVersion(current, operator);
    const updated = await this.prisma.procurementTemplate.update({
      where: { id },
      data: { ...patch, version: { increment: 1 } },
    });
    return this.serialize(updated);
  }

  /** 版本历史（新→旧） */
  async versions(id: string) {
    const rows = await this.prisma.procurementTemplateVersion.findMany({
      where: { templateId: id },
      orderBy: [{ version: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      templateName: r.templateName,
      operator: r.operator,
      createdAt: r.createdAt,
    }));
  }

  /** 回滚：基于旧版本内容创建新版本（与合同模板同语义——不覆盖历史） */
  async rollback(id: string, versionRecordId: string, operator?: string) {
    const current = await this.prisma.procurementTemplate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购模板不存在');
    const v = await this.prisma.procurementTemplateVersion.findUnique({ where: { id: versionRecordId } });
    if (!v || v.templateId !== id) throw new NotFoundException('版本记录不存在');

    await this.snapshotVersion(current, operator);
    const updated = await this.prisma.procurementTemplate.update({
      where: { id },
      data: {
        templateName: v.templateName,
        content: v.content,
        variables: v.variables,
        tags: v.tags,
        version: { increment: 1 },
      },
    });
    return this.serialize(updated);
  }

  async remove(id: string) {
    const current = await this.prisma.procurementTemplate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购模板不存在');
    await this.prisma.procurementTemplate.delete({ where: { id } }); // 版本随 Cascade 一并删除
    return { id };
  }

  private serialize(r: {
    id: string;
    moduleType: string;
    templateName: string;
    content: string;
    variables: string | null;
    tags: string | null;
    status: number;
    version: number;
    updatedAt: Date;
    createdAt: Date;
  }) {
    let variables: string[] = [];
    try {
      const parsed = r.variables ? JSON.parse(r.variables) : [];
      if (Array.isArray(parsed)) variables = parsed.filter((v) => typeof v === 'string');
    } catch {
      variables = [];
    }
    return {
      id: r.id,
      moduleType: r.moduleType,
      templateName: r.templateName,
      content: r.content,
      variables,
      tags: r.tags,
      status: r.status,
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

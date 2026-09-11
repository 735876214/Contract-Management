import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/** 允许的采购模块类型（批次一 · 任务 1.2） */
const MODULE_TYPES = [
  'INITIATE', 'PRE_MEETING', 'NOTICE', 'DOCUMENT',
  'RESULT_REPORT', 'PRICE_COMPARE', 'FRAMEWORK', 'INSPECTION',
] as const;

type ModuleType = (typeof MODULE_TYPES)[number];

const isModuleType = (v: unknown): v is ModuleType =>
  typeof v === 'string' && (MODULE_TYPES as readonly string[]).includes(v);

@Injectable()
export class ProcurementTemplateService {
  constructor(private prisma: PrismaClient) {}

  /** 模板列表（当前项目，按模块类型排序） */
  async findAll(projectId: string) {
    const rows = await this.prisma.procurementTemplate.findMany({
      where: { projectId },
      orderBy: [{ moduleType: 'asc' }, { updatedAt: 'desc' }],
    });
    return rows.map((r) => this.serialize(r));
  }

  async findOne(id: string) {
    const r = await this.prisma.procurementTemplate.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('采购模板不存在');
    return this.serialize(r);
  }

  /**
   * 创建模板。同一项目同一业务类型仅保留一个模板：
   * 已存在同类型模板时执行覆盖（前端已做覆盖前确认）。
   */
  async create(
    data: { moduleType?: string; templateName?: string; content?: string; variables?: string[] },
    projectId: string,
  ) {
    const moduleType = data?.moduleType;
    if (!isModuleType(moduleType)) throw new BadRequestException('无效的采购模块类型');
    const templateName = String(data?.templateName ?? '').trim();
    if (!templateName) throw new BadRequestException('请填写模板名称');
    const content = String(data?.content ?? '');
    if (!content.trim()) throw new BadRequestException('请填写模板内容');

    const vars = Array.isArray(data?.variables) ? data.variables.filter((v) => typeof v === 'string') : [];
    const existing = await this.prisma.procurementTemplate.findUnique({
      where: { projectId_moduleType: { projectId, moduleType } },
    });
    if (existing) {
      const updated = await this.prisma.procurementTemplate.update({
        where: { id: existing.id },
        data: { templateName, content, variables: JSON.stringify(vars) },
      });
      return { ...this.serialize(updated), overwritten: true };
    }
    const created = await this.prisma.procurementTemplate.create({
      data: { projectId, moduleType, templateName, content, variables: JSON.stringify(vars) },
    });
    return this.serialize(created);
  }

  /** 更新模板（模块类型变更时同样执行同类型唯一性覆盖） */
  async update(
    id: string,
    data: { moduleType?: string; templateName?: string; content?: string; variables?: string[] },
    projectId: string,
  ) {
    const current = await this.prisma.procurementTemplate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购模板不存在');

    const patch: { moduleType?: string; templateName?: string; content?: string; variables?: string } = {};
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
    if (Array.isArray(data?.variables)) {
      patch.variables = JSON.stringify(data.variables.filter((v) => typeof v === 'string'));
    }

    const nextModuleType = patch.moduleType ?? current.moduleType;
    if (nextModuleType !== current.moduleType) {
      const conflict = await this.prisma.procurementTemplate.findUnique({
        where: { projectId_moduleType: { projectId, moduleType: nextModuleType } },
      });
      if (conflict && conflict.id !== id) {
        // 覆盖同类型旧模板：删除旧记录后更新本记录
        await this.prisma.procurementTemplate.delete({ where: { id: conflict.id } });
      }
    }

    const updated = await this.prisma.procurementTemplate.update({ where: { id }, data: patch });
    return this.serialize(updated);
  }

  async remove(id: string) {
    const current = await this.prisma.procurementTemplate.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('采购模板不存在');
    await this.prisma.procurementTemplate.delete({ where: { id } });
    return { id };
  }

  private serialize(r: {
    id: string;
    moduleType: string;
    templateName: string;
    content: string;
    variables: string | null;
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
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

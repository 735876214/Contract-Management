import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, assertVersion, IMPORT_MAX_ROWS } from '../../common/utils/helpers';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { requestContext } from '../../common/services/request-context';

/**
 * 其他项目库（基础信息管理，2026-11-20）。
 *
 * 收领单「供应单位 / 领用单位 - 其他项目」的数据源。原先是字典 `other_project`
 * （DictItem），迁移时提升为独立主数据并停用字典项；口径与分包商库一致：
 * 项目隔离沿用 `supplier.share.scope`，全局共享时 `projectId` 为空。
 */
const OTHER_PROJECT_FIELDS = ['code', 'name', 'remark', 'status'];

const DISABLED_WORDS = ['停用', '0', '禁用', '否', 'disabled'];

@Injectable()
export class OtherProjectService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private sysParam: SysParamService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
  ) {}

  private async scopeWhere(projectId?: string) {
    const scope = await this.sysParam.get('supplier.share.scope', 'GLOBAL');
    return scope === 'PROJECT' && projectId ? { projectId } : {};
  }

  private async ownerProjectId(projectId?: string) {
    const scope = await this.sysParam.get('supplier.share.scope', 'GLOBAL');
    return scope === 'PROJECT' ? projectId || null : null;
  }

  private async assertNameFree(name: string, projectId: string | null, exceptId?: string) {
    const exist = await this.prisma.otherProject.findFirst({
      where: { name, projectId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (exist) throw new BadRequestException('其他项目名称已存在');
  }

  async findAll(query: any = {}, projectId?: string) {
    const { skip, take } = paginate(query, 500);
    const where: any = { ...(await this.scopeWhere(projectId)) };
    if (query.keyword) {
      where.OR = [{ name: { contains: query.keyword } }, { code: { contains: query.keyword } }];
    }
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    const [list, total] = await Promise.all([
      this.prisma.otherProject.findMany({ where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      this.prisma.otherProject.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async options(projectId?: string, keyword?: string) {
    const where: any = { ...(await this.scopeWhere(projectId)), status: 1 };
    if (keyword) where.OR = [{ name: { contains: keyword } }, { code: { contains: keyword } }];
    return this.prisma.otherProject.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, code: true, name: true },
    });
  }

  async findOne(id: string) {
    const s = await this.prisma.otherProject.findFirst({
      where: { id, ...(await this.scopeWhere(requestContext.projectId)) },
    });
    if (!s) throw new NotFoundException('其他项目不存在');
    return s;
  }

  async create(data: any, projectId?: string, tx?: TxClient) {
    if (!data.name) throw new BadRequestException('项目名称不能为空');
    const db: any = tx || this.prisma;
    const owner = await this.ownerProjectId(projectId);
    await this.assertNameFree(data.name, owner);
    const payload = pickFields(data, OTHER_PROJECT_FIELDS, { label: '其他项目' });
    return db.otherProject.create({ data: { ...payload, projectId: owner } });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    if (data.name && data.name !== before.name) {
      await this.assertNameFree(data.name, before.projectId ?? null, id);
    }
    const payload: any = pickFields(data, OTHER_PROJECT_FIELDS, { label: '其他项目' });
    delete payload.version;
    return this.prisma.otherProject.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async remove(id: string) {
    await this.findOne(id);
    // 收领单的供应单位/领用单位是泛型 ID（supplyUnitId / receivingUnitId），无外键，需显式拦截
    const receipts = await this.prisma.receiptOrder.count({
      where: { OR: [{ supplyUnitId: id }, { receivingUnitId: id }] },
    });
    if (receipts > 0) throw new BadRequestException(`该其他项目已被 ${receipts} 张收领单引用，不可删除，仅可停用`);
    return this.prisma.otherProject.delete({ where: { id } });
  }

  async toggle(id: string) {
    const s = await this.findOne(id);
    return this.prisma.otherProject.update({ where: { id }, data: { status: s.status === 1 ? 0 : 1 } });
  }

  // ---------------- Excel ----------------
  private columns() {
    return [
      { header: '项目编号', key: 'code', width: 20 },
      { header: '项目名称', key: 'name', width: 32 },
      { header: '备注', key: 'remark', width: 26 },
      { header: '状态', key: 'status', width: 10 },
    ];
  }

  async export(projectId?: string) {
    const res = await this.findAll({ pageSize: IMPORT_MAX_ROWS }, projectId);
    const rows = (res.list as any[]).map((s) => ({ ...s, status: s.status === 1 ? '启用' : '停用' }));
    return this.excel.export(this.columns(), rows, '其他项目库');
  }

  async import(buffer: Buffer, projectId?: string, meta?: { fileName?: string; user?: any; validateOnly?: boolean }) {
    const rows = await this.excel.parse(buffer, [2]);
    const owner = await this.ownerProjectId(projectId);
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>(
      { module: 'other-project', moduleName: '其他项目库', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username },
      rows,
      {
        plan: async (r, { rowNo }) => {
          const name = String(r['项目名称'] ?? '').trim();
          if (!name) throw new RowError('项目名称为必填项', '项目名称');
          notDup(name, `项目名称「${name}」在本次导入中重复`, '项目名称');
          const exist = await this.prisma.otherProject.findFirst({
            where: { name, projectId: owner },
            select: { id: true },
          });
          return {
            name,
            existingId: exist?.id ?? null,
            payload: {
              name,
              code: r['项目编号'] || null,
              remark: r['备注'] || null,
              status: DISABLED_WORDS.includes(String(r['状态'] ?? '').trim()) ? 0 : 1,
            },
          };
        },
        write: async (plans, tx) => {
          let created = 0;
          let updated = 0;
          for (const p of plans as any[]) {
            if (p.existingId) {
              await tx.otherProject.update({ where: { id: p.existingId }, data: { ...p.payload, version: { increment: 1 } } });
              updated++;
            } else {
              await tx.otherProject.create({ data: { ...p.payload, projectId: owner } });
              created++;
            }
          }
          return { created, updated };
        },
      },
      meta?.validateOnly ?? false,
    );
  }

  async template() {
    const columns: TemplateColumn[] = [
      { label: '项目编号', key: 'code', type: 'text', width: 20, example: 'XM-2026-001' },
      { label: '项目名称', key: 'name', required: true, width: 26, example: '某某二期工程', desc: '项目内唯一' },
      { label: '状态', key: 'status', type: 'select', width: 10, example: '启用', options: ['启用', '停用'] },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '其他项目库', sheetName: '数据', columns });
  }
}

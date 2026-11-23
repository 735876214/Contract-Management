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
import { keywordWhere } from '../../common/utils/list-where';
import { sharedScopeWhere } from '../../common/utils/project-scope';

/**
 * 分包商库（基础信息管理，2026-11-20）。
 *
 * 与「供应商库」同构的主数据：项目隔离口径沿用 `supplier.share.scope`
 * （GLOBAL 全局共享 / PROJECT 项目隔离），全局共享时 `projectId` 为空。
 * 收领单「供应单位 / 领用单位 - 分包商」从本表取数；劳务授权台账通过
 * `LaborAuthLedger.subcontractorId` 挂靠本表，台账里的名称为快照。
 */
const SUBCONTRACTOR_FIELDS = [
  'name', 'creditCode', 'legalPerson', 'contactName', 'contactPhone', 'remark', 'status',
];

/** 导入时被识别为「停用」的状态文本（与供应商库同口径） */
const DISABLED_WORDS = ['停用', '0', '禁用', '否', 'disabled'];

@Injectable()
export class SubcontractorService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private sysParam: SysParamService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
  ) {}

  /** 共享范围：GLOBAL 全局共享 / PROJECT 项目隔离（沿用 supplier.share.scope） */
  private async scopeWhere(projectId?: string | null) {
    const scope = await this.sysParam.get('supplier.share.scope', 'GLOBAL');
    // 单一实现（含 fail-closed）：不再各模块手抄「没项目 id 就不过滤」
    return sharedScopeWhere(scope, projectId);
  }

  /** 唯一键口径：`@@unique([projectId, name])` 里 projectId 为空时 PG 不判重，需应用层查 */
  private async ownerProjectId(projectId?: string) {
    const scope = await this.sysParam.get('supplier.share.scope', 'GLOBAL');
    return scope === 'PROJECT' ? projectId || null : null;
  }

  private async assertNameFree(name: string, projectId: string | null, exceptId?: string) {
    const exist = await this.prisma.subcontractor.findFirst({
      where: { name, projectId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (exist) throw new BadRequestException('分包商名称已存在');
  }

  async findAll(query: any = {}, projectId?: string) {
    const { skip, take } = paginate(query, 500);
    const where: any = { ...(await this.scopeWhere(projectId)) };
    const kw = keywordWhere(['name', 'legalPerson', 'contactName', 'contactPhone', 'creditCode'], query.keyword);
    if (kw) where.OR = kw.OR;
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    const [list, total] = await Promise.all([
      this.prisma.subcontractor.findMany({ where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
      this.prisma.subcontractor.count({ where }),
    ]);
    // 附带被授权台账引用数（删除前的引用提示用）
    const ids = list.map((s: any) => s.id);
    const refs = ids.length
      ? await this.prisma.laborAuthLedger.groupBy({ by: ['subcontractorId'], where: { subcontractorId: { in: ids } }, _count: { _all: true } })
      : [];
    const refMap = refs.reduce((acc: any, r: any) => ({ ...acc, [r.subcontractorId]: r._count._all }), {});
    return buildResult(list.map((s: any) => ({ ...s, ledgerCount: refMap[s.id] || 0 })), total, query);
  }

  async options(projectId?: string, keyword?: string) {
    const where: any = { ...(await this.scopeWhere(projectId)), status: 1 };
    if (keyword) where.name = { contains: keyword };
    return this.prisma.subcontractor.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 500,
      select: { id: true, name: true, legalPerson: true, contactName: true, contactPhone: true, creditCode: true },
    });
  }

  async findOne(id: string) {
    const s = await this.prisma.subcontractor.findFirst({
      where: { id, ...(await this.scopeWhere(requestContext.projectId)) },
    });
    if (!s) throw new NotFoundException('分包商不存在');
    return s;
  }

  /** 按名称查找当前项目可见的分包商（供台账挂靠、导入解析复用） */
  async findByName(name: string, projectId?: string) {
    const n = String(name ?? '').trim();
    if (!n) return null;
    return this.prisma.subcontractor.findFirst({
      where: { name: n, ...(await this.scopeWhere(projectId ?? requestContext.projectId)) },
    });
  }

  /**
   * 按名称解析分包商，不存在则创建（劳务授权台账登记 / 导入时使用）。
   * 传入 `tx` 时并入调用方事务。
   */
  async resolveOrCreate(name: string, projectId?: string, tx?: TxClient, extra: any = {}) {
    const n = String(name ?? '').trim();
    if (!n) return null;
    const db: any = tx || this.prisma;
    const found = await db.subcontractor.findFirst({ where: { name: n, ...(await this.scopeWhere(projectId)) } });
    if (found) return found;
    const owner = await this.ownerProjectId(projectId);
    const extraPayload = pickFields(extra, SUBCONTRACTOR_FIELDS, { label: '分包商' });
    return db.subcontractor.create({ data: { ...extraPayload, name: n, projectId: owner } });
  }

  async create(data: any, projectId?: string, tx?: TxClient) {
    if (!data.name) throw new BadRequestException('分包商名称不能为空');
    const db: any = tx || this.prisma;
    const owner = await this.ownerProjectId(projectId);
    await this.assertNameFree(data.name, owner);
    const payload = pickFields(data, SUBCONTRACTOR_FIELDS, { label: '分包商' });
    return db.subcontractor.create({ data: { ...payload, projectId: owner } });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    if (data.name && data.name !== before.name) {
      await this.assertNameFree(data.name, before.projectId ?? null, id);
    }
    const payload: any = pickFields(data, SUBCONTRACTOR_FIELDS, { label: '分包商' });
    delete payload.version;
    return this.prisma.subcontractor.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async remove(id: string) {
    await this.findOne(id);
    // 引用检查：台账 SetNull 会静默断开挂靠、单据 Cascade 会连带删单据 —— 一律要求先停用
    const [ledgers, receipts, docs, details] = await Promise.all([
      this.prisma.laborAuthLedger.count({ where: { subcontractorId: id } }),
      this.prisma.receiptOrder.count({ where: { subcontractorId: id } }),
      this.prisma.laborReceivingDoc.count({ where: { subcontractorId: id } }),
      this.prisma.monthlyProfitLossDetail.count({ where: { subcontractorId: id } }),
    ]);
    const total = ledgers + receipts + docs + details;
    if (total > 0) {
      throw new BadRequestException(`该分包商已被 ${total} 处业务数据引用（授权台账/收领单/领用单据/盈亏分析），不可删除，仅可停用`);
    }
    return this.prisma.subcontractor.delete({ where: { id } });
  }

  async toggle(id: string) {
    const s = await this.findOne(id);
    return this.prisma.subcontractor.update({ where: { id }, data: { status: s.status === 1 ? 0 : 1 } });
  }

  // ---------------- Excel ----------------
  private columns() {
    return [
      { header: '分包商名称', key: 'name', width: 32 },
      { header: '统一社会信用代码', key: 'creditCode', width: 24 },
      { header: '法人代表', key: 'legalPerson', width: 14 },
      { header: '联系人', key: 'contactName', width: 14 },
      { header: '联系电话', key: 'contactPhone', width: 16 },
      { header: '备注', key: 'remark', width: 26 },
      { header: '状态', key: 'status', width: 10 },
    ];
  }

  async export(projectId?: string) {
    const res = await this.findAll({ pageSize: IMPORT_MAX_ROWS }, projectId);
    const rows = (res.list as any[]).map((s) => ({ ...s, status: s.status === 1 ? '启用' : '停用' }));
    return this.excel.export(this.columns(), rows, '分包商库');
  }

  async import(buffer: Buffer, projectId?: string, meta?: { fileName?: string; user?: any; validateOnly?: boolean }) {
    const rows = await this.excel.parse(buffer, [2]);
    const owner = await this.ownerProjectId(projectId);
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>(
      { module: 'subcontractor', moduleName: '分包商库', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username },
      rows,
      {
        plan: async (r, { rowNo: _rowNo }) => {
          const name = String(r['分包商名称'] ?? '').trim();
          if (!name) throw new RowError('分包商名称为必填项', '分包商名称');
          notDup(name, `分包商名称「${name}」在本次导入中重复`, '分包商名称');
          const exist = await this.prisma.subcontractor.findFirst({
            where: { name, projectId: owner },
            select: { id: true },
          });
          return {
            name,
            existingId: exist?.id ?? null,
            payload: {
              name,
              creditCode: r['统一社会信用代码'] || null,
              legalPerson: r['法人代表'] || null,
              contactName: r['联系人'] || null,
              contactPhone: r['联系电话'] || null,
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
              await tx.subcontractor.update({ where: { id: p.existingId }, data: { ...p.payload, version: { increment: 1 } } });
              updated++;
            } else {
              await tx.subcontractor.create({ data: { ...p.payload, projectId: owner } });
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
      { label: '分包商名称', key: 'name', required: true, width: 26, example: '某某建筑劳务有限公司', desc: '项目内唯一' },
      { label: '统一社会信用代码', key: 'creditCode', type: 'text', width: 22, example: '91310000MA1FL00000' },
      { label: '法人代表', key: 'legalPerson', type: 'text', width: 12, example: '张三' },
      { label: '联系人', key: 'contactName', type: 'text', width: 12, example: '李四' },
      { label: '联系电话', key: 'contactPhone', type: 'text', width: 14, example: '13800000000' },
      { label: '状态', key: 'status', type: 'select', width: 10, example: '启用', options: ['启用', '停用'] },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '分包商库', sheetName: '数据', columns });
  }
}

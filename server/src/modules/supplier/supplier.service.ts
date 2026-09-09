import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, assertVersion } from '../../common/utils/helpers';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { SysParamService } from '../../common/services/sys-param.service';

const SUPPLIER_FIELDS = [
  'name', 'legalPerson', 'legalPhone', 'contractAuthPerson', 'contractAuthPhone',
  'contractAuthIdNo', 'contactName', 'contactPhone', 'contactEmail', 'bankName',
  'bankAccount', 'address', 'remark', 'status', 'projectId',
];

@Injectable()
export class SupplierService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private sysParam: SysParamService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
  ) {}

  /** 供应商库共享范围：GLOBAL 全局共享 / PROJECT 项目隔离 */
  private async scopeWhere(projectId: string) {
    const scope = await this.sysParam.get('supplier.share.scope', 'GLOBAL');
    return scope === 'PROJECT' && projectId ? { projectId } : {};
  }

  async findAll(query: any = {}, projectId?: string) {
    const { skip, take } = paginate(query);
    const base = await this.scopeWhere(projectId);
    const where: any = { ...base };
    if (query.keyword) {
      where.OR = [
        { name: { contains: query.keyword } },
        { legalPerson: { contains: query.keyword } },
        { contactName: { contains: query.keyword } },
        { contactPhone: { contains: query.keyword } },
      ];
    }
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    const [list, total] = await Promise.all([
      this.prisma.supplier.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.supplier.count({ where }),
    ]);
    // 附带被引用合同数
    const ids = list.map((s: any) => s.id);
    const refs = await this.prisma.contract.groupBy({ by: ['supplierId'], where: { supplierId: { in: ids } }, _count: { _all: true } });
    const refMap = refs.reduce((acc: any, r: any) => ({ ...acc, [r.supplierId]: r._count._all }), {});
    return buildResult(list.map((s: any) => ({ ...s, contractCount: refMap[s.id] || 0 })), total, query);
  }

  async options(projectId?: string, keyword?: string) {
    const base = await this.scopeWhere(projectId);
    const where: any = { ...base, status: 1 };
    if (keyword) where.name = { contains: keyword };
    const list = await this.prisma.supplier.findMany({
      where,
      orderBy: { name: 'asc' },
      select: { id: true, name: true, legalPerson: true, contactName: true, contactPhone: true, bankName: true, bankAccount: true },
    });
    return list;
  }

  async findOne(id: string) {
    const s = await this.prisma.supplier.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('供应商不存在');
    return s;
  }

  async create(data: any, projectId?: string) {
    if (!data.name) throw new BadRequestException('供应商名称不能为空');
    const exist = await this.prisma.supplier.findUnique({ where: { name: data.name } });
    if (exist) throw new BadRequestException('供应商名称已存在（系统内唯一）');
    const scope = await this.sysParam.get('supplier.share.scope', 'GLOBAL');
    const payload = pickFields(data, SUPPLIER_FIELDS, { label: '供应商' });
    return this.prisma.supplier.create({ data: { ...payload, projectId: scope === 'PROJECT' ? projectId : null } });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    if (data.name && data.name !== before.name) {
      const exist = await this.prisma.supplier.findUnique({ where: { name: data.name } });
      if (exist) throw new BadRequestException('供应商名称已存在（系统内唯一）');
    }
    const payload: any = pickFields(data, SUPPLIER_FIELDS, { label: '供应商' });
    delete payload.version;
    return this.prisma.supplier.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async remove(id: string) {
    const count = await this.prisma.contract.count({ where: { supplierId: id } });
    if (count > 0) throw new BadRequestException(`该供应商已被 ${count} 份合同引用，不可删除，仅可停用`);
    return this.prisma.supplier.delete({ where: { id } });
  }

  async toggle(id: string) {
    const s = await this.findOne(id);
    return this.prisma.supplier.update({ where: { id }, data: { status: s.status === 1 ? 0 : 1 } });
  }

  // ---------------- Excel ----------------
  private columns() {
    return [
      { header: '供应商名称', key: 'name', width: 32 },
      { header: '法人姓名', key: 'legalPerson', width: 14 },
      { header: '法人电话', key: 'legalPhone', width: 16 },
      { header: '合同授权人姓名', key: 'contractAuthPerson', width: 16 },
      { header: '合同授权人电话', key: 'contractAuthPhone', width: 16 },
      { header: '合同授权人身份证号', key: 'contractAuthIdNo', width: 24 },
      { header: '联系人姓名', key: 'contactName', width: 14 },
      { header: '联系人电话', key: 'contactPhone', width: 16 },
      { header: '联系人邮箱', key: 'contactEmail', width: 24 },
      { header: '银行名称', key: 'bankName', width: 26 },
      { header: '银行账号', key: 'bankAccount', width: 26 },
      { header: '公司地址', key: 'address', width: 34 },
      { header: '备注', key: 'remark', width: 24 },
      { header: '状态', key: 'status', width: 10 },
    ];
  }

  async export(projectId?: string) {
    const res = await this.findAll({ pageSize: 500 }, projectId);
    const rows = (res.list as any[]).map((s) => ({ ...s, status: s.status === 1 ? '启用' : '停用' }));
    return this.excel.export(this.columns(), rows, '供应商库');
  }

  /** 供应商信息导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async import(buffer: Buffer, projectId?: string, meta?: { fileName?: string; user?: any }) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const scope = await this.sysParam.get('supplier.share.scope', 'GLOBAL');
    const ownerProjectId = scope === 'PROJECT' ? projectId || null : null;
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'supplier', moduleName: '供应商库', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r, { rowNo }) => {
        const name = String(r['供应商名称'] ?? '').trim();
        if (!name) throw new RowError('供应商名称为必填项', '供应商名称');
        notDup(name, `供应商名称「${name}」在本次导入中重复`, '供应商名称');
        return {
          name,
          payload: {
            name,
            legalPerson: r['法人姓名'] || null,
            legalPhone: r['法人电话'] || null,
            contractAuthPerson: r['合同授权人姓名'] || null,
            contractAuthPhone: r['合同授权人电话'] || null,
            contractAuthIdNo: r['合同授权人身份证号'] || null,
            contactName: r['联系人姓名'] || null,
            contactPhone: r['联系人电话'] || null,
            contactEmail: r['联系人邮箱'] || null,
            bankName: r['银行名称'] || null,
            bankAccount: r['银行账号'] || null,
            address: r['公司地址'] || null,
            remark: r['备注'] || null,
            status: String(r['状态'] ?? '启用') === '停用' ? 0 : 1,
          },
        };
      },
      write: async (plans, tx) => {
        let created = 0;
        let updated = 0;
        for (const p of plans) {
          const exist = await tx.supplier.findUnique({ where: { name: p.name } });
          if (exist) {
            await tx.supplier.update({ where: { id: exist.id }, data: { ...p.payload, version: { increment: 1 } } });
            updated++;
          } else {
            await tx.supplier.create({ data: { ...p.payload, projectId: ownerProjectId } });
            created++;
          }
        }
        return { created, updated };
      },
    });
  }

  /** 供应商信息填写模板（需求 3.3，实际字段口径） */
  async template() {
    const columns: TemplateColumn[] = [
      { label: '供应商名称', key: 'name', required: true, width: 26, example: '某某钢铁贸易有限公司', desc: '全局唯一' },
      { label: '法人姓名', key: 'legalPerson', type: 'text', width: 12, example: '张三' },
      { label: '法人电话', key: 'legalPhone', type: 'text', width: 14, example: '13800000001' },
      { label: '合同授权人姓名', key: 'contractAuthPerson', type: 'text', width: 14, example: '李四' },
      { label: '合同授权人电话', key: 'contractAuthPhone', type: 'text', width: 16, example: '13800000002' },
      { label: '合同授权人身份证号', key: 'contractAuthIdNo', type: 'text', width: 20, example: '310101199001010011' },
      { label: '联系人姓名', key: 'contactName', type: 'text', width: 12, example: '王五' },
      { label: '联系人电话', key: 'contactPhone', type: 'text', width: 14, example: '13800000003' },
      { label: '联系人邮箱', key: 'contactEmail', type: 'text', width: 20, example: 'wangwu@example.com' },
      { label: '银行名称', key: 'bankName', type: 'text', width: 22, example: '中国建设银行上海分行' },
      { label: '银行账号', key: 'bankAccount', type: 'text', width: 22, example: '31001234567890123456' },
      { label: '公司地址', key: 'address', type: 'text', width: 30, example: '上海市浦东新区某某路 88 号' },
      { label: '状态', key: 'status', type: 'select', width: 10, example: '启用', options: ['启用', '停用'] },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '供应商信息', sheetName: '数据', columns });
  }
}

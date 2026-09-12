import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { DictService } from '../dict/dict.service';

const PROJECT_FIELDS = [
  'code', 'name', 'nameAbbr', 'codeAbbr', 'undertaker', 'selfContractAmount', 'industryType',
  'provinceCity', 'siteLocation', 'projectAddress', 'materialOrigin',
  'status', 'description', 'startDate', 'endDate', 'managerId',
];
const CODE_ABBR_RE = /^[A-Z0-9]+$/;

@Injectable()
export class ProjectService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
  ) {}

  async findAll(query: any = {}, user: any) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.keyword) where.OR = [{ name: { contains: query.keyword } }, { code: { contains: query.keyword } }];
    if (query.status) where.status = query.status;
    if (!user?.isSuperAdmin) {
      where.members = { some: { userId: user.userId } };
    }
    const [list, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { members: { include: { user: { select: { id: true, realName: true, username: true } } } } },
      }),
      this.prisma.project.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const p = await this.prisma.project.findUnique({
      where: { id },
      include: { members: { include: { user: { select: { id: true, realName: true, username: true, phone: true } } } } },
    });
    if (!p) throw new NotFoundException('项目不存在');
    return p;
  }

  /** 字母版简称校验：非空时仅限大写字母和数字，且全局唯一 */
  private async assertCodeAbbr(codeAbbr: string | undefined, excludeId?: string) {
    if (codeAbbr === undefined || codeAbbr === null || codeAbbr === '') return;
    if (!CODE_ABBR_RE.test(codeAbbr)) {
      throw new BadRequestException('项目简称（字母版）仅允许大写字母和数字');
    }
    const exist = await this.prisma.project.findFirst({ where: { codeAbbr, ...(excludeId ? { id: { not: excludeId } } : {}) } });
    if (exist) throw new BadRequestException(`项目简称（字母版）${codeAbbr} 已存在（用于合同编号，须唯一）`);
  }

  async create(data: any, tx?: TxClient) {
    const db: any = tx || this.prisma;
    if (!data.code) throw new BadRequestException('项目编码不能为空');
    const exist = await this.prisma.project.findUnique({ where: { code: data.code } });
    if (exist) throw new BadRequestException('项目编码已存在');
    await this.dict.validate('project_status', data.status);
    await this.dict.validate('industry_type', data.industryType);
    await this.assertCodeAbbr(data.codeAbbr);
    return db.project.create({ data: pickFields(data, PROJECT_FIELDS, { label: '项目' }) });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    if (data.status) await this.dict.validate('project_status', data.status);
    await this.dict.validate('industry_type', data.industryType);
    await this.assertCodeAbbr(data.codeAbbr, id);
    const payload: any = pickFields(data, PROJECT_FIELDS, { label: '项目' });
    delete payload.version;
    return this.prisma.project.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  async remove(id: string) {
    const counts = await Promise.all([
      this.prisma.contract.count({ where: { projectId: id } }),
      this.prisma.dailyReport.count({ where: { projectId: id } }),
      this.prisma.settlement.count({ where: { projectId: id } }),
      this.prisma.invoice.count({ where: { projectId: id } }),
    ]);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > 0) throw new BadRequestException(`该项目下存在 ${total} 条业务数据，不可删除，建议归档`);
    await this.prisma.projectMember.deleteMany({ where: { projectId: id } });
    return this.prisma.project.delete({ where: { id } });
  }

  async members(projectId: string) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, realName: true, username: true, phone: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(projectId: string, userId: string, roleCode: string) {
    await this.dict.validate('project_member_role', roleCode, true);
    const exist = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (exist) return this.prisma.projectMember.update({ where: { id: exist.id }, data: { roleCode } });
    return this.prisma.projectMember.create({ data: { projectId, userId, roleCode } });
  }

  async removeMember(projectId: string, userId: string) {
    await this.prisma.projectMember.deleteMany({ where: { projectId, userId } });
    return true;
  }

  /** 项目信息填写模板（需求 3.3，实际字段口径） */
  async template() {
    const [industry, status] = await Promise.all([
      this.dict.options('industry_type'), this.dict.options('project_status'),
    ]);
    const columns: TemplateColumn[] = [
      { label: '项目编码', key: 'code', required: true, width: 16, example: 'XM-2026-003', desc: '全局唯一' },
      { label: '项目名称', key: 'name', required: true, width: 28, example: '城东科创园项目' },
      { label: '项目简称（文字）', key: 'nameAbbr', type: 'text', width: 18, example: '城东科创园' },
      { label: '项目简称（字母）', key: 'codeAbbr', type: 'text', width: 16, example: 'CDKC', desc: '仅大写字母和数字，全局唯一，用于合同编号' },
      { label: '承接单位', key: 'undertaker', type: 'text', width: 24, example: '中国建筑土木建设有限公司' },
      { label: '项目自施合同额（万元）', key: 'selfContractAmount', type: 'money', width: 22, example: 35000 },
      { label: '项目业态', key: 'industryType', type: 'select', width: 14, example: '房建', options: industry.map((i: any) => i.itemName).filter(Boolean) },
      { label: '项目所在省市', key: 'provinceCity', type: 'text', width: 18, example: '广东省深圳市' },
      { label: '工程地点', key: 'siteLocation', type: 'text', width: 24, example: '深圳市南山区科技园南区' },
      { label: '项目地址', key: 'projectAddress', type: 'text', width: 30, example: '深圳市南山区科苑南路 3099 号' },
      { label: '状态', key: 'status', type: 'select', width: 12, example: '在建', options: status.map((i: any) => i.itemName).filter(Boolean) },
      { label: '开工日期', key: 'startDate', type: 'date', width: 14, example: '2026-03-01' },
      { label: '竣工日期', key: 'endDate', type: 'date', width: 14, example: '2028-06-30' },
      { label: '描述', key: 'description', type: 'text', width: 24, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '项目信息', sheetName: '数据', columns });
  }

  /** 项目信息导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importProjects(buffer: Buffer, meta?: { fileName?: string; user?: any }) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const [industry, status] = await Promise.all([
      this.dict.options('industry_type'), this.dict.options('project_status'),
    ]);
    const codeOf = (items: any[], val: any) =>
      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'project', moduleName: '项目信息', fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r) => {
        const code = String(r['项目编码'] ?? '').trim();
        if (!code) throw new RowError('项目编码为必填项', '项目编码');
        const name = String(r['项目名称'] ?? '').trim();
        if (!name) throw new RowError('项目名称为必填项', '项目名称');
        notDup(code, `项目编码「${code}」在本次导入中重复`, '项目编码');
        const exist = await this.prisma.project.findUnique({ where: { code } });
        if (exist) throw new RowError(`唯一性校验失败：项目编码 ${code} 已存在，导入不覆盖已有数据`, '项目编码');
        const industryVal = String(r['项目业态'] ?? '').trim();
        const industryType = codeOf(industry, industryVal);
        if (industryVal && industryType === null) throw new RowError(`下拉校验失败：「${industryVal}」不在项目业态选项范围内`, '项目业态');
        const statusVal = String(r['状态'] ?? '').trim();
        const statusCode = codeOf(status, statusVal);
        if (statusVal && statusCode === null) throw new RowError(`下拉校验失败：「${statusVal}」不在项目状态选项范围内`, '状态');
        return {
          data: {
          code,
          name,
          nameAbbr: String(r['项目简称（文字）'] ?? '').trim() || null,
          codeAbbr: String(r['项目简称（字母）'] ?? '').trim() || null,
          undertaker: String(r['承接单位'] ?? '').trim() || null,
          selfContractAmount: num(r['项目自施合同额（万元）']),
          industryType,
          provinceCity: String(r['项目所在省市'] ?? '').trim() || null,
          siteLocation: String(r['工程地点'] ?? '').trim() || null,
          projectAddress: String(r['项目地址'] ?? '').trim() || null,
          status: statusCode,
          startDate: r['开工日期'] || null,
          endDate: r['竣工日期'] || null,
          description: String(r['描述'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.create(p.data, tx);
        return { created: plans.length };
      },
    });
  }
}

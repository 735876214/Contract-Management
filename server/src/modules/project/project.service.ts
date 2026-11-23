import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '../../common/calc/numeric';
import { toDate } from '../../common/calc/time';
import { paginate, buildResult, assertVersion, versionedUpdate } from '../../common/utils/helpers';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { DictService } from '../dict';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { PROJECT_SCOPED_TABLES } from './project-scoped-tables';

const PROJECT_FIELDS = [
  'code', 'name', 'nameAbbr', 'codeAbbr', 'branchCompany', 'branchCompanyAbbr',
  'undertaker', 'packageLeader', 'projectManager', 'selfContractAmount', 'industryType',
  'provinceCity', 'siteLocation', 'projectAddress', 'materialOrigin',
  'status', 'description', 'startDate', 'endDate', 'managerId',
  // 月度结算起始日期（其「日」为每期起始日；自动生成结算与发票/收领单归属都按它算期）
  'settlementStartDate',
];
const CODE_ABBR_RE = /^[A-Z0-9]+$/;
/** 分公司简称（总结算书编号前缀，如 TMHB）：仅大写字母与数字，最多 20 位，不要求唯一 */
const BRANCH_ABBR_RE = /^[A-Z0-9]{1,20}$/;

@Injectable()
export class ProjectService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
    private access: ProjectAccessService,
  ) {}

  /**
   * 项目级访问校验（成员关系）。
   *
   * `@ProjectId()` 只保证「请求头里的项目是自己的」，不保证 URL 里的项目 id 是自己的：
   * 不校验时任何持 `project:view` 的成员换个 id 就能读别项目详情（含全部成员手机号/邮箱），
   * 持 `project:edit` 的还能改写/删除别项目、增删别项目成员。超管按设计放行。
   */
  private async assertAccess(id: string, user?: any) {
    await this.access.assertAccess(user?.userId, id, !!user?.isSuperAdmin);
  }

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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { members: { include: { user: { select: { id: true, realName: true, username: true } } } } },
      }),
      this.prisma.project.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string, user?: any) {
    await this.assertAccess(id, user);
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

  /** 分公司简称校验：非空时仅限大写字母和数字（≤20）；并把空串归一为 null、字母归一为大写 */
  private assertBranchAbbr(value: any): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const v = String(value).trim().toUpperCase();
    if (!v) return null;
    if (!BRANCH_ABBR_RE.test(v)) {
      throw new BadRequestException('分公司简称仅允许大写字母和数字（最多 20 位）');
    }
    return v;
  }

  async create(data: any, tx?: TxClient) {
    const db: any = tx || this.prisma;
    if (!data.code) throw new BadRequestException('项目编码不能为空');
    const exist = await this.prisma.project.findUnique({ where: { code: data.code } });
    if (exist) throw new BadRequestException('项目编码已存在');
    await this.dict.validate('project_status', data.status);
    await this.dict.validate('industry_type', data.industryType);
    await this.assertCodeAbbr(data.codeAbbr);
    if (data.branchCompanyAbbr !== undefined) data.branchCompanyAbbr = this.assertBranchAbbr(data.branchCompanyAbbr);
    // 日期字段经 toDate 归一化：前端/导入传 'YYYY-MM-DD' 时 Prisma 会报
    // 「Invalid value ... Expected ISO-8601 DateTime」，服务端统一转换而不是要求调用方拼时间
    const payload: any = pickFields(data, PROJECT_FIELDS, { label: '项目' });
    for (const f of ['settlementStartDate', 'startDate', 'endDate']) {
      if (payload[f] !== undefined) payload[f] = toDate(payload[f]);
    }
    return db.project.create({ data: payload });
  }

  async update(id: string, data: any, user?: any) {
    const before = await this.findOne(id, user);
    assertVersion(before, data);
    if (data.status) await this.dict.validate('project_status', data.status);
    await this.dict.validate('industry_type', data.industryType);
    await this.assertCodeAbbr(data.codeAbbr, id);
    if (data.branchCompanyAbbr !== undefined) data.branchCompanyAbbr = this.assertBranchAbbr(data.branchCompanyAbbr);
    const payload: any = pickFields(data, PROJECT_FIELDS, { label: '项目' });
    for (const f of ['settlementStartDate', 'startDate', 'endDate']) {
      if (payload[f] !== undefined) payload[f] = toDate(payload[f]);
    }
    /**
     * 结算起始日决定「结算期」边界（期 = 起始日 → 下月同日的前一日），而
     * `Settlement.settleDate` / 台账 `settleMonth` / 发票与收领单的自动匹配全都按它派生。
     * 已有结算单时改它会让期归属整体漂移（同合同两张单落入同一期、台账月份错位、发票匹配不到原单），
     * 且没有任何自动回填能还原 —— 直接拦住，要求先处理结算数据。
     */
    if (payload.settlementStartDate !== undefined) {
      const next = payload.settlementStartDate ? new Date(payload.settlementStartDate).getTime() : null;
      const prev = before.settlementStartDate ? new Date(before.settlementStartDate).getTime() : null;
      if (next !== prev) {
        const count = await this.prisma.settlement.count({ where: { projectId: id } });
        if (count > 0) {
          throw new BadRequestException(
            `项目已有 ${count} 张结算单，修改结算起始日会让结算期归属整体漂移（台账月份、发票/收领单自动匹配都会错位）。请先处理结算数据。`,
          );
        }
      }
    }
    delete payload.version;
    return versionedUpdate(this.prisma.project, id, before.version, payload);
  }

  async remove(id: string, user?: any) {
    await this.assertAccess(id, user);
    /**
     * 项目下**所有**项目级业务表都要计入：这些表的 projectId 外键是 `onDelete: Cascade`，
     * 只看合同/日报/结算/发票会放行「已有招标或劳务/成本数据」的项目，
     * 删除时由数据库静默级联清空，事后无法追溯（操作日志里也只留项目一行）。
     *
     * 清单在 `project-scoped-tables.ts`，与 schema 的项目级 Cascade 关系一一对应，
     * 由 `server/test/projectDeleteScope.spec.mts` 锁住（2026-11-19 审计 P2：此处曾只数 15 类，漏 14 张表）。
     */
    const counts = await Promise.all(
      PROJECT_SCOPED_TABLES.map((t) => (this.prisma as any)[t.model].count({ where: { projectId: id } })),
    );
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > 0) {
      const detail = PROJECT_SCOPED_TABLES.map((t, i) => [t.label, counts[i]] as const)
        .filter(([, n]) => n > 0)
        .map(([label, n]) => `${label} ${n} 条`)
        .join('、');
      throw new BadRequestException(`该项目下存在业务数据（${detail}），不可删除，建议归档`);
    }
    await this.prisma.projectMember.deleteMany({ where: { projectId: id } });
    return this.prisma.project.delete({ where: { id } });
  }

  async members(projectId: string, user?: any) {
    await this.assertAccess(projectId, user);
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, realName: true, username: true, phone: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(projectId: string, userId: string, roleCode: string, user?: any) {
    await this.assertAccess(projectId, user);
    await this.dict.validate('project_member_role', roleCode, true);
    const exist = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (exist) return this.prisma.projectMember.update({ where: { id: exist.id }, data: { roleCode } });
    return this.prisma.projectMember.create({ data: { projectId, userId, roleCode } });
  }

  async removeMember(projectId: string, userId: string, user?: any) {
    await this.assertAccess(projectId, user);
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
      { label: '分管分公司', key: 'branchCompany', type: 'text', width: 20, example: '土木公司华北分公司' },
      { label: '分公司简称', key: 'branchCompanyAbbr', type: 'text', width: 14, example: 'TMHB', desc: '用于总结算书编号前缀，仅大写字母和数字' },
      { label: '承接单位', key: 'undertaker', type: 'text', width: 24, example: '中国建筑土木建设有限公司' },
      { label: '项目包保领导', key: 'packageLeader', type: 'text', width: 16, example: '张三' },
      { label: '项目经理', key: 'projectManager', type: 'text', width: 16, example: '李四' },
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
  async importProjects(buffer: Buffer, meta?: { fileName?: string; user?: any; validateOnly?: boolean }) {
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
        const branchCompanyAbbr = String(r['分公司简称'] ?? '').trim().toUpperCase();
        if (branchCompanyAbbr && !BRANCH_ABBR_RE.test(branchCompanyAbbr)) {
          throw new RowError('分公司简称仅允许大写字母和数字（最多 20 位）', '分公司简称');
        }
        return {
          data: {
          code,
          name,
          nameAbbr: String(r['项目简称（文字）'] ?? '').trim() || null,
          codeAbbr: String(r['项目简称（字母）'] ?? '').trim() || null,
          branchCompany: String(r['分管分公司'] ?? '').trim() || null,
          branchCompanyAbbr: branchCompanyAbbr || null,
          undertaker: String(r['承接单位'] ?? '').trim() || null,
          packageLeader: String(r['项目包保领导'] ?? '').trim() || null,
          projectManager: String(r['项目经理'] ?? '').trim() || null,
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
    }, meta?.validateOnly ?? false);
  }
}

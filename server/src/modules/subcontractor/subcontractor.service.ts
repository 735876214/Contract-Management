import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, assertVersion } from '../../common/utils/helpers';

/** 允许从前端写入的字段白名单 */
const EDITABLE_FIELDS = [
  'subcontractorName',
  'subcontractContent',
  'subcontractId',
  'legalPerson',
  'authorizedPerson',
  'authorizedPersonIdNo',
  'projectName',
  'idCardFront',
  'idCardBack',
  'signatureScreenshot',
  'signedAuthFile',
  'remark',
];

/** 状态：编辑中 / 已完成 */
export const SUB_STATUS = {
  EDITING: 'EDITING',
  COMPLETED: 'COMPLETED',
} as const;

/**
 * 分包商库服务（基础信息管理 → 分包商库）
 *
 * 数据来源：通过「分包材料员授权委托书」新增并同步。
 * 状态流转：
 *  - 导出 PDF 版委托书后 → EDITING（编辑中），已填写信息推送到分包商库
 *  - 上传签字盖章版委托书 + 签字部分截图后 → COMPLETED（已完成）
 *
 * 推送关系：分包商名称 → 收领单「供应单位」；材料授权人姓名 → 收领单「领料人」；
 * 分包合同内容 → 收领单「分包合同」。
 */
@Injectable()
export class SubcontractorService {
  constructor(private prisma: PrismaClient) {}

  // ==================== 查询 ====================

  async findAll(query: any = {}, projectId?: string) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (projectId) where.projectId = projectId;
    if (query.status) where.status = query.status;
    if (query.keyword) {
      where.OR = [
        { subcontractorName: { contains: query.keyword } },
        { legalPerson: { contains: query.keyword } },
        { authorizedPerson: { contains: query.keyword } },
        { subcontractContent: { contains: query.keyword } },
      ];
    }
    const [list, total] = await Promise.all([
      this.prisma.subcontractor.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.subcontractor.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  /**
   * 收领单下拉数据源：返回 编辑中 + 已完成 的分包商（需求 2.1.4）
   * 供「供应单位 - 分包商」「领用单位 - 分包商」两个 Tab 使用
   */
  async options(query: any = {}, projectId?: string) {
    const where: any = { status: { in: [SUB_STATUS.EDITING, SUB_STATUS.COMPLETED] } };
    if (projectId) where.projectId = projectId;
    if (query.keyword) {
      where.OR = [
        { subcontractorName: { contains: query.keyword } },
        { legalPerson: { contains: query.keyword } },
        { authorizedPerson: { contains: query.keyword } },
      ];
    }
    return this.prisma.subcontractor.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  async findOne(id: string) {
    const row = await this.prisma.subcontractor.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('分包商不存在');
    return row;
  }

  // ==================== 写入 ====================

  private validate(data: any) {
    if (!String(data?.subcontractorName || '').trim()) {
      throw new BadRequestException('分包商名称不能为空');
    }
  }

  private pick(data: any) {
    const out: any = {};
    for (const f of EDITABLE_FIELDS) {
      if (data[f] !== undefined) out[f] = data[f] === '' ? null : data[f];
    }
    return out;
  }

  async create(data: any, projectId?: string, user?: any) {
    this.validate(data);
    const payload = this.pick(data);
    return this.prisma.subcontractor.create({
      data: {
        ...payload,
        projectId: projectId || null,
        status: data?.status || SUB_STATUS.EDITING,
        createdBy: user?.userId || user?.id || null,
      },
    });
  }

  async update(id: string, data: any) {
    const old = await this.findOne(id);
    assertVersion(old, data);
    if (data?.subcontractorName !== undefined) this.validate(data);
    const payload = this.pick(data);
    // 状态只能通过明确的状态流转接口变更，避免越权
    if (data?.status && [SUB_STATUS.EDITING, SUB_STATUS.COMPLETED].includes(data.status)) {
      payload.status = data.status;
    }
    return this.prisma.subcontractor.update({
      where: { id },
      data: { ...payload, version: { increment: 1 } },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.subcontractor.delete({ where: { id } });
    return true;
  }

  /**
   * 导出 PDF 版委托书后：自动保存已填写信息并推送到分包商库，状态置为「编辑中」
   * 语义：新增授权委托书 → 填写信息 → 导出 PDF 触发落库
   */
  async exportMark(payload: any, projectId?: string, user?: any) {
    this.validate(payload);
    const data = this.pick(payload);
    // 优先按 id 命中已存在记录（编辑态导出 PDF 只更新自身，不新增）
    const existing = payload?.id
      ? await this.prisma.subcontractor.findUnique({ where: { id: payload.id } })
      : await this.prisma.subcontractor.findFirst({
          // 兜底：同一分包商 + 同一材料授权人视为同一份委托书，避免重复新增
          where: {
            projectId: projectId || null,
            subcontractorName: data.subcontractorName,
            authorizedPerson: data.authorizedPerson ?? null,
          },
        });
    if (existing) {
      return this.prisma.subcontractor.update({
        where: { id: existing.id },
        data: { ...data, status: SUB_STATUS.EDITING, version: { increment: 1 } },
      });
    }
    return this.prisma.subcontractor.create({
      data: {
        ...data,
        projectId: projectId || null,
        status: SUB_STATUS.EDITING,
        createdBy: user?.userId || user?.id || null,
      },
    });
  }

  /**
   * 上传签字盖章版委托书 + 签字部分截图 → 状态置为「已完成」
   * 两个文件都到齐才允许完成（需求 2.1.3 流程）
   */
  async complete(id: string, data: any) {
    const old: any = await this.findOne(id);
    const signedAuthFile = data?.signedAuthFile ?? old.signedAuthFile;
    const signatureScreenshot = data?.signatureScreenshot ?? old.signatureScreenshot;
    if (!signedAuthFile) throw new BadRequestException('请先上传签字盖章版委托书');
    if (!signatureScreenshot) throw new BadRequestException('请先上传委托书签字部分截图');

    return this.prisma.subcontractor.update({
      where: { id },
      data: {
        ...this.pick(data),
        signedAuthFile,
        signatureScreenshot,
        status: SUB_STATUS.COMPLETED,
        version: { increment: 1 },
      },
    });
  }
}

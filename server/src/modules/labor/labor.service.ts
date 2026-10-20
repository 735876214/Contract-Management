import { checkFileUrl } from '../../common/utils/safe-url';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SUBCONTRACTOR_STATUS } from '../../constants/statuses';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, assertVersion, toDate } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';

/** 允许从前端写入的字段白名单（原分包商库字段 + 台账独有的授权期间） */
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
  'authStartDate',
  'authEndDate',
  'remark',
];

/**
 * 状态：编辑中 / 已完成（code 单一事实源在 `constants/statuses.ts`）。
 * 流转（沿用原分包商库口径）：
 *  - 导出 PDF 版委托书后 → EDITING（编辑中），信息落库
 *  - 上传签字盖章版委托书 + 签字部分截图后 → COMPLETED（已完成）
 */
export const SUB_STATUS = SUBCONTRACTOR_STATUS;

/**
 * 劳务管理 · 分包授权台账（原「分包商库」并入本表，附件需求 2026-10-17）。
 *
 * 功能 = 原分包商库的全部能力（委托书预览/导出 PDF、四类图片、关联分包合同互锁）
 * + 台账独有字段（授权期间）+ 台账格式 Excel 导出（`labor-excel.ts`，图片内嵌）。
 *
 * 消费关系：收领单「供应单位/领用单位」下拉与合同互锁读本表；成本管理 · 分包领用汇总的
 * 分包商下拉读本表；归档目录「11.分包授权台账」由本表 + 委托书扫描件组成。
 */
@Injectable()
export class LaborService {
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
      this.prisma.laborAuthLedger.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.laborAuthLedger.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  /**
   * 收领单下拉数据源：返回 编辑中 + 已完成 的分包商（需求 2.1.4）
   * 供「供应单位 - 分包商」「领用单位 - 分包商」两个 Tab 使用
   * （原分包商库 options，合并后改查台账表；字段兼容：台账即有 name/legalPerson/authorizedPerson）
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
    return this.prisma.laborAuthLedger.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }

  /** 归属复核：按 id 直读时必须确认记录属于请求头项目（防止跨项目读/改） */
  async findOne(id: string, projectId?: string) {
    const row = await this.prisma.laborAuthLedger.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('分包授权台账记录不存在');
    if (projectId && row.projectId !== projectId) throw new NotFoundException('分包授权台账记录不存在');
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
      if (data[f] !== undefined) {
        // 日期两列转 Date；其余原样（空串归 null）
        out[f] = f === 'authStartDate' || f === 'authEndDate'
          ? (data[f] ? toDate(data[f]) : null)
          : data[f] === '' ? null : data[f];
      }
    }
    return out;
  }

  async create(data: any, projectId?: string, user?: any) {
    this.validate(data);
    const payload = this.pick(data);
    return this.prisma.laborAuthLedger.create({
      data: {
        ...payload,
        projectId: projectId || null,
        /**
         * 新建一律从「编辑中」开始（2026-10-21 第 11 轮审计）：原来直接取
         * `data.status`，POST 只要带 `status: 'COMPLETED'` 就跳过编制流程。
         * 与 update() 的口径保持一致——状态只能经状态流转接口改。
         */
        status: SUB_STATUS.EDITING,
        createdBy: user?.userId || user?.id || null,
      },
    });
  }

  async update(id: string, data: any, projectId?: string) {
    const old = await this.findOne(id, projectId);
    assertVersion(old, data);
    if (data?.subcontractorName !== undefined) this.validate(data);
    const payload = this.pick(data);
    // 状态只能通过明确的状态流转接口变更，避免越权
    if (data?.status && [SUB_STATUS.EDITING, SUB_STATUS.COMPLETED].includes(data.status)) {
      payload.status = data.status;
    }
    return this.prisma.laborAuthLedger.update({
      where: { id },
      data: { ...payload, version: { increment: 1 } },
    });
  }

  async remove(id: string, projectId?: string) {
    await this.findOne(id, projectId);
    await this.prisma.laborAuthLedger.delete({ where: { id } });
    return true;
  }

  /**
   * 导出 PDF 版委托书后：自动保存已填写信息并落库，状态置为「编辑中」
   * 语义：新增授权委托书 → 填写信息 → 导出 PDF 触发落库
   * （原分包商库 exportMark，合并后改写台账表；按 id 或「同分包商 + 同授权人」去重）
   */
  async exportMark(payload: any, projectId?: string, user?: any) {
    this.validate(payload);
    const data = this.pick(payload);
    // 按 id 落库时必须做项目归属复核（同 update/remove 的口径）：否则拿到他项目的台账 id
    // 就能跨项目改名、覆盖身份证/盖章件。id 会出现在导出件、日志与分享链接里。
    const existing = payload?.id
      ? await this.findOne(payload.id, projectId)
      : await this.prisma.laborAuthLedger.findFirst({
          where: {
            projectId: projectId || null,
            subcontractorName: data.subcontractorName,
            authorizedPerson: data.authorizedPerson ?? null,
          },
        });
    if (existing) {
      return this.prisma.laborAuthLedger.update({
        where: { id: existing.id },
        data: { ...data, status: SUB_STATUS.EDITING, version: { increment: 1 } },
      });
    }
    return this.prisma.laborAuthLedger.create({
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
  async complete(id: string, data: any, projectId?: string) {
    const old: any = await this.findOne(id, projectId);
    const signedAuthFile = data?.signedAuthFile ?? old.signedAuthFile;
    const signatureScreenshot = data?.signatureScreenshot ?? old.signatureScreenshot;
    if (!signedAuthFile) throw new BadRequestException('请先上传签字盖章版委托书');
    if (!signatureScreenshot) throw new BadRequestException('请先上传委托书签字部分截图');
    // 第 8 轮审计：这两个值是前端 <a href> 直接用的，必须过协议白名单（否则可存 javascript:）
    for (const [label, value] of [['签字盖章版委托书', signedAuthFile], ['签字页截图', signatureScreenshot]] as const) {
      const check = checkFileUrl(value, label);
      if (check.error) throw new BadRequestException(check.error);
    }

    return this.prisma.laborAuthLedger.update({
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

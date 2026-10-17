import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, toDate, assertVersion } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { SubcontractorService } from '../subcontractor/subcontractor.service';

const FIELDS = [
  'projectId', 'subcontractorId', 'subcontractorName', 'legalPerson', 'authorizedPerson',
  'authStartDate', 'authEndDate', 'status', 'remark',
];

/**
 * 劳务管理 · 分包授权台账（附件需求 2026-10-17）。
 *
 * 与 `Subcontractor`（分包商档案）的关系：档案里是材料员身份证照片/签字截图（归档收集源），
 * 本表是**台账登记**（授权期间、快照字段可改）。选中分包商时自动带出名称/法人/授权人快照
 * （快照可改——台账要的是"登记当时的口径"，事后改档案不改写台账行）。
 */
@Injectable()
export class LaborService {
  constructor(
    private prisma: PrismaClient,
    private subcontractorService: SubcontractorService,
  ) {}

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.subcontractorId) where.subcontractorId = query.subcontractorId;
    if (query.status) where.status = query.status;
    if (query.keyword) {
      where.OR = [
        { subcontractorName: { contains: query.keyword } },
        { authorizedPerson: { contains: query.keyword } },
        { remark: { contains: query.keyword } },
      ];
    }
    const [rows, total] = await Promise.all([
      this.prisma.laborAuthLedger.findMany({
        where, skip, take,
        orderBy: { createdAt: 'desc' },
        include: { subcontractor: { select: { legalPerson: true, authorizedPerson: true, signedAuthFile: true, idCardFront: true, idCardBack: true, signatureScreenshot: true } } },
      }),
      this.prisma.laborAuthLedger.count({ where }),
    ]);
    return buildResult(
      rows.map((r: any) => this.serialize(r)),
      total,
      query,
    );
  }

  async findOne(id: string) {
    const r = await this.prisma.laborAuthLedger.findUnique({
      where: { id },
      include: { subcontractor: { select: { legalPerson: true, authorizedPerson: true, signedAuthFile: true, idCardFront: true, idCardBack: true, signatureScreenshot: true } } },
    });
    if (!r) throw new NotFoundException('分包授权台账记录不存在');
    return this.serialize(r);
  }

  async create(data: any, projectId: string, user: any) {
    const payload = await this.buildPayload(data, projectId);
    payload.createdBy = user?.id;
    const created = await this.prisma.laborAuthLedger.create({ data: payload });
    return this.serialize(created);
  }

  async update(id: string, data: any) {
    const current = await this.prisma.laborAuthLedger.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('分包授权台账记录不存在');
    assertVersion(current, data);
    const payload: any = pickFields(data, FIELDS.filter((f) => f !== 'projectId'), { label: '分包授权台账' });
    if (payload.authStartDate !== undefined) payload.authStartDate = toDate(payload.authStartDate);
    if (payload.authEndDate !== undefined) payload.authEndDate = toDate(payload.authEndDate);
    if (data?.subcontractorId !== undefined) {
      Object.assign(payload, await this.resolveSubcontractorSnapshot(data.subcontractorId));
    }
    payload.version = current.version + 1;
    const updated = await this.prisma.laborAuthLedger.update({ where: { id }, data: payload });
    return this.serialize(updated);
  }

  async remove(id: string) {
    await this.prisma.laborAuthLedger.delete({ where: { id } });
    return true;
  }

  /** 选中分包商 → 带出快照（名称/法人/授权人）；未选 → 名称必填（允许无档案先登记） */
  private async buildPayload(data: any, projectId: string) {
    const payload: any = pickFields(data, [...FIELDS.filter((f) => f !== 'projectId')], { label: '分包授权台账' });
    payload.projectId = projectId;
    payload.authStartDate = data?.authStartDate ? toDate(data.authStartDate) : null;
    payload.authEndDate = data?.authEndDate ? toDate(data.authEndDate) : null;
    if (data?.subcontractorId) {
      Object.assign(payload, await this.resolveSubcontractorSnapshot(data.subcontractorId));
      if (!payload.subcontractorName) throw new BadRequestException('所选分包商不存在');
    }
    if (!String(payload.subcontractorName || '').trim()) {
      throw new BadRequestException('分包商名称不能为空');
    }
    return payload;
  }

  /** 从分包商档案带快照（name 快照不允许后端覆盖已显式传入的值——台账可手改） */
  private async resolveSubcontractorSnapshot(subcontractorId: string) {
    const sc = await this.prisma.subcontractor.findUnique({ where: { id: subcontractorId } });
    if (!sc) return { subcontractorName: '' };
    return {
      subcontractorName: sc.subcontractorName,
      legalPerson: sc.legalPerson,
      authorizedPerson: sc.authorizedPerson,
    };
  }

  private serialize(r: any) {
    return {
      id: r.id,
      subcontractorId: r.subcontractorId,
      subcontractorName: r.subcontractorName,
      legalPerson: r.legalPerson ?? '',
      authorizedPerson: r.authorizedPerson ?? '',
      authStartDate: r.authStartDate?.toISOString?.() ?? null,
      authEndDate: r.authEndDate?.toISOString?.() ?? null,
      status: r.status,
      remark: r.remark ?? '',
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      // 分包商档案里的材料员照片/委托书（归档与"分包材料员授权信息表"导出用）
      subcontractor: r.subcontractor
        ? {
            legalPerson: r.subcontractor.legalPerson ?? '',
            authorizedPerson: r.subcontractor.authorizedPerson ?? '',
            signedAuthFile: r.subcontractor.signedAuthFile,
            idCardFront: r.subcontractor.idCardFront,
            idCardBack: r.subcontractor.idCardBack,
            signatureScreenshot: r.subcontractor.signatureScreenshot,
          }
        : null,
    };
  }
}

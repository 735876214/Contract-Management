import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * 引用型外键的**项目归属**校验（2026-11-12 持续审计新增）。
 *
 * 为什么需要：`JwtAuthGuard` 只校验「当前用户是请求头里那个项目的成员」，
 * **不校验请求体引用的 `contractId` / `subcontractorId` 是否属于该项目**。
 * 前端下拉是项目内数据源，但接口可被直接调用——审计中实测：项目 A 新建日报时
 * 传入项目 B 的合同 id 会成功（`projectId=A、contractId=B`），随后：
 * - A 的月度结算会按该合同生成结算单（`Settlement.projectId=A` 但挂 B 的合同）；
 * - B 的链口径（只按 `contractId` 汇总）会把 A 的结算/日报算进自己的累计值；
 * - A 的日报列表还能看到 B 的合同编号/名称（跨项目数据泄露）。
 *
 * 约定：凡是**写入**时接受引用型 id（合同 / 分包商）的 create/update 都必须过这里；
 * 「不存在」与「属于别的项目」统一报同一个 400，不泄露对方是否存在。
 */
@Injectable()
export class ProjectScopeService {
  constructor(private prisma: PrismaClient) {}

  /** 合同必须属于当前项目（`contractId` 为空时直接通过：无合同单据是合法的） */
  async assertContractInProject(
    contractId: string | null | undefined,
    projectId: string,
    label = '关联合同',
  ): Promise<void> {
    if (!contractId || !projectId) return;
    const c = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { projectId: true },
    });
    if (!c || c.projectId !== projectId) {
      throw new BadRequestException(`${label}不存在或不属于当前项目`);
    }
  }

  /** 分包商（劳务授权台账行）必须属于当前项目 */
  async assertLaborAuthInProject(
    subcontractorId: string | null | undefined,
    projectId: string,
    label = '分包商',
  ): Promise<void> {
    if (!subcontractorId || !projectId) return;
    const r = await this.prisma.laborAuthLedger.findUnique({
      where: { id: subcontractorId },
      select: { projectId: true },
    });
    if (!r || r.projectId !== projectId) {
      throw new BadRequestException(`${label}不存在或不属于当前项目`);
    }
  }
}

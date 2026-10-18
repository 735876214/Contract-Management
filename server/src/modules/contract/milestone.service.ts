import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { pickFields } from '../../common/pick-fields';
import { assertVersion, toDate } from '../../common/utils/helpers';
import { isMilestoneOverdue } from '../../common/utils/milestone';
import { MILESTONE_STATUS } from '../../constants/statuses';
import { ContractLockService } from '../../common/services/contract-lock.service';

/**
 * 合同履约节点 CRUD（四域扩展按需项 2026-10-18）。
 *
 * - 逾期是派生值（`isMilestoneOverdue`），不落库；
 * - 归档合同禁止写节点（`ContractLockService`）；
 * - 权限沿用 contract:view / contract:edit。
 */

const MILESTONE_FIELDS = ['name', 'planDate', 'actualDate', 'owner', 'statusCode', 'remark', 'createdBy'];

@Injectable()
export class MilestoneService {
  constructor(
    private prisma: PrismaClient,
    private lock: ContractLockService,
  ) {}

  private async assertContractInProject(contractId: string, projectId: string) {
    const c = await this.prisma.contract.findFirst({ where: { id: contractId, projectId }, select: { id: true } });
    if (!c) throw new NotFoundException('合同不存在');
  }

  private normalize(data: any) {
    const payload: any = pickFields(data, MILESTONE_FIELDS, { label: '履约节点' });
    if (payload.planDate !== undefined) payload.planDate = payload.planDate ? toDate(payload.planDate) : null;
    if (payload.actualDate !== undefined) payload.actualDate = payload.actualDate ? toDate(payload.actualDate) : null;
    if (payload.statusCode !== undefined && payload.statusCode !== null && payload.statusCode !== '') {
      if (!Object.values(MILESTONE_STATUS).includes(payload.statusCode)) {
        throw new BadRequestException('履约节点状态取值非法（PENDING / DONE / SKIPPED）');
      }
    } else if (payload.statusCode === '') {
      payload.statusCode = null;
    }
    return payload;
  }

  private withOverdue(rows: any[]) {
    const today = new Date();
    return rows.map((r) => ({ ...r, overdue: isMilestoneOverdue(r, today) }));
  }

  async list(contractId: string, projectId: string) {
    await this.assertContractInProject(contractId, projectId);
    const rows = await this.prisma.contractFulfillment.findMany({
      where: { contractId, projectId },
      orderBy: [{ planDate: 'asc' }, { createdAt: 'asc' }],
    });
    return this.withOverdue(rows);
  }

  async create(contractId: string, data: any, projectId: string, user: any) {
    await this.assertContractInProject(contractId, projectId);
    await this.lock.assertWritable(contractId, '新增履约节点');
    const payload = this.normalize(data);
    return this.prisma.contractFulfillment.create({
      data: { ...payload, contractId, projectId, createdBy: user?.userId ?? null },
    });
  }

  async update(contractId: string, milestoneId: string, data: any, projectId: string) {
    const before = await this.prisma.contractFulfillment.findFirst({
      where: { id: milestoneId, contractId, projectId },
    });
    if (!before) throw new NotFoundException('履约节点不存在');
    assertVersion(before, data);
    await this.lock.assertWritable(contractId, '修改履约节点');
    const payload = this.normalize(data);
    delete payload.version;
    delete payload.createdBy;
    return this.prisma.contractFulfillment.update({
      where: { id: milestoneId },
      data: { ...payload, version: { increment: 1 } },
    });
  }

  async remove(contractId: string, milestoneId: string, projectId: string) {
    const before = await this.prisma.contractFulfillment.findFirst({
      where: { id: milestoneId, contractId, projectId },
    });
    if (!before) throw new NotFoundException('履约节点不存在');
    await this.lock.assertWritable(contractId, '删除履约节点');
    await this.prisma.contractFulfillment.delete({ where: { id: milestoneId } });
    return true;
  }
}

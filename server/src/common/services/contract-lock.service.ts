import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * 合同归档锁（业务口径 2026-10-18：单向归档）。
 *
 * 归档后锁定：合同本体、收领单、结算、总结算的**写操作**；
 * **不锁**发票/付款（允许事后补录）与所有读取/导出。
 *
 * 全局 provider（`CommonModule`），下游 service 直接注入即可，避免模块循环依赖。
 */
@Injectable()
export class ContractLockService {
  constructor(private prisma: PrismaClient) {}

  /** 合同是否已归档；合同不存在返回 false（由调用方自己的存在性校验负责） */
  async isArchived(contractId: string | null | undefined): Promise<boolean> {
    if (!contractId) return false;
    const c = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { archivedAt: true },
    });
    return !!c?.archivedAt;
  }

  /** 已归档 → 400（`action` 例如「修改收领单」） */
  async assertWritable(contractId: string | null | undefined, action = '修改'): Promise<void> {
    if (await this.isArchived(contractId)) {
      throw new BadRequestException(`合同已归档，禁止${action}`);
    }
  }
}

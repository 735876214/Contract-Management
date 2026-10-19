import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '../../common/utils/helpers';
import { round2, round4 } from '../../common/utils/money';
import {
  contractChainAmount,
  contractChainIds,
  chainSettledTotal,
} from '../../common/utils/contract-chain';
import { deriveContractFulfillment } from '../../common/utils/contract-fulfillment';
import { paidPaymentWhere, SITE_CONFIRM_STATUS } from '../../constants/statuses';
import { SysParamService } from '../../common/services/sys-param.service';

/**
 * 合同履约进度（零表派生，业务口径 2026-10-18）。
 *
 * 取数口径（与台账/预警同一份真相源）：
 * - 合同当前金额 = 合同链 `contractChainAmount()`（主合同 + Σ 补充协议 changeAmount）；
 * - 已收数量 = 总日报 `settleQty` 合计（`settlement.require_confirmed` 开启时只算已确认行）；
 * - 已结算金额 = `chainSettledTotal()`（`actualAmount` 回退 `amount`，排除草稿）；
 * - 已付款 = `PaymentRecord` 合计，排除失败/退款（`paidPaymentWhere()`，空状态算有效付款）；
 * - 已开票 = `Invoice.amountWithTax` 合计（与台账「本月开票额」同口径，不排除状态）。
 *
 * ⚠️ 履约是汇总视角：**没有任何回写**，也不复制结算/付款/收货单据。
 */
@Injectable()
export class ContractFulfillmentService {
  constructor(
    private prisma: PrismaClient,
    private sysParam: SysParamService,
  ) {}

  private async requireConfirmed(): Promise<boolean> {
    const v = await this.sysParam.get('settlement.require_confirmed', 'true');
    return String(v).toLowerCase() !== 'false';
  }

  async get(contractId: string, projectId: string) {
    const contract = await this.prisma.contract.findFirst({
      where: { id: contractId, projectId },
      select: { id: true },
    });
    if (!contract) throw new NotFoundException('合同不存在');

    // 链成员（主合同 + 直接补充协议）：数量/结算/付款/发票都按同一条链归集
    const chainIds = await contractChainIds(this.prisma, contractId);

    const gated = await this.requireConfirmed();
    const [currentAmount, orderedRows, dailySum, settledAmount, paymentSum, invoiceSum] = await Promise.all([
      contractChainAmount(this.prisma, contractId),
      this.prisma.contractMaterial.findMany({
        where: { contractId: { in: chainIds } },
        select: { qty: true },
      }),
      this.prisma.dailyReport.aggregate({
        where: {
          projectId,
          contractId: { in: chainIds },
          ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}),
        },
        _sum: { settleQty: true },
      }),
      chainSettledTotal(this.prisma, contractId),
      this.prisma.paymentRecord.aggregate({
        where: { projectId, contractId: { in: chainIds }, ...paidPaymentWhere() },
        _sum: { amount: true },
      }),
      this.prisma.invoice.aggregate({
        where: { projectId, contractId: { in: chainIds } },
        _sum: { amountWithTax: true },
      }),
    ]);

    // 清单量三态：没有清单行 → 未知；任一行数量未填 → 未知（不把未知当 0）
    const orderedQty =
      !orderedRows.length || orderedRows.some((r) => num(r.qty) == null)
        ? null
        : round4(orderedRows.reduce((s, r) => s + (num(r.qty) as number), 0));
    const receivedQty = round4(num(dailySum._sum.settleQty) ?? 0);
    const paidAmount = round2(num(paymentSum._sum.amount) ?? 0);
    const invoicedAmount = round2(num(invoiceSum._sum.amountWithTax) ?? 0);

    return {
      contractId,
      chainIds,
      currentAmount,
      orderedQty,
      receivedQty,
      settledAmount,
      paidAmount,
      invoicedAmount,
      ...deriveContractFulfillment({
        currentAmount,
        orderedQty,
        receivedQty,
        settledAmount,
        paidAmount,
        invoicedAmount,
      }),
    };
  }
}

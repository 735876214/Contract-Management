import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '../../common/utils/helpers';
import { resolveChainAmounts } from '../../common/utils/contract-chain';
import { evaluateAmountAlert } from '../../common/utils/amount-alert';
import { PAYMENT_EXCLUDED_STATUSES } from '../../constants/statuses';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaClient) {}

  async overview(projectId: string, user: any) {
    const [contracts, ledger, payments, invoices, settlements] = await Promise.all([
      this.prisma.contract.findMany({ where: { projectId } }),
      this.prisma.settlementLedger.findMany({ where: { projectId } }),
      // 只统计**构成实际出资**的付款（排除付款失败/已退款）——与防超付闸门、合同台账同一份清单，
      // 否则工作台的「累计付款额」会大于台账的同一口径数字（业务口径 2026-10-16）
      this.prisma.paymentRecord.findMany({
        where: { projectId, NOT: { statusCode: { in: PAYMENT_EXCLUDED_STATUSES } } },
      }),
      this.prisma.invoice.findMany({ where: { projectId } }),
      this.prisma.settlement.findMany({ where: { projectId } }),
    ]);
    const sumBy = (list: any[], f: string) => list.reduce((s, i: any) => s + (num(i[f]) || 0), 0);
    return {
      contractCount: contracts.length,
      contractAmount: Number(sumBy(contracts, 'amount').toFixed(2)),
      settleAmount: Number(sumBy(ledger, 'monthSettleAmount').toFixed(2)),
      paidAmount: Number(sumBy(payments, 'amount').toFixed(2)),
      invoiceAmount: Number(sumBy(invoices, 'amountWithTax').toFixed(2)),
      settlementCount: settlements.length,
      executingCount: contracts.filter((c: any) => c.execStatus === 'EXECUTING').length,
    };
  }

  /** 近 12 个月收付款与结算趋势 */
  async trend(projectId: string) {
    const [ledger, payments] = await Promise.all([
      this.prisma.settlementLedger.findMany({ where: { projectId } }),
      // 只统计**构成实际出资**的付款（排除付款失败/已退款）——与防超付闸门、合同台账同一份清单，
      // 否则工作台的「累计付款额」会大于台账的同一口径数字（业务口径 2026-10-16）
      this.prisma.paymentRecord.findMany({
        where: { projectId, NOT: { statusCode: { in: PAYMENT_EXCLUDED_STATUSES } } },
      }),
    ]);
    const months: string[] = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const settleMap: Record<string, number> = {};
    ledger.forEach((l: any) => {
      if (l.settleMonth) settleMap[l.settleMonth] = (settleMap[l.settleMonth] || 0) + (num(l.monthSettleAmount) || 0);
    });
    const payMap: Record<string, number> = {};
    payments.forEach((p: any) => {
      if (p.payMonth) payMap[p.payMonth] = (payMap[p.payMonth] || 0) + (num(p.amount) || 0);
    });
    return months.map((m) => ({
      month: m,
      settleAmount: Number((settleMap[m] || 0).toFixed(2)),
      paidAmount: Number((payMap[m] || 0).toFixed(2)),
    }));
  }

  async contractType(projectId: string) {
    const contracts = await this.prisma.contract.groupBy({ by: ['typeCode'], where: { projectId }, _count: { _all: true }, _sum: { amount: true } });
    return contracts.map((c: any) => ({
      typeCode: c.typeCode,
      count: c._count._all,
      amount: Number((num(c._sum.amount) || 0).toFixed(2)),
    }));
  }

  async invoiceStats(projectId: string) {
    const [byType, byStatus] = await Promise.all([
      this.prisma.invoice.groupBy({ by: ['typeCode'], where: { projectId }, _count: { _all: true }, _sum: { amountWithTax: true } }),
      this.prisma.invoice.groupBy({ by: ['statusCode'], where: { projectId }, _count: { _all: true } }),
    ]);
    return {
      byType: byType.map((i: any) => ({ typeCode: i.typeCode, count: i._count._all, amount: Number((num(i._sum.amountWithTax) || 0).toFixed(2)) })),
      byStatus: byStatus.map((i: any) => ({ statusCode: i.statusCode, count: i._count._all })),
    };
  }

  /** 提醒：发票待查验 + 合同金额红/黄预警 */
  async reminders(projectId: string, user: any) {
    const [pendingInvoices, amountAlerts] = await Promise.all([
      this.prisma.invoice.findMany({ where: { projectId, statusCode: 'WAIT_VERIFY' }, take: 10 }),
      this.amountAlerts(projectId),
    ]);
    return { pendingInvoices, ...amountAlerts };
  }

  /**
   * 合同金额预警（业务口径 2026-10-15 澄清，阈值见 `common/utils/amount-alert.ts`）：
   * - 🔴 当前结算额 > 合同当前金额 × 110% 或 补充协议累计 > 主合同 × 130%
   * - 🟡 当前结算额 > 合同当前金额 × 80% 或 补充协议累计 > 主合同 × 110%
   *
   * 「合同当前金额」= 主合同 + Σ 补充协议带符号增量（与防超结上限同一实现）。
   * 只做**展示**：不拦截任何单据，也不改 `*_over_amount_policy` 的策略。
   *
   * 口径细节：按**链根**逐条算，一次取全项目合同与结算后在内存分组（避免 N+1）；
   * 结算额排除草稿（与闸门一致）。主合同金额未填（金额未知）时该项无法判定 → 不报（宁漏勿误）。
   */
  private async amountAlerts(projectId: string) {
    const [contracts, settlements] = await Promise.all([
      this.prisma.contract.findMany({
        where: { projectId },
        select: { id: true, parentContractId: true, amount: true, changeAmount: true, code: true, name: true },
      }),
      this.prisma.settlement.findMany({
        where: { projectId, NOT: { statusCode: 'DRAFT' } },
        select: { contractId: true, actualAmount: true, amount: true },
      }),
    ]);

    const settledByContract = new Map<string, number>();
    for (const s of settlements) {
      const key = String(s.contractId ?? '');
      if (!key) continue;
      const v = Number(s.actualAmount ?? s.amount) || 0;
      settledByContract.set(key, (settledByContract.get(key) ?? 0) + v);
    }

    const alerts: {
      contractId: string;
      code: string;
      name: string;
      level: string;
      reasons: string[];
      settledRatioPct: number | null;
      supplementRatioPct: number | null;
      currentAmount: number | null;
      settledTotal: number;
    }[] = [];

    // 只对链根出预警：补充协议单独出现没有意义（它的"当前金额"就是主合同的）
    for (const c of contracts.filter((x) => !x.parentContractId)) {
      const chain = resolveChainAmounts(contracts as any, c.id);
      const settledTotal = chain.chainIds.reduce((s, id) => s + (settledByContract.get(id) ?? 0), 0);
      const r = evaluateAmountAlert({
        mainAmount: chain.mainAmount,
        supplementTotal: chain.supplementTotal,
        currentAmount: chain.currentAmount,
        settledTotal,
      });
      if (!r.level) continue;
      alerts.push({
        contractId: c.id,
        code: c.code,
        name: c.name,
        level: r.level,
        reasons: r.reasons,
        settledRatioPct: r.settledRatioPct,
        supplementRatioPct: r.supplementRatioPct,
        currentAmount: chain.currentAmount,
        settledTotal: Number(settledTotal.toFixed(2)),
      });
    }

    // 红在前；同级按结算比例从高到低（比例未知的排最后）
    const rank = (a: (typeof alerts)[number]) => (a.level === 'RED' ? 0 : 1);
    alerts.sort(
      (a, b) => rank(a) - rank(b) || (b.settledRatioPct ?? -1) - (a.settledRatioPct ?? -1),
    );

    return {
      /** 预警明细（前端可只展示前 N 条，`total` 用于说明"还有多少条"） */
      amountAlerts: alerts.slice(0, 20),
      amountAlertTotal: alerts.length,
    };
  }
}

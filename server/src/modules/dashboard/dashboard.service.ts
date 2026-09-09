import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '../../common/utils/helpers';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaClient) {}

  async overview(projectId: string, user: any) {
    const [contracts, ledger, payments, invoices, settlements] = await Promise.all([
      this.prisma.contract.findMany({ where: { projectId } }),
      this.prisma.settlementLedger.findMany({ where: { projectId } }),
      this.prisma.paymentRecord.findMany({ where: { projectId } }),
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
      this.prisma.paymentRecord.findMany({ where: { projectId } }),
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

  /** 提醒：发票待查验 */
  async reminders(projectId: string, user: any) {
    const pendingInvoices = await this.prisma.invoice.findMany({ where: { projectId, statusCode: 'WAIT_VERIFY' }, take: 10 });
    return { pendingInvoices };
  }
}

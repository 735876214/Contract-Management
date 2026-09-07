import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';

@Injectable()
export class PaymentService {
  constructor(private prisma: PrismaClient, private dict: DictService, private excel: ExcelService) {}

  private contractInclude = {
    contract: { select: { id: true, code: true, name: true, supplier: { select: { id: true, name: true, bankName: true, bankAccount: true } } } },
  };

  // ---------------- 付款计划 ----------------
  async findPlans(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.statusCode) where.statusCode = query.statusCode;
    const [list, total] = await Promise.all([
      this.prisma.paymentPlan.findMany({ where, skip, take, orderBy: [{ planDate: 'asc' }], include: this.contractInclude }),
      this.prisma.paymentPlan.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async createPlan(data: any, projectId: string) {
    await this.dict.validate('payment_plan_status', data.statusCode);
    return this.prisma.paymentPlan.create({
      data: { ...data, projectId, planAmount: num(data.planAmount), planDate: toDate(data.planDate), period: Number(data.period) || null },
    });
  }

  async updatePlan(id: string, data: any) {
    await this.dict.validate('payment_plan_status', data.statusCode);
    const payload: any = { ...data };
    if (payload.planAmount !== undefined) payload.planAmount = num(payload.planAmount);
    if (payload.planDate) payload.planDate = toDate(payload.planDate);
    if (payload.period !== undefined) payload.period = Number(payload.period) || null;
    return this.prisma.paymentPlan.update({ where: { id }, data: payload });
  }

  async removePlan(id: string) {
    await this.prisma.paymentPlan.delete({ where: { id } });
    return true;
  }

  /** 根据合同自动生成付款计划（按付款比例拆分 3 期示例：预付/进度/尾款） */
  async generatePlans(contractId: string, projectId: string, payload: any = {}) {
    const contract = await this.prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) throw new NotFoundException('合同不存在');
    const amount = num(contract.amount) || 0;
    const ratios: number[] = payload.ratios || [0.3, 0.6, 0.1];
    const months: number[] = payload.months || [1, 6, 12];
    const base = contract.signDate || new Date();
    const data = ratios.map((r, i) => ({
      projectId,
      contractId,
      period: i + 1,
      planAmount: Number((amount * r).toFixed(2)),
      planDate: new Date(base.getTime() + months[i] * 30 * 24 * 3600 * 1000),
      condition: `第 ${i + 1} 期`,
      statusCode: 'WAIT',
    }));
    await this.prisma.paymentPlan.createMany({ data });
    return { created: data.length };
  }

  // ---------------- 付款申请 ----------------
  async findApplies(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { payee: { contains: query.keyword } }];
    const [list, total] = await Promise.all([
      this.prisma.paymentApply.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: this.contractInclude }),
      this.prisma.paymentApply.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async createApply(data: any, projectId: string) {
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('approval_status', data.statusCode);
    // 收款方与银行信息通过合同关联供应商库自动带出
    let payee = data.payee;
    let bankName = data.bankName;
    let bankAccount = data.bankAccount;
    if (data.contractId && !payee) {
      const c = await this.prisma.contract.findUnique({ where: { id: data.contractId }, include: { supplier: true } });
      payee = (c as any)?.supplier?.name;
      bankName = bankName || (c as any)?.supplier?.bankName;
      bankAccount = bankAccount || (c as any)?.supplier?.bankAccount;
    }
    return this.prisma.paymentApply.create({
      data: {
        ...data, projectId, payee, bankName, bankAccount,
        applyAmount: num(data.applyAmount), payDate: toDate(data.payDate),
      },
    });
  }

  async updateApply(id: string, data: any) {
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('approval_status', data.statusCode);
    const payload: any = { ...data };
    if (payload.applyAmount !== undefined) payload.applyAmount = num(payload.applyAmount);
    if (payload.payDate) payload.payDate = toDate(payload.payDate);
    return this.prisma.paymentApply.update({ where: { id }, data: payload });
  }

  async approveApply(id: string, action: string, comment: string, user: any) {
    if (!['APPROVED', 'REJECTED'].includes(action)) throw new BadRequestException('审批动作不合法');
    const apply = await this.prisma.paymentApply.findUnique({ where: { id } });
    if (!apply) throw new NotFoundException('付款申请不存在');
    return this.prisma.paymentApply.update({ where: { id }, data: { statusCode: action } });
  }

  async removeApply(id: string) {
    await this.prisma.paymentApply.delete({ where: { id } });
    return true;
  }

  // ---------------- 付款执行 / 付款台账 ----------------
  async findRecords(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.payMonth) where.payMonth = query.payMonth;
    if (query.statusCode) where.statusCode = query.statusCode;
    const [list, total] = await Promise.all([
      this.prisma.paymentRecord.findMany({ where, skip, take, orderBy: [{ payMonth: 'desc' }, { createdAt: 'desc' }], include: this.contractInclude }),
      this.prisma.paymentRecord.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async createRecord(data: any, projectId: string) {
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    return this.prisma.paymentRecord.create({
      data: { ...data, projectId, amount: num(data.amount), payDate: toDate(data.payDate) },
    });
  }

  async updateRecord(id: string, data: any) {
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    const payload: any = { ...data };
    if (payload.amount !== undefined) payload.amount = num(payload.amount);
    if (payload.payDate) payload.payDate = toDate(payload.payDate);
    return this.prisma.paymentRecord.update({ where: { id }, data: payload });
  }

  async removeRecord(id: string) {
    await this.prisma.paymentRecord.delete({ where: { id } });
    return true;
  }

  async exportRecords(projectId: string) {
    const res = await this.findRecords({ pageSize: 2000 }, projectId);
    const columns = [
      { header: '供应商名称', key: 'supplierName', width: 28 },
      { header: '合同名称', key: 'contractName', width: 30 },
      { header: '合同编号', key: 'contractCode', width: 20 },
      { header: '付款月份', key: 'payMonth', width: 12 },
      { header: '本月付款额', key: 'amount', width: 16 },
    ];
    const rows = (res.list as any[]).map((r) => ({
      supplierName: r.contract?.supplier?.name, contractName: r.contract?.name,
      contractCode: r.contract?.code, payMonth: r.payMonth, amount: num(r.amount),
    }));
    return this.excel.export(columns, rows, '付款台账');
  }

  // ---------------- 核销 & 逾期 ----------------
  /** 核销：付款 vs 发票 / 结算，展示未核销金额 */
  async verifications(projectId: string) {
    const [contracts, records, invoices, ledger] = await Promise.all([
      this.prisma.contract.findMany({ where: { projectId }, include: { supplier: { select: { id: true, name: true } } } }),
      this.prisma.paymentRecord.findMany({ where: { projectId } }),
      this.prisma.invoice.findMany({ where: { projectId } }),
      this.prisma.settlementLedger.findMany({ where: { projectId } }),
    ]);
    return contracts.map((c: any) => {
      const settleAmount = ledger.filter((l: any) => l.contractId === c.id).reduce((s, l: any) => s + (num(l.monthSettleAmount) || 0), 0);
      const invoiceAmount = invoices.filter((i: any) => i.contractId === c.id).reduce((s, i: any) => s + (num(i.amountWithTax) || 0), 0);
      const paidAmount = records.filter((r: any) => r.contractId === c.id).reduce((s, r: any) => s + (num(r.amount) || 0), 0);
      return {
        contractId: c.id,
        contractCode: c.code,
        contractName: c.name,
        supplierName: c.supplier?.name,
        settleAmount,
        invoiceAmount,
        paidAmount,
        unpaidSettlement: settleAmount - paidAmount,
        unpaidInvoice: invoiceAmount - paidAmount,
      };
    });
  }

  /** 逾期提醒：应付未付 */
  async overdue(projectId: string) {
    const today = new Date();
    const plans = await this.prisma.paymentPlan.findMany({
      where: { projectId, statusCode: { not: 'PAID' } },
      include: { contract: { select: { id: true, code: true, name: true, supplier: { select: { name: true } } } } },
    });
    return plans
      .filter((p: any) => p.planDate && new Date(p.planDate) < today)
      .map((p: any) => ({
        id: p.id,
        contractCode: p.contract?.code,
        contractName: p.contract?.name,
        supplierName: p.contract?.supplier?.name,
        period: p.period,
        planAmount: num(p.planAmount),
        planDate: p.planDate,
        overdueDays: Math.floor((today.getTime() - new Date(p.planDate).getTime()) / 86400000),
        statusCode: p.statusCode,
      }));
  }
}

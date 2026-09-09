import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertImportRows } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';

const PLAN_FIELDS = [
  'projectId', 'contractId', 'period', 'planAmount', 'planDate', 'condition', 'statusCode', 'remark',
];
const APPLY_FIELDS = [
  'projectId', 'contractId', 'settlementId', 'invoiceId', 'code', 'applyAmount', 'payee',
  'bankName', 'bankAccount', 'payDate', 'methodCode', 'statusCode', 'remark', 'createdBy',
];
const RECORD_FIELDS = [
  'projectId', 'contractId', 'applyId', 'payMonth', 'amount', 'methodCode', 'payDate',
  'receiptUrl', 'statusCode', 'remark',
];

@Injectable()
export class PaymentService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private styled: StyledExcelService,
    private tpl: ImportTemplateService,
  ) {}

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
      data: { ...pickFields(data, PLAN_FIELDS, { label: '付款计划' }), projectId, planAmount: num(data.planAmount), planDate: toDate(data.planDate), period: Number(data.period) || null },
    });
  }

  async updatePlan(id: string, data: any) {
    await this.dict.validate('payment_plan_status', data.statusCode);
    const payload: any = pickFields(data, PLAN_FIELDS, { label: '付款计划' });
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
        ...pickFields(data, APPLY_FIELDS, { label: '付款申请' }), projectId, payee, bankName, bankAccount,
        applyAmount: num(data.applyAmount), payDate: toDate(data.payDate),
      },
    });
  }

  async updateApply(id: string, data: any) {
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('approval_status', data.statusCode);
    const payload: any = pickFields(data, APPLY_FIELDS, { label: '付款申请' });
    if (payload.applyAmount !== undefined) payload.applyAmount = num(payload.applyAmount);
    if (payload.payDate) payload.payDate = toDate(payload.payDate);
    return this.prisma.paymentApply.update({ where: { id }, data: payload });
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
      data: { ...pickFields(data, RECORD_FIELDS, { label: '付款记录' }), projectId, amount: num(data.amount), payDate: toDate(data.payDate) },
    });
  }

  async updateRecord(id: string, data: any) {
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    const payload: any = pickFields(data, RECORD_FIELDS, { label: '付款记录' });
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
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    const rows = (res.list as any[]).map((r) => ({
      projectName: project?.name || '',
      supplierName: r.contract?.supplier?.name, contractName: r.contract?.name,
      contractCode: r.contract?.code, payMonth: r.payMonth, amount: num(r.amount),
    }));
    return this.styled.exportTable({
      sheetName: '付款台账',
      title: `付款台账（${project?.name || ''}）`,
      columns: [
        { header: '项目', key: 'projectName', width: 140, type: 'center' },
        { header: '供应商名称', key: 'supplierName', width: 180 },
        { header: '合同名称', key: 'contractName', width: 200 },
        { header: '合同编号', key: 'contractCode', width: 180 },
        { header: '付款月份', key: 'payMonth', width: 100, type: 'center' },
        { header: '本月付款额', key: 'amount', width: 140, type: 'money' },
      ],
      rows,
      totalsKeys: ['amount'],
      totalsLabel: '汇总',
    });
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

  /** 付款台账填写模板（需求 3.3，实际字段口径） */
  async templateRecords(projectId: string) {
    const [methods, status] = await Promise.all([
      this.dict.options('payment_method'), this.dict.options('payment_status'),
    ]);
    const columns: TemplateColumn[] = [
      { label: '合同编号', key: 'contractCode', required: true, width: 20, example: 'HT-2026-0001', desc: '须为合同台账中已存在的合同编号' },
      { label: '付款月份', key: 'payMonth', required: true, type: 'text', width: 14, example: '2026-09', desc: '格式 YYYY-MM' },
      { label: '付款金额', key: 'amount', required: true, type: 'money', width: 16, example: 1234567.89 },
      { label: '付款方式', key: 'methodCode', type: 'select', width: 14, example: '银行转账', options: methods.map((i: any) => i.itemName).filter(Boolean) },
      { label: '付款日期', key: 'payDate', type: 'date', width: 14, example: '2026-09-15' },
      { label: '状态', key: 'statusCode', type: 'select', width: 12, example: '已付款', options: status.map((i: any) => i.itemName).filter(Boolean) },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '付款台账', sheetName: '数据', columns });
  }

  /** 付款台账上传导入（需求 3.4）：新增不覆盖，逐行校验并输出错误报告 */
  async importRecords(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    assertImportRows(rows);
    const methods = await this.dict.options('payment_method');
    const status = await this.dict.options('payment_status');
    const codeOf = (items: any[], val: any) =>
      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      const rowNo = index + 3;
      try {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new Error('合同编号为必填项（关联校验）');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new Error(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`);
        const payMonth = String(r['付款月份'] ?? '').trim();
        if (!/^\d{4}-\d{2}$/.test(payMonth)) throw new Error('付款月份为必填项，格式 YYYY-MM（如 2026-09）');
        const amount = num(r['付款金额']);
        if (amount === null) throw new Error('付款金额为必填数字');
        const methodName = String(r['付款方式'] ?? '').trim();
        if (methodName && codeOf(methods, methodName) === null) {
          throw new Error(`下拉校验失败：「${methodName}」不在付款方式选项范围内`);
        }
        const statusName = String(r['状态'] ?? '').trim();
        if (statusName && codeOf(status, statusName) === null) {
          throw new Error(`下拉校验失败：「${statusName}」不在状态选项范围内`);
        }
        await this.createRecord(
          {
            contractId: contract.id,
            payMonth,
            amount,
            methodCode: codeOf(methods, methodName),
            payDate: r['付款日期'] || null,
            statusCode: codeOf(status, statusName),
            remark: String(r['备注'] ?? '').trim() || null,
          },
          projectId,
        );
        created++;
      } catch (e: any) {
        errors.push(`第 ${rowNo} 行：${e.message}`);
      }
    }
    return { created, errors };
  }
}

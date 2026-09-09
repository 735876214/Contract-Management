import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { num } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { SysParamService } from '../../common/services/sys-param.service';
import {
  recalculate,
  round,
  modeTranches,
  payableDateOf,
  OverdueRowInput,
} from './overdue-calculator';

const FACTORING_FIELDS = [
  'contractId', 'seqNo', 'financingDate', 'financingAmount', 'actualReceipt',
  'financingInterest', 'handlingFee', 'settlementMonth', 'remark',
];
const OVERDUE_FIELDS = [
  'contractId', 'settlementMonth', 'materialAmount', 'paymentRatio', 'payableDate',
  'paymentDate', 'paymentAmount', 'waived', 'prevCumulative', 'remark',
  'isSettlementPeriod', 'periodSeq',
];

const fmt = (v: any) => {
  if (v === null || v === undefined || v === '') return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

@Injectable()
export class FinanceService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private sysParam: SysParamService,
  ) {}

  // ==================== 合同资金参数 ====================

  /** 合同参数（付款模式/月利率/宽限期/上限比例），合同未设置时回落到系统参数默认值 */
  async contractParams(contractId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { name: true } }, project: { select: { name: true, codeAbbr: true } } },
    });
    if (!contract) throw new NotFoundException('合同不存在');
    const [defRate, defGrace, defCap, mode100, mode3382] = await Promise.all([
      this.sysParam.get('finance.overdue.default_monthly_rate', '0.006'),
      this.sysParam.get('finance.overdue.default_grace_days', '7'),
      this.sysParam.get('finance.overdue.interest_cap_ratio', '0.05'),
      this.sysParam.get('finance.payment.mode_100_description'),
      this.sysParam.get('finance.payment.mode_3382_description'),
    ]);
    return {
      contractId,
      contractCode: contract.code,
      contractName: contract.name,
      supplierName: contract.supplier?.name || '',
      projectName: contract.project?.name || '',
      paymentMode: contract.paymentMode || '100',
      monthlyRate: num(contract.monthlyRate) ?? (Number(defRate) || 0.006),
      graceDays: contract.graceDays ?? (Number(defGrace) || 7),
      interestCapRatio: num(contract.interestCapRatio) ?? (Number(defCap) || 0.05),
      mode100Description: mode100,
      mode3382Description: mode3382,
      overrides: {
        monthlyRate: num(contract.monthlyRate),
        graceDays: contract.graceDays,
        interestCapRatio: num(contract.interestCapRatio),
        paymentMode: contract.paymentMode,
      },
    };
  }

  async updateContractParams(contractId: string, data: any) {
    const contract = await this.prisma.contract.findUnique({ where: { id: contractId } });
    if (!contract) throw new NotFoundException('合同不存在');
    const payload: any = {};
    if (data.paymentMode !== undefined) payload.paymentMode = data.paymentMode || null;
    if (data.monthlyRate !== undefined) payload.monthlyRate = data.monthlyRate === null || data.monthlyRate === '' ? null : Number(data.monthlyRate);
    if (data.graceDays !== undefined) payload.graceDays = data.graceDays === null || data.graceDays === '' ? null : Number(data.graceDays);
    if (data.interestCapRatio !== undefined) payload.interestCapRatio = data.interestCapRatio === null || data.interestCapRatio === '' ? null : Number(data.interestCapRatio);
    await this.prisma.contract.update({ where: { id: contractId }, data: payload });
    return this.contractParams(contractId);
  }

  /** 按付款模式为某结算月份生成应付款行（3382 生成 2 行：80% + 20%） */
  async generateOverdueRows(contractId: string, settlementMonth: string, materialAmount: number) {
    const params = await this.contractParams(contractId);
    const tranches = modeTranches(params.paymentMode);
    if (!tranches) throw new BadRequestException('自定义付款模式请手动录入应付款行');
    const exist = await this.prisma.overdueInterest.count({ where: { contractId, settlementMonth, materialAmount: { gt: 0 } } });
    if (exist > 0) throw new BadRequestException(`${settlementMonth} 已存在材料款行，请直接编辑或先删除`);
    const maxSeq = await this.prisma.overdueInterest.aggregate({ where: { contractId, settlementMonth }, _max: { periodSeq: true } });
    let seq = (maxSeq._max.periodSeq || 0);
    const created = [];
    for (const t of tranches.tranches) {
      seq += 1;
      const payableDate = payableDateOf(settlementMonth, t.plusMonths, t.day);
      created.push(
        await this.prisma.overdueInterest.create({
          data: {
            contractId,
            settlementMonth,
            materialAmount: round(materialAmount * t.ratio, 2),
            paymentRatio: t.ratio,
            payableDate,
            isSettlementPeriod: true,
            periodSeq: seq,
          },
        }),
      );
    }
    await this.recalcOverdue(contractId);
    return created;
  }

  // ==================== 保理费用台账 ====================

  private async contractScope(contractId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { name: true } } },
    });
    if (!contract) throw new NotFoundException('合同不存在');
    return contract;
  }

  async listFactoring(contractId: string) {
    const contract = await this.contractScope(contractId);
    const list = await this.prisma.factoringCost.findMany({
      where: { contractId },
      orderBy: [{ seqNo: 'asc' }, { createdAt: 'asc' }],
    });
    const rows = list.map((r: any) => ({
      ...r,
      supplierName: contract.supplier?.name || '',
    }));
    const totals = {
      financingAmount: round(rows.reduce((a: number, r: any) => a + (num(r.financingAmount) || 0), 0), 2),
      actualReceipt: round(rows.reduce((a: number, r: any) => a + (num(r.actualReceipt) || 0), 0), 2),
      financingInterest: round(rows.reduce((a: number, r: any) => a + (num(r.financingInterest) || 0), 0), 2),
      handlingFee: round(rows.reduce((a: number, r: any) => a + (num(r.handlingFee) || 0), 0), 2),
      totalCost: round(rows.reduce((a: number, r: any) => a + (num(r.totalCost) || 0), 0), 2),
    };
    return { contract: { id: contract.id, code: contract.code, name: contract.name, supplierName: contract.supplier?.name || '' }, list: rows, totals };
  }

  private factoringPayload(data: any, keep?: any) {
    const payload = pickFields(data, FACTORING_FIELDS.filter((f) => f !== 'contractId'), { label: '保理费用' });
    if (!keep && !payload.contractId) throw new BadRequestException('缺少合同ID');
    // 费用合计（含税）= 融资利息 + 手续费，服务端自动计算
    const interest = num(payload.financingInterest ?? keep?.financingInterest) || 0;
    const fee = num(payload.handlingFee ?? keep?.handlingFee) || 0;
    if (payload.financingInterest !== undefined || payload.handlingFee !== undefined || keep) {
      payload.totalCost = round(interest + fee, 2);
    }
    for (const k of ['financingAmount', 'actualReceipt', 'financingInterest', 'handlingFee']) {
      if (payload[k] !== undefined) payload[k] = payload[k] === null || payload[k] === '' ? null : Number(payload[k]);
    }
    // 前端传 YYYY-MM-DD 字符串，Prisma 需要完整 DateTime
    if (payload.financingDate !== undefined) {
      const d = payload.financingDate ? new Date(payload.financingDate) : null;
      payload.financingDate = d && !isNaN(d.getTime()) ? d : null;
    }
    return payload;
  }

  async createFactoring(data: any) {
    const payload = this.factoringPayload(data);
    const max = await this.prisma.factoringCost.aggregate({ where: { contractId: payload.contractId }, _max: { seqNo: true } });
    if (payload.seqNo === undefined) payload.seqNo = (max._max.seqNo || 0) + 1;
    return this.prisma.factoringCost.create({ data: payload });
  }

  async updateFactoring(id: string, data: any) {
    const old = await this.prisma.factoringCost.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('保理费用记录不存在');
    const payload = this.factoringPayload(data, old);
    return this.prisma.factoringCost.update({ where: { id }, data: payload });
  }

  async removeFactoring(id: string) {
    const old = await this.prisma.factoringCost.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('保理费用记录不存在');
    await this.prisma.factoringCost.delete({ where: { id } });
    return true;
  }

  async exportFactoring(contractId: string) {
    const { contract, list, totals } = { ...(await this.contractScope(contractId)), ...(await this.listFactoring(contractId)) } as any;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('保理费用台账');
    const n = list.length + 3;
    ws.mergeCells(1, 1, 1, 9);
    ws.getCell(1, 1).value = `保理费用台账（${contract.supplier?.name || ''}）`;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.getCell(1, 1).alignment = { horizontal: 'center' };
    ws.getCell(2, 1).value = `合同编号：${contract.code}　合同名称：${contract.name}`;
    const headers = ['序号', '融资到账时间', '融资金额', '实际到账金额', '融资利息', '手续费', '费用合计（含税）', '结算月份', '备注'];
    ws.getRow(3).values = headers;
    ws.getRow(3).font = { bold: true };
    list.forEach((r: any, i: number) => {
      ws.getRow(4 + i).values = [r.seqNo, fmt(r.financingDate), num(r.financingAmount), num(r.actualReceipt), num(r.financingInterest), num(r.handlingFee), num(r.totalCost), r.settlementMonth, r.remark || ''];
    });
    ws.getRow(n + 1).values = ['合计', '', totals.financingAmount, totals.actualReceipt, totals.financingInterest, totals.handlingFee, totals.totalCost, '', ''];
    ws.getRow(n + 1).font = { bold: true };
    ws.columns = [{ width: 6 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 10 }, { width: 16 }, { width: 12 }, { width: 24 }];
    const buf = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buf), filename: `保理费用台账-${contract.code}.xlsx` };
  }

  // ==================== 逾期利息台账 ====================

  /** 重算并持久化整个合同的逾期利息台账（任何增删改后调用） */
  private async recalcOverdue(contractId: string) {
    const params = await this.contractParams(contractId);
    const rows = await this.prisma.overdueInterest.findMany({
      where: { contractId },
      orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
    });
    const input: OverdueRowInput[] = rows.map((r: any) => ({
      id: r.id,
      settlementMonth: r.settlementMonth,
      materialAmount: num(r.materialAmount),
      paymentRatio: num(r.paymentRatio),
      payableDate: r.payableDate,
      paymentDate: r.paymentDate,
      paymentAmount: num(r.paymentAmount),
      waived: r.waived,
      prevCumulative: num(r.prevCumulative),
      remark: r.remark,
      isSettlementPeriod: r.isSettlementPeriod,
      periodSeq: r.periodSeq,
    }));
    const { derived, stats } = recalculate(input, { monthlyRate: params.monthlyRate, graceDays: params.graceDays });
    // 持久化派生字段（顺序与查询一致）
    const ordered = await this.prisma.overdueInterest.findMany({
      where: { contractId },
      orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    for (let i = 0; i < ordered.length; i++) {
      const d = derived.get(i);
      if (!d) continue;
      await this.prisma.overdueInterest.update({
        where: { id: ordered[i].id },
        data: {
          monthlyRate: params.monthlyRate,
          payableAmount: d.payableAmount ?? undefined,
          overdueStartDate: d.overdueStartDate || undefined,
          interestAmount: d.interestAmount ?? undefined,
          overdueDays: d.overdueDays ?? undefined,
          overdueInterest: d.overdueInterest ?? undefined,
        },
      });
    }
    return stats;
  }

  async listOverdue(contractId: string, query: any = {}) {
    const params = await this.contractParams(contractId);
    const where: any = { contractId };
    if (query.settlementMonth) where.settlementMonth = query.settlementMonth;
    const rows = await this.prisma.overdueInterest.findMany({
      where,
      orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
    });
    const supplierName = params.supplierName;
    const totalMaterial = round(rows.reduce((a: number, r: any) => a + (num(r.materialAmount) || 0), 0), 2) || 0;
    const totalPayment = round(rows.reduce((a: number, r: any) => a + (num(r.paymentAmount) > 0 ? num(r.paymentAmount) : 0), 0), 2) || 0;
    const currentCumulative = round(rows.reduce((a: number, r: any) => a + (r.waived ? 0 : num(r.overdueInterest) || 0), 0), 2) || 0;
    const capAmount = round(totalMaterial * params.interestCapRatio, 2);
    // 上期开累：手动期初值优先，否则自动为上一结算月份的开累
    const months = Array.from(new Set(rows.map((r: any) => r.settlementMonth))).sort();
    let cum = 0;
    const cumByMonth: Record<string, number> = {};
    for (const m of months) {
      cum = round(cum + rows.reduce((a: number, r: any) => (r.settlementMonth === m ? a + (r.waived ? 0 : num(r.overdueInterest) || 0) : a), 0), 2) || 0;
      cumByMonth[m] = cum;
    }
    const currentMonth = months[months.length - 1] || '';
    const manualPrev = rows.filter((r: any) => r.prevCumulative !== null && r.prevCumulative !== undefined).sort((a: any, b: any) => (b.settlementMonth || '').localeCompare(a.settlementMonth || ''))[0];
    const prevCumulative = manualPrev ? num(manualPrev.prevCumulative) || 0 : cumByMonth[months[months.length - 2] || ''] || 0;
    return {
      contract: params,
      list: rows.map((r: any) => ({ ...r, supplierName })),
      stats: {
        totalMaterial,
        totalPayment,
        currentCumulative,
        capRatio: params.interestCapRatio,
        capAmount,
        capUsage: capAmount ? round((currentCumulative / capAmount) * 100, 2) : 0,
        interestRatio: totalMaterial ? round((currentCumulative / totalMaterial) * 100, 2) : 0,
        prevCumulative,
        currentSettlement: round(currentCumulative - prevCumulative, 2) || 0,
        cumulativeByMonth: cumByMonth,
        currentMonth,
      },
    };
  }

  private async validateOverdue(data: any, keep?: any) {
    const contractId = data.contractId || keep?.contractId;
    if (!contractId) throw new BadRequestException('缺少合同ID');
    if (!keep && !String(data.settlementMonth || '').trim()) throw new BadRequestException('结算月份不能为空');
  }

  async createOverdue(data: any) {
    await this.validateOverdue(data);
    const payload = pickFields(data, OVERDUE_FIELDS.filter((f) => f !== 'contractId'), { label: '逾期利息' });
    const contractId = data.contractId;
    const max = await this.prisma.overdueInterest.aggregate({ where: { contractId, settlementMonth: payload.settlementMonth }, _max: { periodSeq: true } });
    payload.periodSeq = (max._max.periodSeq || 0) + 1;
    payload.contractId = contractId;
    // 前端传 YYYY-MM-DD 字符串，Prisma 需要完整 DateTime
    for (const k of ['payableDate', 'paymentDate']) {
      if (payload[k] !== undefined) {
        const d = payload[k] ? new Date(payload[k]) : null;
        payload[k] = d && !isNaN(d.getTime()) ? d : null;
      }
    }
    const created = await this.prisma.overdueInterest.create({ data: payload });
    await this.recalcOverdue(contractId);
    return created;
  }

  async updateOverdue(id: string, data: any) {
    const old = await this.prisma.overdueInterest.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('逾期利息记录不存在');
    await this.validateOverdue(data, old);
    const payload = pickFields(data, OVERDUE_FIELDS.filter((f) => f !== 'contractId'), { label: '逾期利息' });
    for (const k of ['materialAmount', 'paymentRatio', 'paymentAmount', 'prevCumulative']) {
      if (payload[k] !== undefined) payload[k] = payload[k] === null || payload[k] === '' ? null : Number(payload[k]);
    }
    // 前端传 YYYY-MM-DD 字符串，Prisma 需要完整 DateTime
    for (const k of ['payableDate', 'paymentDate']) {
      if (payload[k] !== undefined) {
        const d = payload[k] ? new Date(payload[k]) : null;
        payload[k] = d && !isNaN(d.getTime()) ? d : null;
      }
    }
    await this.prisma.overdueInterest.update({ where: { id }, data: payload });
    await this.recalcOverdue(old.contractId);
    return this.prisma.overdueInterest.findUnique({ where: { id } });
  }

  async removeOverdue(id: string) {
    const old = await this.prisma.overdueInterest.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('逾期利息记录不存在');
    await this.prisma.overdueInterest.delete({ where: { id } });
    await this.recalcOverdue(old.contractId);
    return true;
  }

  /** 逾期利息计算表导出（含标题、统计区、签字区，格式与 Excel 模板一致） */
  async exportOverdue(contractId: string, query: any = {}) {
    const { contract, list, stats } = await this.listOverdue(contractId, query);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('逾期利息计算表');
    ws.mergeCells(1, 1, 1, 11);
    ws.getCell(1, 1).value = '逾期利息计算表';
    ws.getCell(1, 1).font = { bold: true, size: 16 };
    ws.getCell(1, 1).alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 28;
    ws.getCell(2, 1).value = `供应商：${contract.supplierName}　　付款条件：${contract.paymentMode === '3382' ? contract.mode3382Description : contract.mode100Description}`;
    ws.getCell(2, 2).value = '';
    const headers = ['结算月份', '材料款金额', '应付款日期', '逾期起始日期', '付款日期', '付款金额', '计息金额', '逾期天数', '延期月利率', '逾期利息（含税）', '备注'];
    ws.getRow(3).values = headers;
    ws.getRow(3).font = { bold: true };
    list.forEach((r: any, i: number) => {
      ws.getRow(4 + i).values = [
        r.settlementMonth, num(r.materialAmount), fmt(r.payableDate), fmt(r.overdueStartDate), fmt(r.paymentDate),
        num(r.paymentAmount), num(r.interestAmount), r.waived ? '减免' : num(r.overdueDays),
        num(r.monthlyRate), r.waived ? 0 : num(r.overdueInterest), r.remark || '',
      ];
    });
    let rowIdx = 4 + list.length;
    const statRows: (string | number | null)[][] = [
      ['合计', stats.totalMaterial, '', '', '', stats.totalPayment, '', '', '', stats.currentCumulative, ''],
      [`合同约定逾期利息上限比例：${(stats.capRatio * 100).toFixed(2)}%`, `上限金额：${stats.capAmount}`, '', '', '', '', '', '', '', `本期开累逾期利息占比：${stats.interestRatio}%`, ''],
      [`上期开累逾期利息：${stats.prevCumulative}`, `本月结算逾期利息：${stats.currentSettlement}`, '', '', '', '', '', '', '', '', ''],
      ['经办人：', '', '物资经理：', '', '商务经理：', '', '项目经理：', '', '', '', ''],
    ];
    for (const sr of statRows) {
      rowIdx += 1;
      ws.getRow(rowIdx).values = sr;
      ws.getRow(rowIdx).font = { bold: sr[0] === '合计' || String(sr[0]).startsWith('合同约定') };
    }
    ws.columns = [{ width: 11 }, { width: 13 }, { width: 12 }, { width: 13 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 11 }, { width: 15 }, { width: 20 }];
    const buf = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buf), filename: `逾期利息计算表-${contract.contractCode}.xlsx` };
  }
}

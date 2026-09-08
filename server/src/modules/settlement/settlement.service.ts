import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';

const SETTLE_FIELDS = [
  'projectId', 'contractId', 'code', 'typeCode', 'amount', 'deductAmount', 'actualAmount',
  'settleDate', 'statusCode', 'remark',
];
const LEDGER_FIELDS = [
  'projectId', 'contractId', 'settleMonth', 'monthSettleAmount', 'monthInvoiceAmount', 'settleCount',
  'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount', 'monthActualPurchase',
  'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome', 'isOnAccount', 'remark',
];

@Injectable()
export class SettlementService {
  constructor(private prisma: PrismaClient, private dict: DictService, private excel: ExcelService) {}

  // ---------------- 结算单 ----------------
  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { contract: { name: { contains: query.keyword } } }];
    const [list, total] = await Promise.all([
      this.prisma.settlement.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { contract: { select: { id: true, code: true, name: true, supplierId: true, supplier: { select: { id: true, name: true } } } } },
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const s = await this.prisma.settlement.findUnique({ where: { id }, include: { contract: true } });
    if (!s) throw new NotFoundException('结算单不存在');
    return s;
  }

  async create(data: any, projectId: string) {
    await this.dict.validate('settlement_type', data.typeCode);
    await this.dict.validate('settlement_status', data.statusCode);
    const actual = data.actualAmount ?? (num(data.amount) || 0) - (num(data.deductAmount) || 0);
    return this.prisma.settlement.create({
      data: {
        ...pickFields(data, SETTLE_FIELDS, { label: '结算单' }), projectId,
        amount: num(data.amount), deductAmount: num(data.deductAmount), actualAmount: num(actual),
        settleDate: toDate(data.settleDate),
      },
    });
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    await this.dict.validate('settlement_type', data.typeCode);
    await this.dict.validate('settlement_status', data.statusCode);
    const payload: any = pickFields(data, SETTLE_FIELDS, { label: '结算单' });
    ['amount', 'deductAmount', 'actualAmount'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (data.settleDate) payload.settleDate = toDate(data.settleDate);
    return this.prisma.settlement.update({ where: { id }, data: payload });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.settlement.delete({ where: { id } });
    return true;
  }

  // ---------------- 结算台账 ----------------
  async findLedger(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.settleMonth) where.settleMonth = query.settleMonth;
    if (query.isOnAccount) where.isOnAccount = query.isOnAccount;
    const [list, total] = await Promise.all([
      this.prisma.settlementLedger.findMany({
        where, skip, take, orderBy: [{ settleMonth: 'desc' }, { createdAt: 'desc' }],
        include: { contract: { select: { id: true, code: true, name: true, supplier: { select: { id: true, name: true } } } } },
      }),
      this.prisma.settlementLedger.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async ledgerOne(id: string) {
    const l = await this.prisma.settlementLedger.findUnique({ where: { id } });
    if (!l) throw new NotFoundException('结算台账记录不存在');
    return l;
  }

  async createLedger(data: any, projectId: string) {
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = { ...pickFields(data, LEDGER_FIELDS, { label: '结算台账' }), projectId };
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    return this.prisma.settlementLedger.create({ data: payload });
  }

  async updateLedger(id: string, data: any) {
    await this.ledgerOne(id);
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = pickFields(data, LEDGER_FIELDS, { label: '结算台账' });
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    return this.prisma.settlementLedger.update({ where: { id }, data: payload });
  }

  async removeLedger(id: string) {
    await this.ledgerOne(id);
    await this.prisma.settlementLedger.delete({ where: { id } });
    return true;
  }

  async exportLedger(projectId: string) {
    const res = await this.findLedger({ pageSize: 2000 }, projectId);
    const yesNo = await this.dict.nameMap('yes_no');
    const columns = [
      { header: '供应商名称', key: 'supplierName', width: 28 },
      { header: '合同名称', key: 'contractName', width: 30 },
      { header: '合同编号', key: 'contractCode', width: 20 },
      { header: '结算月份', key: 'settleMonth', width: 12 },
      { header: '本月结算额', key: 'monthSettleAmount', width: 16 },
      { header: '本月开票额', key: 'monthInvoiceAmount', width: 16 },
      { header: '结算次数', key: 'settleCount', width: 10 },
      { header: '本年结算额', key: 'yearSettleAmount', width: 16 },
      { header: '截止当月开累采购额', key: 'cumPurchaseAmount', width: 20 },
      { header: '开工结算额', key: 'startSettleAmount', width: 16 },
      { header: '当月实际采购额', key: 'monthActualPurchase', width: 18 },
      { header: '保理贴息', key: 'factoringDiscount', width: 14 },
      { header: '逾期利息', key: 'overdueInterest', width: 14 },
      { header: '本年结算对应收入', key: 'yearSettleIncome', width: 20 },
      { header: '开累结算对应收入', key: 'cumSettleIncome', width: 20 },
      { header: '是否挂账', key: 'isOnAccountName', width: 12 },
    ];
    const rows = (res.list as any[]).map((r) => ({
      supplierName: r.contract?.supplier?.name, contractName: r.contract?.name, contractCode: r.contract?.code,
      settleMonth: r.settleMonth, monthSettleAmount: num(r.monthSettleAmount), monthInvoiceAmount: num(r.monthInvoiceAmount),
      settleCount: r.settleCount, yearSettleAmount: num(r.yearSettleAmount), cumPurchaseAmount: num(r.cumPurchaseAmount),
      startSettleAmount: num(r.startSettleAmount), monthActualPurchase: num(r.monthActualPurchase),
      factoringDiscount: num(r.factoringDiscount), overdueInterest: num(r.overdueInterest),
      yearSettleIncome: num(r.yearSettleIncome), cumSettleIncome: num(r.cumSettleIncome),
      isOnAccountName: yesNo[r.isOnAccount]?.name || '',
    }));
    return this.excel.export(columns, rows, '结算台账');
  }
}

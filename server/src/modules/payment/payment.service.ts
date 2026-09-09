import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';

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
    private runner: ImportRunnerService,
  ) {}

  private contractInclude = {
    contract: { select: { id: true, code: true, name: true, supplier: { select: { id: true, name: true, bankName: true, bankAccount: true } } } },
  };

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

  async createRecord(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    return db.paymentRecord.create({
      data: { ...pickFields(data, RECORD_FIELDS, { label: '付款记录' }), projectId, amount: num(data.amount), payDate: toDate(data.payDate) },
    });
  }

  async updateRecord(id: string, data: any) {
    const before = await this.prisma.paymentRecord.findUnique({ where: { id } });
    assertVersion(before, data);
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    const payload: any = pickFields(data, RECORD_FIELDS, { label: '付款记录' });
    if (payload.amount !== undefined) payload.amount = num(payload.amount);
    if (payload.payDate) payload.payDate = toDate(payload.payDate);
    delete payload.version;
    return this.prisma.paymentRecord.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
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

  // ---------------- 付款台账模板与导入 ----------------
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

  /** 付款台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importRecords(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const methods = await this.dict.options('payment_method');
    const status = await this.dict.options('payment_status');
    const codeOf = (items: any[], val: any) =>
      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    return this.runner.run<any>(rows, {
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const payMonth = String(r['付款月份'] ?? '').trim();
        if (!/^\d{4}-\d{2}$/.test(payMonth)) throw new RowError('付款月份为必填项，格式 YYYY-MM（如 2026-09）', '付款月份');
        const amount = num(r['付款金额']);
        if (amount === null) throw new RowError('付款金额为必填数字', '付款金额');
        const methodName = String(r['付款方式'] ?? '').trim();
        if (methodName && codeOf(methods, methodName) === null) {
          throw new RowError(`下拉校验失败：「${methodName}」不在付款方式选项范围内`, '付款方式');
        }
        const statusName = String(r['状态'] ?? '').trim();
        if (statusName && codeOf(status, statusName) === null) {
          throw new RowError(`下拉校验失败：「${statusName}」不在状态选项范围内`, '状态');
        }
        return {
          data: {
            contractId: contract.id,
            payMonth,
            amount,
            methodCode: codeOf(methods, methodName),
            payDate: r['付款日期'] || null,
            statusCode: codeOf(status, statusName),
            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.createRecord(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }
}

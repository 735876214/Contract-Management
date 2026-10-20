import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';
import { ExcelService } from '../../common/services/excel.service';
import { SysParamService } from '../../common/services/sys-param.service';

@Injectable()
export class RepaymentService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private sysParam: SysParamService,
  ) {}

  async findAll(query: any = {}, projectId: string, maxPageSize = 500) {
    const { skip, take } = paginate(query, maxPageSize);
    const where: any = { projectId };
    if (query.code) where.code = { contains: query.code };
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.contractId) where.contractId = query.contractId;
    if (query.startDate || query.endDate) {
      where.signDate = {};
      if (query.startDate) where.signDate.gte = new Date(query.startDate);
      if (query.endDate) where.signDate.lte = new Date(query.endDate);
    }
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { material: { contains: query.keyword } }];
    const [list, total] = await Promise.all([
      this.prisma.repaymentAgreement.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { id: true, name: true, contactName: true, contactPhone: true } },
          contract: { select: { id: true, code: true, name: true } },
          details: { orderBy: { period: 'asc' } },
        },
      }),
      this.prisma.repaymentAgreement.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string, projectId?: string) {
    const a = await this.prisma.repaymentAgreement.findUnique({
      where: { id },
      include: { supplier: true, contract: true, details: { orderBy: { period: 'asc' } } },
    });
    if (!a) throw new NotFoundException('还款协议不存在');
    // 归属校验：只验项目成员身份不验记录归属时，拿别项目协议的 id 即可读写删
    if (projectId && (a as any).projectId !== projectId) throw new NotFoundException('还款协议不存在');
    return a;
  }

  /**
   * 生成协议编号：前缀 + 年月 + 4 位流水（项目内唯一）。
   *
   * 取「该年月已有编号里的最大流水 + 1」，**不能**用 `count + 1`：删掉中间一条后
   * count 变小、建议号回退到已占用的号（HK-…-0001/0002/0003 删 0001 → 建议 0003），
   * 而 create 先 checkCode 再建，按系统建议号保存会被 400「编号已存在」顶回来。
   * 并发时两个请求仍可能算出同一个号，故逐个试到可用为止（表上有唯一键兜底）。
   */
  async suggestCode(projectId: string) {
    const prefix = await this.sysParam.get('repayment.code.prefix', 'HK');
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const head = `${prefix}-${ym}-`;
    const rows = await this.prisma.repaymentAgreement.findMany({
      where: { projectId, code: { startsWith: head } },
      select: { code: true },
    });
    let max = 0;
    for (const r of rows) {
      const n = Number(String(r.code).slice(head.length));
      if (Number.isFinite(n) && n > max) max = n;
    }
    for (let i = 0; i < 50; i += 1) {
      const code = `${head}${String(max + 1 + i).padStart(4, '0')}`;
      const dup = await this.prisma.repaymentAgreement.findFirst({ where: { projectId, code }, select: { id: true } });
      if (!dup) return code;
    }
    throw new BadRequestException('还款协议编号生成失败，请手动填写编号');
  }

  async checkCode(code: string, projectId: string, excludeId?: string) {
    if (!code) return { exists: false };
    const where: any = { projectId, code };
    if (excludeId) where.id = { not: excludeId };
    const exist = await this.prisma.repaymentAgreement.findFirst({ where });
    return { exists: !!exist };
  }

  /**
   * 只保留 RepaymentAgreement 的真实字段，避免前端传入未对齐的字段名时
   * Prisma 直接抛 Unknown argument 造成 500。
   */
  private normalize(data: any) {
    const payload: any = {};
    [
      'code', 'supplierId', 'contractId', 'material',
      'settleAmount', 'agreedDebtAmount', 'paidBeforeSign', 'paidAfterSign', 'overdueUnpaid', 'remark',
    ].forEach((f) => {
      if (data[f] !== undefined) payload[f] = data[f];
    });
    ['settleAmount', 'agreedDebtAmount', 'paidBeforeSign', 'paidAfterSign', 'overdueUnpaid'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (data.signDate) payload.signDate = toDate(data.signDate);
    return payload;
  }

  /** 明细字段归一化，兼容传入 date/amount 等别名 */
  private normalizeDetail(d: any, i: number) {
    return {
      period: Number(d.period) || i + 1,
      amount: num(d.amount),
      dueDate: toDate(d.dueDate ?? d.date),
      remark: d.remark,
    };
  }

  async create(data: any, projectId: string) {
    if (!data.code) throw new BadRequestException('签订协议编号不能为空');
    const { exists } = await this.checkCode(data.code, projectId);
    if (exists) throw new BadRequestException('协议编号在当前项目中已存在');
    const details = Array.isArray(data.details) ? data.details : [];
    if (!details.length) throw new BadRequestException('至少需录入一条约定还款明细');
    const { details: _d, ...rest } = data;
    return this.prisma.repaymentAgreement.create({
      data: {
        ...this.normalize(rest),
        projectId,
        details: {
          create: details.map((d: any, i: number) => this.normalizeDetail(d, i)),
        },
      },
      include: { details: true, supplier: true },
    });
  }

  async update(id: string, data: any, projectId?: string) {
    const before = await this.findOne(id, projectId);
    assertVersion(before, data);
    if (data.code && data.code !== before.code) {
      const { exists } = await this.checkCode(data.code, before.projectId, id);
      if (exists) throw new BadRequestException('协议编号在当前项目中已存在');
    }
    const details = Array.isArray(data.details) ? data.details : null;
    if (details && !details.length) throw new BadRequestException('至少需保留一条约定还款明细');
    const { details: _d, ...rest } = data;
    const payload: any = this.normalize(rest);
    delete payload.version;
    // 需求 2.1：主表 + 明细在同一事务内写入，任一步失败整体回滚
    await this.prisma.$transaction(async (tx) => {
      await tx.repaymentAgreement.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
      if (details) {
        await tx.repaymentDetail.deleteMany({ where: { agreementId: id } });
        await tx.repaymentDetail.createMany({
          data: details.map((d: any, i: number) => ({ agreementId: id, ...this.normalizeDetail(d, i) })),
        });
      }
    });
    return this.findOne(id);
  }

  async remove(id: string, projectId?: string) {
    await this.findOne(id, projectId);
    await this.prisma.repaymentAgreement.delete({ where: { id } });
    return true;
  }

  /**
   * 导出用全量协议（分页取）：`findAll({ pageSize: 2000 })` 会被 `paginate` 夹到单页上限，
   * 协议数超过上限时导出文件**静默**少行，且没有任何提示。
   */
  private async allAgreements(projectId: string): Promise<any[]> {
    const pageSize = 500;
    const out: any[] = [];
    for (let page = 1; page <= 1000; page += 1) {
      const res: any = await this.findAll({ page, pageSize }, projectId, pageSize);
      const batch = (res.list || []) as any[];
      out.push(...batch);
      if (!batch.length || out.length >= Number(res.total ?? 0)) break;
    }
    return out;
  }

  async export(projectId: string) {
    const list = await this.allAgreements(projectId);
    const columns = [
      { header: '签订协议编号', key: 'code', width: 20 },
      { header: '供应商名称', key: 'supplierName', width: 28 },
      { header: '供应材料', key: 'material', width: 18 },
      { header: '还款协议签订日期', key: 'signDate', width: 18 },
      { header: '结算金额', key: 'settleAmount', width: 16 },
      { header: '协议约定欠款金额', key: 'agreedDebtAmount', width: 18 },
      { header: '截至协议签订已付款金额', key: 'paidBeforeSign', width: 22 },
      { header: '签订协议后付款金额', key: 'paidAfterSign', width: 20 },
      { header: '到期未付款金额', key: 'overdueUnpaid', width: 18 },
      { header: '备注', key: 'remark', width: 22 },
    ];
    const fmt = (d: any) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const rows: any[] = [];
    list.forEach((a) => {
      rows.push({
        code: a.code, supplierName: a.supplier?.name, material: a.material, signDate: fmt(a.signDate),
        settleAmount: num(a.settleAmount), agreedDebtAmount: num(a.agreedDebtAmount),
        paidBeforeSign: num(a.paidBeforeSign), paidAfterSign: num(a.paidAfterSign),
        overdueUnpaid: num(a.overdueUnpaid), remark: a.remark,
      });
      (a.details || []).forEach((d: any) => {
        rows.push({
          code: `${a.code}（第${d.period}期）`,
          supplierName: `约定还款日期：${fmt(d.dueDate)}`,
          material: '', signDate: '', settleAmount: null, agreedDebtAmount: num(d.amount),
          remark: d.remark,
        });
      });
    });
    return this.excel.export(columns, rows, '还款协议');
  }
}

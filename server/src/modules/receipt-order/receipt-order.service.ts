import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';

/** 明细中需要按 Decimal 落库的数值字段 */
const DETAIL_DECIMAL_FIELDS = [
  'contractQty',
  'deliveryQty',
  'receivedQty',
  'priceBeforeTax',
  'taxRate',
  'priceWithTax',
  'totalPrice',
];

/** 明细中允许从前端接收的字段白名单（其余字段由服务端计算/带出，防止越权写入） */
const DETAIL_ALLOWED_FIELDS = [
  'id',
  'materialId',
  'categoryLevel1',
  'categoryLevel2',
  'materialName',
  'specModel',
  'unit',
  'contractQty',
  'deliveryQty',
  'receivedQty',
  'priceBeforeTax',
  'taxRate',
  'usagePart',
  'brand',
  'remark',
  'isSafetyMaterial',
  'isAgentPurchase',
  'sortOrder',
];

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 1e4) / 1e4;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 1e2) / 1e2;

/**
 * 收领单服务（日报管理 → 收领单，与总日报平级）
 *
 * 核心流程：
 * 1. 新建收领单 → 选择供应单位/领用单位/分包合同/物资合同
 * 2. 选择物资合同后，按合同带出「合同物资清单」到明细表格
 * 3. 用户手填送货数量/实收数量/使用部位/厂家品牌/备注/是否安全物资/是否代购
 * 4. 综合单价 = 税前单价 × (1 + 税率/100)；综合总价 = 实收数量 × 综合单价（服务端二次计算，不信任前端）
 * 5. 保存后把明细推送到总日报（DailyReport），总日报可查询到该收领单记录
 */
@Injectable()
export class ReceiptOrderService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
  ) {}

  // ==================== 编号生成 ====================

  /**
   * 生成收领单编号：SO + 日期 + 随机序列，如 SO00009cy000217
   * 规则：SO + YYMMDD(digits) + 项目序码(2) + 6 位随机十六进制片段
   * 后端生成并保证项目内唯一（冲突时重试）
   */
  async nextOrderNo(projectId: string) {
    const date = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${p(date.getFullYear() % 100)}${p(date.getMonth() + 1)}${p(date.getDate())}`;
    // 项目序码：取项目 ID 末 2 位字符，保证同项目编号前缀稳定
    const seq = String(projectId || '')
      .slice(-2)
      .padStart(2, '0');
    let orderNo = '';
    for (let i = 0; i < 20; i += 1) {
      const rnd = Math.floor(Math.random() * 0xffffff)
        .toString(16)
        .padStart(6, '0');
      orderNo = `SO${stamp}${seq}${rnd}`;
      const dup = await this.prisma.receiptOrder.findFirst({ where: { projectId, orderNo } });
      if (!dup) return { orderNo };
    }
    throw new BadRequestException('收领单编号生成失败，请重试');
  }

  // ==================== 查询 ====================

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.materialContractId) where.materialContractId = query.materialContractId;
    if (query.status) where.status = query.status;
    if (query.receiver) where.receiver = { contains: query.receiver };
    if (query.keyword) {
      where.OR = [
        { orderNo: { contains: query.keyword } },
        { supplierName: { contains: query.keyword } },
        { receivingUnitName: { contains: query.keyword } },
        { materialContractNo: { contains: query.keyword } },
        { receiver: { contains: query.keyword } },
      ];
    }
    if (query.startDate || query.endDate) {
      where.orderDate = {};
      if (query.startDate) where.orderDate.gte = new Date(query.startDate);
      if (query.endDate) where.orderDate.lte = new Date(query.endDate);
    }
    const [list, total] = await Promise.all([
      this.prisma.receiptOrder.findMany({
        where,
        skip,
        take,
        orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
        include: {
          supplier: { select: { id: true, name: true } },
          materialContract: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.receiptOrder.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const order = await this.prisma.receiptOrder.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true } },
        materialContract: { select: { id: true, code: true, name: true } },
        subcontract: { select: { id: true, code: true, name: true } },
        details: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!order) throw new NotFoundException('收领单不存在');
    return order;
  }

  /**
   * 选择物资合同后带出该合同下的「合同物资清单」
   * 返回明细行骨架（含带出的只读字段 + 手填字段空位），前端在此基础上编辑
   */
  async loadContractMaterials(contractId: string) {
    if (!contractId) throw new BadRequestException('缺少物资合同 ID');
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { id: true, name: true } } },
    });
    if (!contract) throw new NotFoundException('物资合同不存在');

    const rows = await this.prisma.contractMaterial.findMany({
      where: { contractId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { materialBase: true },
    });

    // 合同税率（小数 0.13）→ 百分比（13）
    const contractPct =
      contract.taxRate != null ? round4(Number(contract.taxRate) * 100) : null;

    const list = rows.map((r: any, i: number) => {
      const priceBeforeTax = num(r.priceBeforeTax);
      const taxRate = num(r.taxRatePct) ?? contractPct;
      const priceWithTax =
        priceBeforeTax != null && taxRate != null ? round4(priceBeforeTax * (1 + taxRate / 100)) : null;
      return {
        // 行唯一标识（前端本地 key，落库时忽略）
        key: r.id,
        materialId: r.materialBaseId,
        categoryLevel1: null as string | null, // 一级分类（物资基础库未建模，留空待扩展）
        categoryLevel2: null as string | null, // 二级分类
        materialName: r.materialBase?.name || '',
        specModel: r.materialBase?.spec || '',
        unit: r.unit || '',
        contractQty: num(r.qty),
        deliveryQty: null as number | null, // 手动填写
        receivedQty: null as number | null, // 手动填写
        priceBeforeTax,
        taxRate,
        priceWithTax,
        totalPrice: null as number | null, // 实收数量 × 综合单价，填写后自动计算
        usagePart: null as string | null,
        brand: null as string | null,
        remark: null as string | null,
        isSafetyMaterial: null as string | null,
        isAgentPurchase: null as string | null,
        sortOrder: i + 1,
      };
    });

    return {
      contract: {
        id: contract.id,
        code: contract.code,
        name: contract.name,
        supplierId: (contract as any).supplier?.id || null,
        supplierName: (contract as any).supplier?.name || '',
        taxRatePct: contractPct,
      },
      list,
    };
  }

  // ==================== 写入 ====================

  private async validate(data: any) {
    await this.dict.validate('yes_no', data.isAsset);
    for (const d of Array.isArray(data.details) ? data.details : []) {
      await this.dict.validate('yes_no', d.isSafetyMaterial);
      await this.dict.validate('yes_no', d.isAgentPurchase);
    }
  }

  /** 主表单头归一化（不含明细） */
  private normalizeHeader(data: any) {
    const p: any = {};
    p.supplierId = data.supplierId || null;
    p.supplierName = data.supplierName ?? null;
    p.receivingUnitId = data.receivingUnitId || null;
    p.receivingUnitName = data.receivingUnitName ?? null;
    p.subcontractId = data.subcontractId || null;
    p.subcontractName = data.subcontractName ?? null;
    p.receiver = data.receiver ?? null;
    p.materialContractId = data.materialContractId || null;
    p.materialContractNo = data.materialContractNo ?? null;
    p.isAsset = data.isAsset ?? null;
    p.remark = data.remark ?? null;
    if (data.orderDate !== undefined) p.orderDate = toDate(data.orderDate);
    return p;
  }

  /**
   * 明细归一化：仅取白名单字段；综合单价/综合总价由服务端按公式重算（不信任前端）
   * 综合单价 = 税前单价 × (1 + 税率/100)；综合总价 = 实收数量 × 综合单价
   */
  private normalizeDetail(d: any, index: number) {
    const out: any = {};
    for (const f of DETAIL_ALLOWED_FIELDS) {
      if (f === 'id' || f === 'sortOrder') continue;
      if (d[f] !== undefined) out[f] = d[f];
    }
    DETAIL_DECIMAL_FIELDS.forEach((f) => {
      if (out[f] !== undefined) out[f] = num(out[f]);
    });
    const priceBeforeTax = num(out.priceBeforeTax);
    const taxRate = num(out.taxRate);
    const receivedQty = num(out.receivedQty);
    out.priceWithTax =
      priceBeforeTax != null && taxRate != null ? round4(priceBeforeTax * (1 + taxRate / 100)) : null;
    out.totalPrice =
      out.priceWithTax != null && receivedQty != null ? round2(out.priceWithTax * receivedQty) : null;
    out.sortOrder = index + 1;
    return out;
  }

  async create(data: any, projectId: string, user?: any) {
    if (!data?.materialContractId) throw new BadRequestException('请选择物资合同');
    if (!data?.supplierId) throw new BadRequestException('请选择供应单位');
    if (!data?.orderDate) throw new BadRequestException('请选择日期');
    await this.validate(data);

    const { orderNo } = await this.nextOrderNo(projectId);
    const details = (Array.isArray(data.details) ? data.details : []).map((d: any, i: number) =>
      this.normalizeDetail(d, i),
    );

    return this.prisma.receiptOrder.create({
      data: {
        ...this.normalizeHeader(data),
        orderNo,
        projectId,
        status: 'SAVED',
        pushedAt: new Date(),
        createdBy: user?.userId || user?.id || null,
        details: { create: details },
      },
      include: { details: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    await this.validate(data);

    const details = (Array.isArray(data.details) ? data.details : []).map((d: any, i: number) =>
      this.normalizeDetail(d, i),
    );

    return this.prisma.$transaction(async (tx) => {
      // 明细整体替换（收领单明细为草稿性数据，全量覆盖语义最清晰）
      await tx.receiptOrderDetail.deleteMany({ where: { orderId: id } });
      await tx.receiptOrder.update({
        where: { id },
        data: {
          ...this.normalizeHeader(data),
          status: 'SAVED',
          pushedAt: new Date(),
          version: { increment: 1 },
          details: { create: details },
        },
      });
      return tx.receiptOrder.findUnique({
        where: { id },
        include: { details: { orderBy: { sortOrder: 'asc' } } },
      });
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    // 明细通过 onDelete: Cascade 级联删除
    await this.prisma.receiptOrder.delete({ where: { id } });
    return true;
  }

  /**
   * 推送总日报：把收领单明细逐行写入 DailyReport
   * 字段映射：
   *  - entryDate       ← orderDate（日期）
   *  - contractId      ← materialContractId（物资合同）
   *  - supplierId      ← supplierId（供应单位）
   *  - receiveUnit     ← receivingUnitName（领用单位）
   *  - receiver        ← receiver（领料人）
   *  - receiptNo       ← orderNo（收领单编号）
   *  - subcontractPeriod ← subcontractName（分包合同）
   *  - materialName/spec/unit ← 明细带出
   *  - settleQty       ← receivedQty（实收数量）
   *  - priceBeforeTax / taxRate / priceAfterTax ← 明细
   *  - amountBeforeTax ← 税前单价 × 实收数量；amountAfterTax ← 综合总价
   *  - usePosition     ← usagePart；isProxy ← isAgentPurchase
   *  - isAsset         ← 主表 isAsset
   */
  async pushToDailyReport(orderId: string) {
    const order: any = await this.findOne(orderId);
    if (!order.details?.length) return { pushed: 0 };

    const rows = order.details.map((d: any) => {
      const priceBeforeTax = num(d.priceBeforeTax);
      const taxRate = num(d.taxRate);
      const receivedQty = num(d.receivedQty);
      const priceAfterTax = num(d.priceWithTax);
      const totalPrice = num(d.totalPrice);
      const amountBeforeTax =
        priceBeforeTax != null && receivedQty != null ? round2(priceBeforeTax * receivedQty) : null;
      const entryDate = toDate(order.orderDate);
      return {
        projectId: order.projectId,
        materialBaseId: d.materialId || null,
        periodYear: entryDate ? entryDate.getFullYear() : null,
        periodMonth: entryDate ? entryDate.getMonth() + 1 : null,
        entryDate,
        contractId: order.materialContractId || null,
        isAsset: order.isAsset ?? null,
        materialCategory: d.categoryLevel1 || null,
        materialType: d.categoryLevel2 || null,
        materialName: d.materialName || null,
        spec: d.specModel || null,
        unit: d.unit || null,
        settleQty: receivedQty,
        priceBeforeTax,
        taxRate,
        priceAfterTax,
        amountBeforeTax,
        amountAfterTax: totalPrice,
        supplierId: order.supplierId || null,
        receiveUnit: order.receivingUnitName || null,
        receiver: order.receiver || null,
        usePosition: d.usagePart || null,
        isProxy: d.isAgentPurchase || null,
        receiptNo: order.orderNo || null,
        remark: d.remark || null,
        subcontractPeriod: order.subcontractName || null,
      };
    });

    // 幂等：同一收领单编号的历史推送先行清理，避免重复推送产生脏数据
    await this.prisma.$transaction(async (tx) => {
      await tx.dailyReport.deleteMany({ where: { projectId: order.projectId, receiptNo: order.orderNo } });
      await tx.dailyReport.createMany({ data: rows });
      await tx.receiptOrder.update({ where: { id: orderId }, data: { pushedAt: new Date() } });
    });
    return { pushed: rows.length };
  }

  /** 重新推送：用于保存后补推 / 修复历史数据 */
  async repush(id: string) {
    return this.pushToDailyReport(id);
  }
}

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

/** 供应单位 / 领用单位类型（需求 2.4.1 / 2.4.2） */
export const PARTY_TYPE = {
  SUPPLIER: 'SUPPLIER', // 供应商（合同已签章的供应商）
  OTHER_PROJECT: 'OTHER_PROJECT', // 其他项目（字典维护的项目列表）
  SUBCONTRACTOR: 'SUBCONTRACTOR', // 分包商（分包商库）
  SELF_PROJECT: 'SELF_PROJECT', // 本项目（字典维护的当前项目）
} as const;

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
        // 一二级分类由物资基础库按「物资名称 + 规格型号」唯一对应带出（需求 2.3.2）
        categoryLevel1: r.materialBase?.categoryLevel1 || null,
        categoryLevel2: r.materialBase?.categoryLevel2 || null,
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

  // ==================== 供应单位 / 领用单位数据源（需求 2.4.1 / 2.4.2） ====================

  /**
   * 供应单位选项（4 类）
   *  - SUPPLIER      供应商：合同已签章的供应商名称（去重）
   *  - OTHER_PROJECT 其他项目：字典 project_list 维护的项目列表
   *  - SUBCONTRACTOR 分包商：分包商库中 编辑中 + 已完成
   *  - SELF_PROJECT  本项目：字典维护的当前项目
   */
  async supplierOptions(projectId: string, keyword?: string) {
    const [suppliers, subcontractors, otherProjects, selfProject] = await Promise.all([
      this.contractSupplierOptions(projectId, keyword),
      this.subcontractorOptions(projectId, keyword),
      this.dictProjectOptions('other_project', keyword),
      this.dictProjectOptions('self_project', keyword, projectId),
    ]);
    return {
      SUPPLIER: suppliers,
      OTHER_PROJECT: otherProjects,
      SUBCONTRACTOR: subcontractors,
      SELF_PROJECT: selfProject,
    };
  }

  /**
   * 领用单位选项（3 类）
   *  - SUBCONTRACTOR 分包商（默认选中）
   *  - SELF_PROJECT  本项目
   *  - OTHER_PROJECT 其他项目
   */
  async receivingUnitOptions(projectId: string, keyword?: string) {
    const [subcontractors, selfProject, otherProjects] = await Promise.all([
      this.subcontractorOptions(projectId, keyword),
      this.dictProjectOptions('self_project', keyword, projectId),
      this.dictProjectOptions('other_project', keyword),
    ]);
    return {
      SUBCONTRACTOR: subcontractors,
      SELF_PROJECT: selfProject,
      OTHER_PROJECT: otherProjects,
    };
  }

  /** 供应商：合同已签章的供应商（status 为 APPROVING / SIGNED / COMPLETED 视为已签章） */
  private async contractSupplierOptions(projectId: string, keyword?: string) {
    const where: any = {
      projectId,
      supplierId: { not: null },
      OR: [{ status: { in: ['APPROVING', 'SIGNED', 'COMPLETED'] } }, { signedFilePath: { not: null } }],
    };
    const contracts = await this.prisma.contract.findMany({
      where,
      select: { supplierId: true, supplier: { select: { id: true, name: true, legalPerson: true, contactName: true, contactPhone: true } } },
    });
    const seen = new Set<string>();
    const list: any[] = [];
    for (const c of contracts) {
      const s: any = (c as any).supplier;
      if (!s || seen.has(s.id)) continue;
      if (keyword && !String(s.name || '').includes(keyword)) continue;
      seen.add(s.id);
      list.push({ ...s, _type: PARTY_TYPE.SUPPLIER, _label: s.name });
    }
    return list;
  }

  /** 分包商：分包商库中 编辑中 + 已完成 */
  private async subcontractorOptions(projectId: string, keyword?: string) {
    const where: any = { status: { in: ['EDITING', 'COMPLETED'] }, projectId };
    if (keyword) {
      where.OR = [
        { subcontractorName: { contains: keyword } },
        { authorizedPerson: { contains: keyword } },
      ];
    }
    const rows = await this.prisma.subcontractor.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map((r: any) => ({
      id: r.id,
      name: r.subcontractorName,
      creditCode: null,
      contactName: r.authorizedPerson || null,
      contactPhone: null,
      legalPerson: r.legalPerson || null,
      authorizedPerson: r.authorizedPerson || null,
      subcontractContent: r.subcontractContent || null,
      subcontractId: r.subcontractId || null,
      status: r.status,
      _type: PARTY_TYPE.SUBCONTRACTOR,
      _label: r.subcontractorName,
    }));
  }

  /** 项目类选项：优先取字典维护的项目列表，缺失时回退到项目表 */
  private async dictProjectOptions(dictCode: string, keyword?: string, projectId?: string) {
    let items: any[] = [];
    try {
      items = await this.prisma.dictItem.findMany({
        where: { typeCode: dictCode, status: 1 },
        orderBy: { sortOrder: 'asc' },
      });
    } catch {
      items = [];
    }
    let list = items.map((i: any) => ({
      id: i.itemCode,
      name: i.itemName,
      creditCode: null,
      contactName: null,
      contactPhone: null,
      _type: dictCode === 'self_project' ? PARTY_TYPE.SELF_PROJECT : PARTY_TYPE.OTHER_PROJECT,
      _label: i.itemName,
    }));
    // 本项目：字典未维护时回退为当前项目自身
    if (dictCode === 'self_project' && !list.length && projectId) {
      const p = await this.prisma.project.findUnique({ where: { id: projectId } });
      if (p) {
        list = [{
          id: p.id, name: p.name, creditCode: null, contactName: null, contactPhone: null,
          _type: PARTY_TYPE.SELF_PROJECT, _label: p.name,
        }];
      }
    }
    if (keyword) list = list.filter((i) => String(i.name || '').includes(keyword));
    return list;
  }

  /**
   * 分包商关联的分包合同（互锁：分包商 ↔ 分包合同）
   * 优先返回分包商库中登记的 subcontractId 对应合同；未登记时按「租赁执行合同」兜底，
   * 保证仍可下拉选择，不阻塞业务。
   */
  async subcontractorContracts(subcontractorId: string, projectId: string) {
    const sub = await this.prisma.subcontractor.findUnique({ where: { id: subcontractorId } });
    if (!sub) throw new NotFoundException('分包商不存在');
    const ids: string[] = [];
    if (sub.subcontractId) ids.push(sub.subcontractId);
    const where: any = { projectId };
    if (ids.length) where.id = { in: ids };
    else where.typeCode = { in: ['LEASE_EXEC', 'LEASE'] };
    const list = await this.prisma.contract.findMany({
      where,
      select: { id: true, code: true, name: true, typeCode: true, supplierId: true },
      orderBy: { createdAt: 'desc' },
    });
    return list;
  }

  // ==================== 写入 ====================

  private async validate(data: any) {
    await this.dict.validate('yes_no', data.isAsset);
    for (const d of Array.isArray(data.details) ? data.details : []) {
      await this.dict.validate('yes_no', d.isSafetyMaterial);
      await this.dict.validate('yes_no', d.isAgentPurchase);
    }
  }

  /**
   * 按供应单位/领用单位类型做动态必填校验（需求 2.4.3）
   *  - 供应单位 = 分包商 → 必填「供应分包合同」，且不校验物资合同
   *  - 供应单位 = 供应商 → 必填「物资合同」
   *  - 供应单位 = 本项目 / 其他项目 → 两者都不必填
   *  - 领用单位 = 分包商 → 必填「分包合同」
   */
  private validateDynamic(data: any) {
    const supplierType = data?.supplierType || null;
    const receivingUnitType = data?.receivingUnitType || null;

    if (supplierType === PARTY_TYPE.SUBCONTRACTOR) {
      if (!data?.supplySubcontractId) throw new BadRequestException('供应单位为分包商时，请选择供应分包合同');
    } else if (supplierType === PARTY_TYPE.SUPPLIER) {
      if (!data?.materialContractId) throw new BadRequestException('供应单位为供应商时，请选择物资合同');
    }
    // 本项目 / 其他项目：不校验合同字段

    if (receivingUnitType === PARTY_TYPE.SUBCONTRACTOR) {
      if (!data?.subcontractId) throw new BadRequestException('领用单位为分包商时，请选择分包合同');
    }
  }

  /** 主表单头归一化（不含明细） */
  private normalizeHeader(data: any) {
    const p: any = {};
    p.supplierId = data.supplierId || null;
    p.supplierName = data.supplierName ?? null;
    p.supplierType = data.supplierType || null;
    p.receivingUnitId = data.receivingUnitId || null;
    p.receivingUnitName = data.receivingUnitName ?? null;
    p.receivingUnitType = data.receivingUnitType || null;
    p.subcontractId = data.subcontractId || null;
    p.subcontractName = data.subcontractName ?? null;
    p.supplySubcontractId = data.supplySubcontractId || null;
    p.supplySubcontractName = data.supplySubcontractName ?? null;
    p.subcontractorId = data.subcontractorId || null;
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
    if (!data?.supplierId) throw new BadRequestException('请选择供应单位');
    if (!data?.receivingUnitId) throw new BadRequestException('请选择领用单位');
    if (!data?.orderDate) throw new BadRequestException('请选择日期');
    this.validateDynamic(data);
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
    this.validateDynamic(data);
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

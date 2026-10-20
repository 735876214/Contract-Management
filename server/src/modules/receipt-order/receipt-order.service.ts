import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { SITE_CONFIRM_STATUS } from '../../constants/workflowGuards';
import {
  CONTRACT_STATUS,
  LEGACY_CONTRACT_STATUS_COMPLETED,
  SUBCONTRACTOR_STATUS,
} from '../../constants/statuses';
import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';
import { round2, round4 } from '../../common/utils/money';
import { DictService } from '../dict/dict.service';
import { TxClient } from '../../common/services/import-runner.service';
import { SettlementService } from '../settlement/settlement.service';
import { ContractLockService } from '../../common/services/contract-lock.service';
import { storageKeyFromUrl } from '../../common/utils/storage-url';


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

/**
 * 明细中允许从前端接收的字段白名单（其余字段由服务端计算/带出，防止越权写入）
 * 需求 2.1.2：「是否安全物资」已从收领单明细移除，改由物资基础库统一维护
 */
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
  'custodian',
  'brand',
  'remark',
  'isAgentPurchase',
  'sortOrder',
];

/** 资产台账来源默认值（需求 2.2.2：根据收领单类型判断，默认「采购」） */
const ASSET_SOURCE_PURCHASE = 'PURCHASE';

/** 供应单位 / 领用单位类型（需求 2.4.1 / 2.4.2） */
export const PARTY_TYPE = {
  SUPPLIER: 'SUPPLIER', // 供应商（合同已签章的供应商）
  OTHER_PROJECT: 'OTHER_PROJECT', // 其他项目（字典维护的项目列表）
  SUBCONTRACTOR: 'SUBCONTRACTOR', // 分包商（分包商库）
  SELF_PROJECT: 'SELF_PROJECT', // 本项目（字典维护的当前项目）
} as const;


/**
 * 收领单服务（日报管理 → 收领单，与总日报平级）
 *
 * 核心流程：
 * 1. 新建收领单 → 选择供应单位/领用单位/分包合同/物资合同
 * 2. 选择物资合同后，按合同带出「合同物资清单」到明细表格
 * 3. 用户手填送货数量/实收数量/使用部位/厂家品牌/备注/是否代购
 * 4. 综合单价 = 税前单价 × (1 + 税率/100)；综合总价 = 实收数量 × 综合单价（服务端二次计算，不信任前端）
 * 5. 保存后把明细推送到总日报（DailyReport）；「是否资产」「是否安全物资」由物资基础库按物资 ID 带出（需求 2.1.3）
 * 6. 保存后对物资基础库标记为「资产」的明细自动写入资产台账（需求 2.2），按明细 ID 防重
 */
@Injectable()
export class ReceiptOrderService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private settlement: SettlementService,
    private lock: ContractLockService,
  ) {}

  // ==================== 结算单关联 ====================

  /**
   * 结算单关联（业务口径 2026-10-16「收领单仅与结算单对应，一张结算单可对多张收领单」）：
   *
   * - 请求里**明确带了** `settlementId`（含显式 `null` 解绑）→ 当人工指定，
   *   先校验「同项目 / 同合同（收领单的合同是**物资合同** `materialContractId`）/ 同月份」；
   * - **没带**且原来也没关联 → **自动匹配**「物资合同 + 下单日期所在月份」的那张结算单
   *   （收领单是月度结算的抓取来源，同月同合同即归属同一张）；
   * - 已有关联且没带 → 保持不动（不覆盖人工选择）。
   */
  private async resolveSettlementId(
    data: any,
    projectId: string,
    current?: string | null,
    fallback?: any,
  ): Promise<string | null> {
    const contractId =
      data.materialContractId !== undefined
        ? data.materialContractId || null
        : (fallback?.materialContractId ?? null);
    const date = data.orderDate !== undefined ? data.orderDate : fallback?.orderDate;
    if (data.settlementId !== undefined) {
      if (!data.settlementId) return null; // 显式解绑
      await this.settlement.assertLinkable(data.settlementId, projectId, { contractId, date, label: '收领单' });
      return data.settlementId;
    }
    // 2026-10-18 业务流审计：改了物资合同或日期时，旧的自动匹配可能已违反「同合同同期」——
    // 必须按新合同/新日期重算（显式传 settlementId 的人工指定仍优先）。current 只在
    // 合同与日期都未变时才保留。
    const contractChanged = data.materialContractId !== undefined && data.materialContractId !== fallback?.materialContractId;
    const dateChanged = data.orderDate !== undefined && new Date(data.orderDate ?? 0).getTime() !== new Date(fallback?.orderDate ?? 0).getTime();
    if (current && !contractChanged && !dateChanged) return current;
    return this.settlement.findSettlementIdFor(contractId, date);
  }

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
          settlement: { select: { id: true, code: true, settleDate: true } },
        },
      }),
      this.prisma.receiptOrder.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  /**
   * 单条查询（带项目归属校验）。
   * 按 id 的读/改/删/推送都必须经过这里：`JwtAuthGuard` 只验「是不是该项目成员」，
   * 不验「这条记录是不是该项目的」——用户同时属于 A、B 两个项目时，
   * 拿 B 的收领单 id 配 A 的项目头即可读到/改写/删除 B 的数据。
   */
  async findOne(id: string, projectId?: string) {
    const order = await this.prisma.receiptOrder.findUnique({
      where: { id },
      include: {
        supplier: { select: { id: true, name: true } },
        materialContract: { select: { id: true, code: true, name: true } },
        subcontract: { select: { id: true, code: true, name: true } },
        settlement: { select: { id: true, code: true, settleDate: true } },
        details: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!order) throw new NotFoundException('收领单不存在');
    if (projectId && (order as any).projectId !== projectId) throw new NotFoundException('收领单不存在');
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
        // 需求 2.3.2：计量单位默认从物资基础库带出（合同清单未维护时回退物资基础库单位）
        unit: r.unit || r.materialBase?.unit || '',
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

  /**
   * 收领单必须挂在**已签章**合同上（业务流：合同签订 → 收领单；2026-10-18 审计）。
   * 与 contractSupplierOptions 同一「已签章」口径：APPROVING/SIGNED/COMPLETED 或已有签章文件。
   */
  private async assertContractSigned(contractId: string | null | undefined) {
    if (!contractId) return;
    const c = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { status: true, signedFilePath: true, code: true },
    });
    if (!c) return; // 归属/存在性由调用方校验
    const signed =
      [CONTRACT_STATUS.APPROVING, CONTRACT_STATUS.SIGNED, LEGACY_CONTRACT_STATUS_COMPLETED].includes(c.status as any) ||
      !!c.signedFilePath;
    if (!signed) {
      throw new BadRequestException(`合同「${c.code}」尚未签章，收领单必须挂在已签订的合同上`);
    }
  }

  /** 供应商：合同已签章的供应商（status 为 APPROVING / SIGNED / COMPLETED 视为已签章） */
  private async contractSupplierOptions(projectId: string, keyword?: string) {
    const where: any = {
      projectId,
      supplierId: { not: null },
      OR: [
        {
          status: {
            in: [
              CONTRACT_STATUS.APPROVING,
              CONTRACT_STATUS.SIGNED,
              LEGACY_CONTRACT_STATUS_COMPLETED,
            ],
          },
        },
        { signedFilePath: { not: null } },
      ],
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
    const where: any = {
      status: { in: [SUBCONTRACTOR_STATUS.EDITING, SUBCONTRACTOR_STATUS.COMPLETED] },
      projectId,
    };
    if (keyword) {
      where.OR = [
        { subcontractorName: { contains: keyword } },
        { authorizedPerson: { contains: keyword } },
      ];
    }
    const rows = await this.prisma.laborAuthLedger.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 });
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
    const sub = await this.prisma.laborAuthLedger.findUnique({ where: { id: subcontractorId } });
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

  /**
   * 供应商在本项目的合同（供应单位=供应商时，物资合同下拉的数据源）：
   * 业务口径 2026-10-17——物资合同下拉只带出**该供应商自己的合同**，由用户自选。
   */
  async supplierContracts(supplierId: string, projectId: string) {
    if (!supplierId) throw new BadRequestException('缺少供应商 ID');
    return this.prisma.contract.findMany({
      where: { projectId, supplierId },
      select: { id: true, code: true, name: true, typeCode: true, supplierId: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 分包商在本项目**领用过的所有材料**（领用单位=分包商时，明细清单的数据源）。
   * ⚠️ 口径与「分包单位领用月度汇总 / 月度盈亏分析」**同源**（业务 2026-10-17：三处是同一组数）
   * ——即 `labor-receiving.service.aggregateReceipts()` 的同一查询：
   * 收领单 `receivingUnitType='SUBCONTRACTOR'` 且分包商出现在供应侧（subcontractorId）
   * 或领用侧（receivingUnitId）。按「材料名+规格」去重（与汇总行键同口径），
   * 骨架字段取最近一条明细，数量列留空手填。
   */
  async subcontractorMaterials(subcontractorId: string, projectId: string) {
    if (!subcontractorId) throw new BadRequestException('缺少分包商 ID');
    const orders = await this.prisma.receiptOrder.findMany({
      where: {
        projectId,
        receivingUnitType: 'SUBCONTRACTOR',
        OR: [{ subcontractorId }, { receivingUnitId: subcontractorId }],
      },
      orderBy: { orderDate: 'desc' },
      select: {
        id: true, orderDate: true,
        details: {
          orderBy: { sortOrder: 'asc' },
          select: {
            materialId: true, categoryLevel1: true, categoryLevel2: true,
            materialName: true, specModel: true, unit: true,
            priceBeforeTax: true, taxRate: true,
          },
        },
      },
    });

    // 按「材料名+规格」去重，保留最近一条明细的骨架字段；税率回退合同/无 → null（手填）
    const byKey = new Map<string, any>();
    outer: for (const o of orders) {
      for (const d of o.details) {
        const name = String(d.materialName || '').trim();
        if (!name) continue;
        const key = `${name}\u0002${d.specModel || ''}`;
        if (byKey.has(key)) continue outer; // 订单已按日期倒序 → 首见即最近
        byKey.set(key, d);
      }
    }

    const baseMap = await this.loadMaterialBaseMap(
      Array.from(byKey.values()).map((d) => ({ materialId: d.materialId })),
      this.prisma,
    );

    let sort = 0;
    const list = Array.from(byKey.values()).map((d: any) => {
      const base: any = d.materialId ? baseMap.get(d.materialId) : null;
      const priceBeforeTax = num(d.priceBeforeTax);
      const taxRate = num(d.taxRate);
      return {
        key: d.materialId || `m-${sort}`,
        materialId: d.materialId || null,
        categoryLevel1: d.categoryLevel1 || base?.categoryLevel1 || null,
        categoryLevel2: d.categoryLevel2 || base?.categoryLevel2 || null,
        materialName: d.materialName || base?.name || '',
        specModel: d.specModel || base?.spec || '',
        unit: d.unit || base?.unit || '',
        contractQty: null as number | null,
        deliveryQty: null as number | null,
        receivedQty: null as number | null, // 手填
        priceBeforeTax,
        taxRate,
        priceWithTax:
          priceBeforeTax != null && taxRate != null
            ? round4(priceBeforeTax * (1 + taxRate / 100))
            : null,
        totalPrice: null as number | null,
        usagePart: null as string | null,
        custodian: null as string | null,
        brand: null as string | null,
        remark: null as string | null,
        isAgentPurchase: null as string | null,
        sortOrder: sort++,
      };
    });
    return { list };
  }

  // ==================== 写入 ====================

  /**
   * 入参校验（需求 2.1.2 / 2.3.2）
   * - 「是否资产」「是否安全物资」不再由收领单维护，故不再校验
   * - 计量单位必须存在于字典「measurement_unit」（允许手输新单位，但须先加入字典）
   */
  private async validate(data: any) {
    if (Array.isArray(data.details) && data.details.length) {
      const units = await this.dict.options('measurement_unit');
      const known = (v: any) => units.some((u: any) => u.itemCode === v || u.itemName === v);
      for (const d of data.details) {
        await this.dict.validate('yes_no', d.isAgentPurchase);
        const unit = String(d.unit ?? '').trim();
        if (unit && !known(unit)) {
          throw new BadRequestException('计量单位不在字典范围内，请先在字典管理中添加');
        }
      }
    }
  }

  /** 字典项查找：编码或名称 → 字典编码（未命中时保留原值，避免丢数据） */
  private pickDictCode(items: any[], raw?: string | null): string | null {
    const v = String(raw ?? '').trim();
    if (!v) return null;
    const hit = items.find((i: any) => i.itemCode === v || i.itemName === v);
    return hit ? hit.itemCode : v;
  }

  /** 计量单位 → 字典编码（日报 / 资产台账统一存编码，与既有数据口径一致） */
  private async toUnitCode(unit?: string | null): Promise<string | null> {
    return this.pickDictCode(await this.dict.options('measurement_unit'), unit);
  }

  /**
   * 事务外预取资产台账入账所需的字典项。
   * 事务内不得再调用 this.dict —— 它使用事务外的 PrismaClient 连接，
   * 连接池耗尽时交互式事务会因等待不可得的连接而永久挂起。
   */
  private async loadAssetDict() {
    const [catL1, catFocus, unit] = await Promise.all([
      this.dict.options('asset_category_l1'),
      this.dict.options('asset_category_focus'),
      this.dict.options('measurement_unit'),
    ]);
    return { catL1, catFocus, unit };
  }

  /** 明细关联的物资基础库映射（资产入账与日报推送共用，避免重复的查询/映射逻辑） */
  private async loadMaterialBaseMap(details: any[], db: any): Promise<Map<string, any>> {
    const ids = Array.from(
      new Set((details || []).map((d: any) => d.materialId).filter(Boolean)),
    ) as string[];
    const bases = ids.length ? await db.materialBase.findMany({ where: { id: { in: ids } } }) : [];
    return new Map<string, any>(bases.map((b: any) => [b.id, b]));
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
    // 表头「是否为资产」（dict yes_no Y/N）：N = 整单不入资产台账
    p.isAssetFlag = data.isAssetFlag || null;
    p.receiver = data.receiver ?? null;
    p.materialContractId = data.materialContractId || null;
    p.materialContractNo = data.materialContractNo ?? null;
    p.remark = data.remark ?? null;
    // 收领单扫描件（附件需求 2026-10-17）：值是 `/api/files/<键>` 或相对键，统一存相对键
    if (data.scanUrl !== undefined) {
      p.scanUrl = data.scanUrl ? storageKeyFromUrl(data.scanUrl) : null;
      p.scanFileName = data.scanUrl ? data.scanFileName ?? null : null;
    }
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
    await this.assertContractSigned(data.materialContractId);
    await this.lock.assertWritable(data.materialContractId, '新增收领单');
    this.validateDynamic(data);
    await this.validate(data);

    const { orderNo } = await this.nextOrderNo(projectId);
    const details = (Array.isArray(data.details) ? data.details : []).map((d: any, i: number) =>
      this.normalizeDetail(d, i),
    );
    // 字典必须在事务外预取：事务内调用 this.dict 会取用事务外的数据库连接，
    // 连接池耗尽时事务会一直等待而挂起
    const assetDict = await this.loadAssetDict();
    // 同理：结算单关联也在事务外解析（要查结算单表）
    const settlementId = await this.resolveSettlementId(data, projectId);

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.receiptOrder.create({
        data: {
          ...this.normalizeHeader(data),
          settlementId,
          orderNo,
          projectId,
          status: 'SAVED',
          pushedAt: new Date(),
          createdBy: user?.userId || user?.id || null,
          details: { create: details },
        },
        include: { details: { orderBy: { sortOrder: 'asc' } } },
      });
      // 需求 2.2：资产物资自动写入资产台账
      await this.syncAssetLedger(created.id, tx, assetDict);
      return created;
    });
    // 任务 5：收领单验收登记完成（保存）即自动将明细导入总日报（幂等：按收领单编号去重）
    await this.pushToDailyReport(order.id);
    return order;
  }

  async update(id: string, data: any, projectId?: string) {
    const before = await this.findOne(id, projectId);
    assertVersion(before, data);
    // 归档锁：原合同与新合同都不能是已归档合同
    await this.lock.assertWritable(before.materialContractId, '修改收领单');
    if (data.materialContractId && data.materialContractId !== before.materialContractId) {
      await this.lock.assertWritable(data.materialContractId, '修改收领单');
      await this.assertContractSigned(data.materialContractId);
    }
    this.validateDynamic(data);
    await this.validate(data);

    const details = (Array.isArray(data.details) ? data.details : []).map((d: any, i: number) =>
      this.normalizeDetail(d, i),
    );
    // 字典必须在事务外预取：事务内调用 this.dict 会取用事务外的数据库连接，
    // 连接池耗尽时事务会一直等待而挂起
    const assetDict = await this.loadAssetDict();
    // 同理：结算单关联也在事务外解析（改了物资合同/日期会重新匹配月份）
    const settlementId = await this.resolveSettlementId(data, before.projectId, before.settlementId, before);

    const saved = await this.prisma.$transaction(async (tx) => {
      // 明细整体替换（收领单明细为草稿性数据，全量覆盖语义最清晰）
      await tx.receiptOrderDetail.deleteMany({ where: { orderId: id } });
      await tx.receiptOrder.update({
        where: { id },
        data: {
          ...this.normalizeHeader(data),
          settlementId,
          status: 'SAVED',
          pushedAt: new Date(),
          version: { increment: 1 },
          details: { create: details },
        },
      });
      // 需求 2.2.3：收领单修改后，资产台账记录同步更新（含移除不再属于资产的明细行）
      await this.syncAssetLedger(id, tx, assetDict);
      return tx.receiptOrder.findUnique({
        where: { id },
        include: { details: { orderBy: { sortOrder: 'asc' } } },
      });
    });
    // 任务 5：保存即把明细导入总日报（幂等：按 receiptOrderId 先清后推）。
    // ⚠️ 必须在事务提交后执行（此前写在 return 后面永远不可达——修改收领单后
    // 总日报（结算量唯一来源）会一直停留在旧数据）。失败不阻断保存本身。
    try {
      await this.pushToDailyReport(id);
    } catch (e) {
      console.error('[收领单] 推送总日报失败（保存已生效，可手动补推）:', e);
    }
    // 关联可能被重算（改了合同/日期后旧结算单解除、新期重挂）→ 台账的收领单
    // 关联计数随之变化，需重刷（与 settlement 侧改动后的收尾同一套）。
    if (settlementId !== before.settlementId && (settlementId || before.settlementId)) {
      try {
        await this.settlement.syncLedgerByContract(settlementId || before.settlementId);
      } catch (e) {
        console.error('[收领单] 关联变更后台账刷新失败:', e);
      }
    }
    return this.findOne(id);
  }

  async remove(id: string, projectId?: string) {
    const before = await this.findOne(id, projectId);
    await this.lock.assertWritable(before.materialContractId, '删除收领单');
    // 单条 DELETE 自带原子性，无需外层事务；级联与加锁说明见下：
    // - 明细（ReceiptOrderDetail）与自动入账的资产台账（AssetLedger.receiptOrderId）均为
    //   DB 级 onDelete: Cascade，随主表删除一并清理，无需手工 deleteMany
    //   （加锁顺序因此天然与「修改」一致：ReceiptOrder → 级联 AssetLedger，不会形成 ABBA 环路）。
    // - 总日报（DailyReport.receiptOrderId）为 onDelete: SetNull——但**推送生成的行**
    //   必须一并删除：它们是本收领单的镜像（推送时直接置「已确认」），SetNull 后会变成
    //   「无来源但已确认」的孤儿行，继续计入结算口径 → 结算量永久虚高且无法再被清理。
    //   手工录入的日报行（receiptOrderId 为空）不受影响。
    await this.prisma.$transaction(async (tx) => {
      await tx.dailyReport.deleteMany({ where: { receiptOrderId: id } });
      await tx.receiptOrder.delete({ where: { id } });
    });
    return true;
  }

  /**
   * 资产物资自动写入资产台账（需求 2.2）
   * - 触发：收领单保存成功后，遍历明细，物资基础库标记为「是资产」的明细入账
   * - 防重：以收领单明细 ID 作为唯一键（AssetLedger.receiptDetailId 唯一约束），重复保存更新而非新增
   * - 清理：明细不再属于资产或已被删除时，删除对应台账记录
   */
  private async syncAssetLedger(
    orderId: string,
    tx: TxClient,
    assetDict: { catL1: any[]; catFocus: any[]; unit: any[] },
  ) {
    const db: any = tx;
    const order: any = await db.receiptOrder.findUnique({
      where: { id: orderId },
      include: { details: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    });
    if (!order) return { created: 0, updated: 0, removed: 0 };

    // 表头「是否为资产」= N → 一票否决：不入账，并清理该单已有台账行
    if (order.isAssetFlag === 'N') {
      const removed = (
        await db.assetLedger.deleteMany({ where: { receiptOrderId: orderId } })
      ).count;
      return { created: 0, updated: 0, removed };
    }

    const baseMap = await this.loadMaterialBaseMap(order.details || [], db);

    const keep: string[] = [];
    let created = 0;
    let updated = 0;
    for (const d of order.details || []) {
      const base: any = d.materialId ? baseMap.get(d.materialId) : null;
      if (!base?.isAsset) continue; // 非资产物资不入账
      keep.push(d.id);

      const qty = num(d.receivedQty);
      const price = num(d.priceWithTax);
      const total =
        qty !== null && price !== null ? round2(qty * price) : (num(d.totalPrice) ?? null);
      const payload: any = {
        projectId: order.projectId,
        date: order.orderDate ? new Date(order.orderDate) : null,
        // 来源：默认「采购」（需求 2.2.2）
        sourceCode: ASSET_SOURCE_PURCHASE,
        categoryL1Code: this.pickDictCode(assetDict.catL1, base.categoryLevel1),
        categoryFocusCode: this.pickDictCode(assetDict.catFocus, base.categoryLevel2),
        name: d.materialName || base.name || null,
        spec: d.specModel || base.spec || null,
        unit: this.pickDictCode(assetDict.unit, d.unit || base.unit),
        qty,
        price,
        totalAmount: total,
        supplierId: order.supplierId || null,
        receiveUnit: order.receivingUnitName || null,
        responsible: order.receiver || null,
        // 默认全部在用（需求 2.2.2）
        inUseQty: qty,
        inUseAmount: total,
        idleQty: null,
        scrapQty: null,
        lostQty: null,
        originalPrice: price,
        originalTotal: total,
        remark:
          [order.remark || null, d.custodian ? `保管：${d.custodian}` : null].filter(Boolean).join('；') || null,
        receiptOrderId: order.id,
        receiptDetailId: d.id,
      };

      const exist = await db.assetLedger.findUnique({ where: { receiptDetailId: d.id } });
      if (exist) {
        await db.assetLedger.update({
          where: { id: exist.id },
          data: { ...payload, version: { increment: 1 } },
        });
        updated += 1;
      } else {
        await db.assetLedger.create({ data: payload });
        created += 1;
      }
    }

    // 清理：该收领单下不再需要入账的台账记录
    const staleWhere: any = { receiptOrderId: orderId };
    if (keep.length) staleWhere.receiptDetailId = { notIn: keep };
    const removed = (await db.assetLedger.deleteMany({ where: staleWhere })).count;
    return { created, updated, removed };
  }


  /**
   * 推送总日报：把收领单明细逐行写入 DailyReport
   * 字段映射：
   *  - entryDate       ← orderDate（日期）
   *  - contractId      ← materialContractId（物资合同）
   *  - supplierId      ← supplierId（供应单位）
   *  - receiveUnit     ← receivingUnitName（领用单位）
   *  - receiver        ← receiver（领料人）
   *  - receiptOrderId  ← order.id（显式外键关联，为幂等清理的依据）
   *  - receiptNo       ← orderNo（收领单编号快照，仅供展示/导入导出；不再用于关联匹配）
   *  - subcontractPeriod ← subcontractName（分包合同）
   *  - materialName/spec/unit ← 明细带出（unit 统一转字典编码）
   *  - settleQty       ← receivedQty（实收数量）
   *  - priceBeforeTax / taxRate / priceAfterTax ← 明细
   *  - amountBeforeTax ← 税前单价 × 实收数量；amountAfterTax ← 综合总价
   *  - usePosition     ← usagePart；isProxy ← isAgentPurchase
   *  - isAsset / isSafetyMaterial ← 物资基础库（按 materialId 关联，需求 2.1.3）
   */
  async pushToDailyReport(orderId: string) {
    const order: any = await this.findOne(orderId);
    if (!order.details?.length) return { pushed: 0 };

    // 需求 2.1.3：总日报的「是否资产」「是否安全物资」来源于物资基础库
    const baseMap = await this.loadMaterialBaseMap(order.details, this.prisma);
    const yesNo = (v: any) => (v === true ? 'Y' : v === false ? 'N' : null);

    const rows = [];
    for (const d of order.details) {
      const priceBeforeTax = num(d.priceBeforeTax);
      const taxRate = num(d.taxRate);
      const receivedQty = num(d.receivedQty);
      const priceAfterTax = num(d.priceWithTax);
      const totalPrice = num(d.totalPrice);
      const amountBeforeTax =
        priceBeforeTax != null && receivedQty != null ? round2(priceBeforeTax * receivedQty) : null;
      const entryDate = toDate(order.orderDate);
      const base: any = d.materialId ? baseMap.get(d.materialId) : null;
      rows.push({
        projectId: order.projectId,
        materialBaseId: d.materialId || null,
        periodYear: entryDate ? entryDate.getFullYear() : null,
        periodMonth: entryDate ? entryDate.getMonth() + 1 : null,
        entryDate,
        contractId: order.materialContractId || null,
        isAsset: yesNo(base?.isAsset),
        isSafetyMaterial: yesNo(base?.isSafetyMaterial),
        materialCategory: d.categoryLevel1 || null,
        materialType: d.categoryLevel2 || null,
        materialName: d.materialName || null,
        spec: d.specModel || null,
        unit: await this.toUnitCode(d.unit || base?.unit),
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
        receiptOrderId: order.id,
        // 现场确认（口径见 .claude/rules/backend-conventions.md「日报/现场确认」）：收领单本身即现场签收 → 推送出的日报行直接置「已确认」，
        // 避免收领单流程被二次卡住（若业务要求收领单也需单独确认，改这里即可）
        confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED,
        confirmedBy: order.receiver || order.createdBy || null,
        confirmedAt: new Date(),
        confirmRemark: '收领单自动确认',
        remark: d.remark || null,
        subcontractPeriod: order.subcontractName || null,
      });
    }

    // 幂等：本收领单的历史推送先行清理，避免重复推送产生脏数据。
    // 按 receiptOrderId（显式外键）而非 receiptNo 文本匹配——收领单编号变更不会再导致残留/误删，
    // 手工通过 Excel 导入的日报行（无 receiptOrderId）也不会被误删。
    await this.prisma.$transaction(async (tx) => {
      await tx.dailyReport.deleteMany({ where: { receiptOrderId: orderId } });
      await tx.dailyReport.createMany({ data: rows });
      await tx.receiptOrder.update({ where: { id: orderId }, data: { pushedAt: new Date() } });
    });
    return { pushed: rows.length };
  }

  /** 重新推送：用于保存后补推 / 修复历史数据。⚠️ 归档合同禁止（否则归档后复活已确认日报行，
   *  结算创建又被锁 → 永久「未纳入结算」，打破归档不变量）。 */
  async repush(id: string, projectId?: string) {
    const order: any = await this.findOne(id, projectId);
    await this.lock.assertWritable(order.materialContractId, '重新推送总日报');
    return this.pushToDailyReport(id);
  }
}

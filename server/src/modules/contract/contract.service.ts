import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { paginate, buildResult, num, fmtDate, assertVersion } from '../../common/utils/helpers';
import { round4 } from '../../common/utils/money';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { ExcelService } from '../../common/services/excel.service';
import { StorageService } from '../../common/services/storage.service';
import { ContractLockService } from '../../common/services/contract-lock.service';
import { collectArchiveBlockers } from '../../common/utils/contract-archive';
import { chainSettledTotal, contractChainIds } from '../../common/utils/contract-chain';
import { periodKeyOf, startDayOf } from '../../common/utils/settlement-period';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { MaterialService } from '../material/material.service';
import { assertContractRejectable } from '../../constants/workflowGuards';
import { computeSupplementDelta } from '../../common/utils/supplement-delta';
import { pickSupplierSnapshot } from '../../common/utils/supplier-snapshot';
// 付款安排与「当前生效比例」的单一事实源（零依赖纯函数；台账列/逾期引擎/付款预警共用同一判定）
import {
  PAYMENT_MODES,
  CUSTOM_PAYMENT_MODE,
  resolveEffectivePayRatio,
} from '../../common/utils/pay-ratio';
import {
  CONTRACT_EXECUTION_STATUS,
  CONTRACT_STATUS,
  FINAL_SETTLEMENT_STATUS,
  INVOICE_STATUS,
  LEGACY_CONTRACT_STATUS_COMPLETED,
  PAYMENT_EXCLUDED_STATUSES,
  SETTLEMENT_STATUS,
  SITE_CONFIRM_STATUS,
} from '../../constants/statuses';
import { contractStageTaskStatus, stageChain } from '../../constants/procurementFlow';
import { TemplateService } from '../template/template.service';
import HTMLtoDOCX from 'html-to-docx';
import { patchDocx } from '../../common/utils/docx-patch';

const CONTRACT_FIELDS = [
  'projectId', 'code', 'name', 'typeCode', 'subTypeCode', 'codeAbbrUsed', 'yearSeq',
  'parentContractId', 'supplementSeq', 'supplierId', 'signDate', 'amount', 'taxRate',
  'paymentMethodCode', 'isFramework', 'isSupplement', 'supplementTypeCode', 'execStatus',
  // 付款安排（100 / 3382 / M65_1 / M65_3 / CUSTOM）：业务口径 2026-10-16「创建合同时二选一」，
  // 取值校验见 assertPaymentMode()，定义与「当前生效比例」的派生见 common/utils/pay-ratio.ts
  'paymentMode',
  'technicalClauseId', 'qualityClauseId', 'paymentClauseId', 'acceptanceClauseId',
  'remark', 'createdBy',
  // 采购工作流（任务一对多）：只关联采购任务；五态合同类型是派生值、不入库（2026-10-16 删列）
  'taskId',
  // 合同起草（需求重构）：起草流转状态、关联模板、物资名称、模板变量值
  'status', 'templateId', 'materialDescription', 'formData',
];

/** 合同起草状态（code 的单一事实源见 constants/statuses.ts，勿在本文件另立一套） */
const CONTRACT_STATUSES: readonly string[] = [
  CONTRACT_STATUS.DRAFT,
  CONTRACT_STATUS.APPROVING,
  CONTRACT_STATUS.SIGNED,
];
const PUBLISHED_STATUSES: readonly string[] = [CONTRACT_STATUS.APPROVING, CONTRACT_STATUS.SIGNED];
const EXT_FIELDS = [
  'financeCode', 'procurementSrc', 'isDirectPurchase', 'bidName', 'currentPayRatio',
  'settlementPayRatio',
  'supplierCategory', 'bidStartDate', 'bidWinDate', 'disclosureDate', 'complaint',
];

const FIELD_LABELS: Record<string, string> = {
  code: '合同编号',
  name: '合同名称',
  typeCode: '合同类型',
  supplierId: '供应商',
  signDate: '签订日期',
  amount: '合同额',
  taxRate: '税率',
  paymentMethodCode: '合同约定付款方式',
  isFramework: '是否框架协议',
  isSupplement: '是否补充协议',
  supplementTypeCode: '补充协议类型',
  execStatus: '合同执行情况',
  remark: '备注',
};

@Injectable()
export class ContractService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private sysParam: SysParamService,
    private excel: ExcelService,
    private tpl: ImportTemplateService,
    private material: MaterialService,
    private templateSvc: TemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
    private storage: StorageService,
    private lock: ContractLockService,
  ) {}

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { name: { contains: query.keyword } }];
    if (query.code) where.code = { contains: query.code };
    if (query.name) where.name = { contains: query.name };
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.execStatus) where.execStatus = query.execStatus;
    if (query.startDate || query.endDate) {
      where.signDate = {};
      if (query.startDate) where.signDate.gte = new Date(query.startDate);
      if (query.endDate) where.signDate.lte = new Date(query.endDate);
    }
    const [list, total] = await Promise.all([
      this.prisma.contract.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { id: true, name: true, legalPerson: true, contactName: true, contactPhone: true } },
          ext: true,
        },
      }),
      this.prisma.contract.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async options(projectId: string, keyword?: string) {
    const where: any = { projectId };
    if (keyword) where.OR = [{ code: { contains: keyword } }, { name: { contains: keyword } }];
    return this.prisma.contract.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: { id: true, code: true, name: true, supplierId: true, amount: true, taxRate: true, typeCode: true },
    });
  }

  async findOne(id: string) {
    const c = await this.prisma.contract.findUnique({
      where: { id },
      include: {
        supplier: true,
        ext: true,
        attachments: true,
        project: { select: { id: true, name: true, codeAbbr: true, industryType: true } },
        parentContract: { select: { id: true, code: true, name: true } },
        supplements: { select: { id: true, code: true, name: true }, orderBy: { supplementSeq: 'asc' } },
      },
    });
    if (!c) throw new NotFoundException('合同不存在');
    // 需求 2.3：附带四种条款内容，供合同详情/编辑回显
    const clauseIds = [c.technicalClauseId, c.qualityClauseId, c.paymentClauseId, c.acceptanceClauseId];
    const ids = clauseIds.filter(Boolean) as string[];
    const clauseList = ids.length
      ? await this.prisma.clause.findMany({ where: { id: { in: ids } } })
      : [];
    const clauseMap = new Map(clauseList.map((x: any) => [x.id, x]));
    const pick = (cid: string | null) => (cid ? clauseMap.get(cid) || null : null);
    return {
      ...c,
      clauses: {
        technical: pick(c.technicalClauseId),
        quality: pick(c.qualityClauseId),
        payment: pick(c.paymentClauseId),
        acceptance: pick(c.acceptanceClauseId),
      },
    };
  }

  // ---------------- 归档（业务口径 2026-10-18：单向，不提供解除归档） ----------------

  /**
   * 归档前检查下游完整性：返回阻断项/提示项，前端据此展示；阻断项非空 → 不允许归档。
   * 口径见 `.claude/rules/document-relationships.md` §5.2。
   */
  async archiveCheck(id: string, projectId: string) {
    const c = await this.prisma.contract.findFirst({ where: { id, projectId } });
    if (!c) throw new NotFoundException('合同不存在');
    const chainIds = await contractChainIds(this.prisma, id);
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { settlementStartDate: true },
    });
    const startDay = startDayOf(project?.settlementStartDate);
    // 结算口径开关：关闭时未确认日报也参与结算，归档检查必须同样统计它们
    const gated = String(await this.sysParam.get('settlement.require_confirmed', 'true')).toLowerCase() !== 'false';

    const [settlements, receiptsTotal, unsettledReceipts, finals, invoiceCount, pendingInvoices, paymentCount, dailyRows, paidSum, settledAmount] =
      await Promise.all([
        this.prisma.settlement.findMany({
          where: { projectId, contractId: { in: chainIds } },
          select: { id: true, code: true, statusCode: true, settleDate: true },
        }),
        this.prisma.receiptOrder.count({ where: { projectId, materialContractId: { in: chainIds } } }),
        this.prisma.receiptOrder.count({
          where: { projectId, materialContractId: { in: chainIds }, settlementId: null },
        }),
        this.prisma.finalSettlement.findMany({
          where: { projectId, contractId: { in: chainIds } },
          select: { id: true, code: true, statusCode: true },
        }),
        this.prisma.invoice.count({ where: { projectId, contractId: { in: chainIds } } }),
        this.prisma.invoice.count({
          where: { projectId, contractId: { in: chainIds }, statusCode: INVOICE_STATUS.WAIT_VERIFY },
        }),
        this.prisma.paymentRecord.count({ where: { projectId, contractId: { in: chainIds } } }),
        this.prisma.dailyReport.findMany({
          where: {
            projectId,
            contractId: { in: chainIds },
            ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}),
          },
          select: { entryDate: true },
        }),
        this.prisma.paymentRecord.aggregate({
          where: {
            projectId,
            contractId: { in: chainIds },
            NOT: { statusCode: { in: PAYMENT_EXCLUDED_STATUSES } },
          },
          _sum: { amount: true },
        }),
        chainSettledTotal(this.prisma, id),
      ]);

    // 已纳入结算的结算期（任意状态；草稿结算本身另列为阻断项）
    const settledPeriods = new Set(
      settlements.map((s: any) => periodKeyOf(startDay, s.settleDate)).filter(Boolean) as string[],
    );
    const dailyRowsWithoutSettlement = dailyRows.filter((r: any) => {
      const key = periodKeyOf(startDay, r.entryDate);
      return !key || !settledPeriods.has(key);
    }).length;

    const hasAnyDownstream =
      receiptsTotal + settlements.length + finals.length + invoiceCount + paymentCount + dailyRows.length > 0;
    const unpaidAmount = Math.round(((settledAmount - (num(paidSum._sum.amount) ?? 0)) + Number.EPSILON) * 100) / 100;

    const result = collectArchiveBlockers({
      signed: c.status === CONTRACT_STATUS.SIGNED,
      execStatus: c.execStatus ?? null,
      hasAnyDownstream,
      draftSettlementCodes: settlements
        .filter((s: any) => s.statusCode === SETTLEMENT_STATUS.DRAFT)
        .map((s: any) => s.code || s.id),
      pendingFinalSettlementCodes: finals
        .filter((f: any) => f.statusCode !== FINAL_SETTLEMENT_STATUS.SETTLED)
        .map((f: any) => f.code || f.id),
      unsettledReceiptCount: unsettledReceipts,
      dailyRowsWithoutSettlement,
      pendingInvoiceCount: pendingInvoices,
      unpaidAmount,
    });
    return { ...result, archivedAt: c.archivedAt, archivedBy: c.archivedBy, execStatus: c.execStatus };
  }

  /** 归档（单向）：检查通过后写入 archivedAt/archivedBy，并记一条变更日志 */
  async archive(id: string, projectId: string, user: any) {
    const c = await this.prisma.contract.findFirst({
      where: { id, projectId },
      select: { id: true, archivedAt: true },
    });
    if (!c) throw new NotFoundException('合同不存在');
    if (c.archivedAt) throw new BadRequestException('合同已归档（单向归档，不提供解除归档）');
    const check = await this.archiveCheck(id, projectId);
    if (!check.canArchive) {
      throw new BadRequestException(`合同归档前需先完成以下事项：${check.blockers.join('；')}`);
    }
    const operator = user?.realName || user?.username || '系统';
    // 归档以**合同链**为单位：主合同与其补充协议一起锁定（否则归档后可继续新增/修改补充协议）
    const chainIds = await contractChainIds(this.prisma, id);
    await this.prisma.contract.updateMany({
      where: { id: { in: chainIds } },
      data: { archivedAt: new Date(), archivedBy: operator, version: { increment: 1 } },
    });
    if (chainIds.length) {
      await this.prisma.contractChangeLog.createMany({
        data: chainIds.map((contractId) => ({
          contractId,
          field: 'archivedAt',
          fieldLabel: '归档',
          beforeValue: null,
          afterValue: operator,
          operatorId: user?.userId || null,
          operator,
        })),
      });
    }
    return this.findOne(id);
  }

  /** 归档后禁止写：合同本体、草稿清单、条款/模板关联等写入口统一调用 */
  private async assertNotArchived(id: string, action = '修改合同') {
    await this.lock.assertWritable(id, action);
  }

  /** 合同编号查重：scope = GLOBAL 全局唯一 / PROJECT 项目内唯一 */
  async checkCode(code: string, projectId: string, excludeId?: string) {
    if (!code) return { exists: false };
    const scope = await this.sysParam.get('contract.code.unique.scope', 'GLOBAL');
    const where: any = scope === 'GLOBAL' ? { code } : { projectId, code };
    if (excludeId) where.id = { not: excludeId };
    const exist = await this.prisma.contract.findFirst({ where });
    return { exists: !!exist, scope };
  }

  private async assertCodeUnique(code: string, projectId: string, excludeId?: string) {
    const { exists, scope } = await this.checkCode(code, projectId, excludeId);
    if (exists) {
      throw new BadRequestException(scope === 'GLOBAL' ? '合同编号已存在（系统内全局唯一）' : '合同编号在当前项目中已存在');
    }
  }

  // ==================== 合同编号自动生成 ====================

  /** 读取编号规则系统参数 */
  private async codeConfig() {
    const [prefix, typeMapping, subTypeMapping, levelMapping, seqDigits, yearReset] = await Promise.all([
      this.sysParam.get('contract.code.fixed_prefix', 'CSCEC'),
      this.sysParam.get('contract.code.type_mapping', '{}'),
      this.sysParam.get('contract.code.sub_type_mapping', '{}'),
      this.sysParam.get('contract.code.level_mapping', '{}'),
      this.sysParam.get('contract.code.seq_digits', '3'),
      this.sysParam.get('contract.code.year_reset', 'true'),
    ]);
    const parseJson = (s: string) => {
      try { return JSON.parse(s) || {}; } catch { return {}; }
    };
    return {
      prefix: prefix || 'CSCEC',
      typeMap: parseJson(typeMapping) as Record<string, string>,
      subTypeMap: parseJson(subTypeMapping) as Record<string, string>,
      // 合同层级：采购合同/租赁合同 G1、采购执行/租赁执行 G2、框架协议 G3
      levelMap: parseJson(levelMapping) as Record<string, string>,
      seqDigits: Math.max(1, Number(seqDigits) || 3),
      yearReset: String(yearReset) !== 'false',
    };
  }

  /**
   * 生成标准合同编号：前缀-类型码-项目字母简称-子类型码-年份顺序码
   * 各段可缺失时在 missing 中提示，不阻断（允许用户手动补齐编号）
   */
  async nextCode(params: { typeCode?: string; subTypeCode?: string; projectId?: string; codeAbbr?: string }) {
    const cfg = await this.codeConfig();
    const missing: string[] = [];

    // 第1段：固定前缀
    const seg1 = cfg.prefix;

    // 第2段：合同类型 → 按字典项名称匹配映射
    let seg2 = '';
    if (params.typeCode) {
      const typeNames = await this.dict.nameMap('contract_type');
      const typeName = typeNames[params.typeCode]?.name || params.typeCode;
      seg2 = cfg.typeMap[typeName] || '';
    }
    if (!seg2) missing.push('合同类型码（检查类型选择或参数 contract.code.type_mapping）');

    // 第3段：项目字母简称（关联项目优先带出，否则用手填值）
    let seg3 = (params.codeAbbr || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (params.projectId) {
      const proj = await this.prisma.project.findUnique({ where: { id: params.projectId } });
      if (proj?.codeAbbr) seg3 = proj.codeAbbr;
    }
    if (!seg3) missing.push('项目字母简称（关联项目或手动输入）');

    // 第4段：合同层级 G1/G2/G3 —— 优先按「合同类型」映射（采购 G1 / 执行 G2 / 框架 G3），
    // 未配置时回退到旧的「合同子类型」映射（兼容历史参数）
    let seg4 = '';
    if (params.typeCode) {
      const typeNames = await this.dict.nameMap('contract_type');
      const typeName = typeNames[params.typeCode]?.name || params.typeCode;
      seg4 = cfg.levelMap[typeName] || '';
    }
    if (!seg4 && params.subTypeCode) {
      const subNames = await this.dict.nameMap('contract_sub_type');
      const subName = subNames[params.subTypeCode]?.name || params.subTypeCode;
      seg4 = cfg.subTypeMap[subName] || '';
    }
    if (!seg4) missing.push('合同层级码（检查合同类型或参数 contract.code.level_mapping）');

    // 第5段：年份 + 顺序码（取已用最大顺序码 +1）
    const year = new Date().getFullYear();
    const yearPrefix = String(year);
    const sameYear = await this.prisma.contract.findMany({
      where: cfg.yearReset ? { yearSeq: { startsWith: yearPrefix } } : { yearSeq: { not: null } },
      select: { yearSeq: true },
    });
    let maxSeq = 0;
    for (const c of sameYear) {
      const digits = cfg.yearReset ? (c.yearSeq || '').slice(yearPrefix.length) : (c.yearSeq || '');
      const n = parseInt(digits, 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    }
    const seq = String(maxSeq + 1).padStart(cfg.seqDigits, '0');
    const yearSeq = `${yearPrefix}${seq}`;

    const segments = [seg1, seg2, seg3, seg4, yearSeq].filter(Boolean);
    const code = segments.join('-');
    return {
      code,
      segments: { prefix: seg1, typeSeg: seg2, abbr: seg3, subTypeSeg: seg4, levelSeg: seg4, yearSeq },
      missing,
      nextSeq: maxSeq + 1,
    };
  }

  /** 补充协议编号：原合同编号（N+1），N 为该合同已有补充协议数 */
  async nextSupplementCode(parentId: string) {
    const parent = await this.findOne(parentId);
    if (parent.isSupplement === 'Y') throw new BadRequestException('补充协议不能再派生补充协议，请选择主合同');
    const count = await this.prisma.contract.count({ where: { parentContractId: parentId } });
    return {
      code: `${parent.code}（${count + 1}）`,
      seq: count + 1,
      parentCode: parent.code,
      parentName: parent.name,
    };
  }

  // ==================== 合同名称自动生成（需求 3.4） ====================

  /**
   * 合同名称规则：TMHB-{类型代码}-{项目简称}-{物资名称}-{合同类型}-{供应商名称}
   * - 类型代码：采购类 CG / 租赁类 ZL（系统参数 contract.name.type_mapping，按合同类型字典项名称匹配）
   * - 项目简称：关联项目的文字版简称 nameAbbr，缺省回退项目名称
   * - 物资名称：用户手填 materialDescription
   * - 合同类型：合同类型字典项名称（如「采购执行合同」）
   * - 供应商名称：所选供应商全称
   */
  async buildName(params: {
    typeCode?: string;
    materialDescription?: string;
    supplierId?: string;
    projectId?: string;
    supplierName?: string;
    projectShortName?: string;
    typeName?: string;
  }) {
    const nameMapping = await this.sysParam.get('contract.name.type_mapping', '{}');
    let typeMap: Record<string, string> = {};
    try {
      typeMap = JSON.parse(nameMapping) || {};
    } catch {
      typeMap = {};
    }

    let typeName = params.typeName || '';
    let typeAbbr = '';
    if (params.typeCode) {
      const names = await this.dict.nameMap('contract_type');
      const hit = names[params.typeCode];
      typeName = typeName || hit?.name || params.typeCode;
      typeAbbr = typeMap[typeName] || (String(params.typeCode).startsWith('LEASE') ? 'ZL' : 'CG');
    }

    let projectShort = params.projectShortName || '';
    if (!projectShort && params.projectId) {
      const proj = await this.prisma.project.findUnique({ where: { id: params.projectId } });
      projectShort = proj?.nameAbbr || proj?.name || '';
    }

    let supplierName = params.supplierName || '';
    if (!supplierName && params.supplierId) {
      const sup = await this.prisma.supplier.findUnique({ where: { id: params.supplierId } });
      supplierName = sup?.name || '';
    }

    const parts = ['TMHB', typeAbbr, projectShort, params.materialDescription || '', typeName, supplierName];
    const name = parts.filter((p) => p !== '').join('-');
    return {
      name,
      segments: { prefix: 'TMHB', typeAbbr, projectShort, material: params.materialDescription || '', typeName, supplierName },
      missing: [
        !typeAbbr && '合同类型代码',
        !projectShort && '项目简称',
        !params.materialDescription && '物资名称',
        !typeName && '合同类型',
        !supplierName && '供应商名称',
      ].filter(Boolean) as string[],
    };
  }

  /** 名称预览（起草页实时拼接展示） */
  async namePreview(params: any) {
    return this.buildName(params);
  }

  // ==================== 合同起草：物料编码清单（Tab1，合同专属物资池） ====================

  /** 物料编码清单：物资名称/规格型号/MDM编码/DSC编码 */
  async poolList(contractId: string) {
    await this.assertContractExists(contractId);
    const rows = await this.prisma.contractMaterialPool.findMany({
      where: { contractId },
      orderBy: { sortOrder: 'asc' },
      include: { materialBase: true },
    });
    return rows.map((r) => ({
      id: r.id,
      materialBaseId: r.materialBaseId,
      sortOrder: r.sortOrder,
      name: r.materialBase.name,
      spec: r.materialBase.spec,
      mdmCode: r.materialBase.mdmCode,
      dscCode: r.materialBase.dscCode,
    }));
  }

  /** 从物资基础库批量导入（追加，已存在则跳过） */
  async poolAdd(contractId: string, materialIds: string[]) {
    await this.assertNotArchived(contractId, '修改合同物资清单');
    await this.assertContractExists(contractId);
    if (!Array.isArray(materialIds) || !materialIds.length) throw new BadRequestException('请选择要导入的物资');
    const bases = await this.prisma.materialBase.findMany({ where: { id: { in: materialIds }, status: 1 } });
    if (!bases.length) throw new BadRequestException('所选物资不存在或已停用');
    const existed = await this.prisma.contractMaterialPool.findMany({
      where: { contractId },
      select: { materialBaseId: true },
    });
    const has = new Set(existed.map((e) => e.materialBaseId));
    let maxSort = existed.length;
    let added = 0;
    for (const b of bases) {
      if (has.has(b.id)) continue;
      await this.prisma.contractMaterialPool.create({
        data: { contractId, materialBaseId: b.id, sortOrder: ++maxSort },
      });
      added += 1;
    }
    return { added, skipped: bases.length - added };
  }

  async poolRemove(contractId: string, poolId: string) {
    await this.assertNotArchived(contractId, '修改合同物资清单');
    const row = await this.prisma.contractMaterialPool.findFirst({ where: { id: poolId, contractId } });
    if (!row) throw new NotFoundException('物料不存在');
    await this.prisma.contractMaterialPool.delete({ where: { id: poolId } });
    // 需求修正1：Tab1（物料编码清单）与 Tab2（合同清单）独立维护，删除 Tab1 物料不再级联删除 Tab2 行
    return true;
  }

  // ==================== 合同起草：合同清单（Tab2，草稿明细） ====================

  /**
   * 合同级税率（需求修正2）：Tab2 合同清单物料税率统一来源于合同主表 taxRate
   * 存储规范：Contract.taxRate 为小数（0.13 = 13%），物料 taxRatePct 为百分比数值（13）
   */
  private async contractTaxPct(contractId: string): Promise<number | null> {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { taxRate: true },
    });
    const frac = contract?.taxRate != null ? Number(contract.taxRate) : null;
    return frac == null ? null : Math.round(frac * 10000) / 100;
  }

  /** 合同税率变更后：Tab2 合同清单所有物料税率同步更新，并按税前单价/数量重算含税金额 */
  private async syncDraftTaxFromContract(contractId: string) {
    const pct = await this.contractTaxPct(contractId);
    const rows = await this.prisma.contractDraftMaterial.findMany({ where: { contractId } });
    for (const r of rows) {
      const price = r.priceBeforeTax != null ? Number(r.priceBeforeTax) : null;
      const qty = r.qty != null ? Number(r.qty) : null;
      const priceWithTax = pct != null && price != null ? round4(price * (1 + pct / 100)) : null;
      const totalWithTax = priceWithTax != null && qty != null ? round4(priceWithTax * qty) : null;
      await this.prisma.contractDraftMaterial.update({
        where: { id: r.id },
        data: { taxRatePct: pct, priceWithTax, totalWithTax },
      });
    }
  }

  /** 列表加载时按合同税率补齐物料税率并重算含税单价/暂定含税合价（持久化，保证展示与数据一致） */
  private async backfillDraftTax(contractId: string, rows: any[]) {
    const pct = await this.contractTaxPct(contractId);
    if (pct == null) return;
    for (const r of rows) {
      if (r.taxRatePct != null) continue;
      const tax = pct;
      const price = r.priceBeforeTax != null ? Number(r.priceBeforeTax) : null;
      const qty = r.qty != null ? Number(r.qty) : null;
      const priceWithTax = price != null ? round4(price * (1 + tax / 100)) : null;
      const totalWithTax = priceWithTax != null && qty != null ? round4(priceWithTax * qty) : null;
      await this.prisma.contractDraftMaterial.update({
        where: { id: r.id },
        data: { taxRatePct: tax, priceWithTax, totalWithTax },
      });
      r.taxRatePct = tax;
      r.priceWithTax = priceWithTax;
      r.totalWithTax = totalWithTax;
    }
  }

  /** 草稿清单行（含主数据字段与自动计算金额） */
  async draftList(contractId: string) {
    await this.assertContractExists(contractId);
    const rows = await this.prisma.contractDraftMaterial.findMany({
      where: { contractId },
      orderBy: { sortOrder: 'asc' },
      include: { materialBase: true },
    });
    await this.backfillDraftTax(contractId, rows as any[]);
    return rows.map((r) => ({
      id: r.id,
      materialBaseId: r.materialBaseId,
      seqNo: r.seqNo,
      name: r.materialBase.name,
      spec: r.materialBase.spec,
      unit: r.unit,
      qty: r.qty != null ? Number(r.qty) : null,
      priceBeforeTax: r.priceBeforeTax != null ? Number(r.priceBeforeTax) : null,
      taxRatePct: r.taxRatePct != null ? Number(r.taxRatePct) : null,
      priceWithTax: r.priceWithTax != null ? Number(r.priceWithTax) : null,
      totalWithTax: r.totalWithTax != null ? Number(r.totalWithTax) : null,
      remark: r.remark,
      sortOrder: r.sortOrder,
    }));
  }

  /** 从物料编码清单（Tab1）勾选派生到合同清单（Tab2），追加不覆盖 */
  async draftDerive(contractId: string, materialBaseIds: string[]) {
    await this.assertNotArchived(contractId, '修改合同清单');
    const contract = await this.assertContractExists(contractId);
    if (!Array.isArray(materialBaseIds) || !materialBaseIds.length) {
      throw new BadRequestException('请先在「物料编码清单」中勾选物资');
    }
    // 需求修正2：新增行预填合同税率（物料税率实时绑定合同税率）
    const frac = contract.taxRate != null ? Number(contract.taxRate) : null;
    const contractPct = frac == null ? null : Math.round(frac * 10000) / 100;
    const pool = await this.prisma.contractMaterialPool.findMany({
      where: { contractId, materialBaseId: { in: materialBaseIds } },
      orderBy: { sortOrder: 'asc' },
    });
    if (!pool.length) throw new BadRequestException('所选物资不在本合同的物料编码清单中');
    const existed = await this.prisma.contractDraftMaterial.findMany({
      where: { contractId },
      select: { materialBaseId: true, sortOrder: true },
    });
    const has = new Set(existed.map((e) => e.materialBaseId));
    let maxSort = existed.reduce((m, e) => Math.max(m, e.sortOrder || 0), 0);
    let added = 0;
    for (const p of pool) {
      if (has.has(p.materialBaseId)) continue;
      await this.prisma.contractDraftMaterial.create({
        data: {
          contractId,
          materialBaseId: p.materialBaseId,
          seqNo: ++maxSort,
          unit: '',
          taxRatePct: contractPct,
          sortOrder: maxSort,
          remark: '由物料编码清单派生',
        },
      });
      added += 1;
    }
    return { added, skipped: pool.length - added };
  }

  /**
   * 由「采购总清单」带入**起草期合同清单**（采购阶段已算过的量价不必在合同里重录）。
   *
   * 与 `draftDerive` 的区别：derive 取自本合同的「物料编码清单（物料池）」，
   * 本方法取自采购任务的 `ProcurementTotalItem`，用于**自动生成合同时**预填清单行。
   * - 税率与 `draftSave` 口径一致：一律取合同主表税率（物料税率不独立存储）；
   * - 含税单价 / 暂定含税合价按同一公式服务端重算（4 位精度），不信任调用方传入；
   * - 已存在的物资跳过（`@@unique([contractId, materialBaseId])`），可安全重复调用；
   * - 调用方需容错：带入失败不应阻断合同生成（见 procurement-task.service 的调用点）。
   *
   * @param items 采购总清单行（`materialBaseId` 必填；`priceBeforeTax` 约定传「控制价」planPrice）
   */
  async seedDraftFromProcurementItems(
    contractId: string,
    items: {
      materialBaseId?: string | null;
      qty?: number | null;
      priceBeforeTax?: number | null;
      unit?: string | null;
      remark?: string | null;
    }[],
  ): Promise<{ added: number; skipped: number }> {
    await this.assertContractExists(contractId);
    if (!Array.isArray(items) || !items.length) return { added: 0, skipped: 0 };
    const contractPct = await this.contractTaxPct(contractId);
    const existed = await this.prisma.contractDraftMaterial.findMany({
      where: { contractId },
      select: { materialBaseId: true, sortOrder: true },
    });
    const has = new Set(existed.map((e) => e.materialBaseId));
    let maxSort = existed.reduce((m, e) => Math.max(m, e.sortOrder || 0), 0);

    const numOf = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    let added = 0;
    let skipped = 0;
    for (const it of items) {
      const materialBaseId = String(it?.materialBaseId ?? '').trim();
      if (!materialBaseId || has.has(materialBaseId)) {
        skipped += 1;
        continue;
      }
      const qty = numOf(it.qty);
      const price = numOf(it.priceBeforeTax);
      const priceWithTax = price != null && contractPct != null ? round4(price * (1 + contractPct / 100)) : null;
      const totalWithTax = priceWithTax != null && qty != null ? round4(priceWithTax * qty) : null;
      maxSort += 1;
      has.add(materialBaseId);
      await this.prisma.contractDraftMaterial.create({
        data: {
          contractId,
          materialBaseId,
          seqNo: maxSort,
          sortOrder: maxSort,
          unit: String(it.unit ?? '').trim(),
          qty,
          priceBeforeTax: price,
          taxRatePct: contractPct,
          priceWithTax,
          totalWithTax,
          remark: it.remark ?? '由采购总清单带入',
        },
      });
      added += 1;
    }
    return { added, skipped };
  }

  /** 保存草稿清单行（含税单价 / 暂定含税合价 服务端统一计算，4 位精度） */
  async draftSave(contractId: string, rows: any[]) {
    await this.assertNotArchived(contractId, '修改合同清单');
    await this.assertContractExists(contractId);
    if (!Array.isArray(rows)) throw new BadRequestException('参数格式错误');
    // 需求修正2：物料税率不独立存储，保存时一律以合同主表税率为准（前端传值忽略）
    const contractPct = await this.contractTaxPct(contractId);
    // 需求 2.3.2：合同清单计量单位必须存在于字典「measurement_unit」（允许手输，但须先加入字典）
    const unitItems = await this.dict.options('measurement_unit');
    const normalizeUnit = (raw: any): string => {
      const v = String(raw ?? '').trim();
      if (!v) return '';
      const hit = unitItems.find((u: any) => u.itemName === v || u.itemCode === v);
      if (!hit) throw new BadRequestException('计量单位不在字典范围内，请先在字典管理中添加');
      return hit.itemName;
    };
    let saved = 0;
    for (const [i, r] of rows.entries()) {
      if (!r?.id) continue;
      const qty = r.qty == null || r.qty === '' ? null : Number(r.qty);
      const price = r.priceBeforeTax == null || r.priceBeforeTax === '' ? null : Number(r.priceBeforeTax);
      const tax = contractPct;
      const priceWithTax = price != null && tax != null ? round4(price * (1 + tax / 100)) : null;
      const totalWithTax = priceWithTax != null && qty != null ? round4(priceWithTax * qty) : null;
      await this.prisma.contractDraftMaterial.update({
        where: { id: r.id },
        data: {
          seqNo: r.seqNo ?? i + 1,
          unit: normalizeUnit(r.unit),
          qty,
          priceBeforeTax: price,
          taxRatePct: tax,
          priceWithTax,
          totalWithTax,
          remark: r.remark ?? null,
          sortOrder: r.sortOrder ?? i + 1,
        },
      });
      saved += 1;
    }
    return { saved };
  }

  async draftRemove(contractId: string, id: string) {
    await this.assertNotArchived(contractId, '修改合同清单');
    const row = await this.prisma.contractDraftMaterial.findFirst({ where: { id, contractId } });
    if (!row) throw new NotFoundException('清单行不存在');
    await this.prisma.contractDraftMaterial.delete({ where: { id } });
    return true;
  }

  // ==================== 合同起草：发布与状态流转（需求 3.2） ====================

  /**
   * 发布：草稿清单 → 正式【合同物资清单】模块持久化，状态置为「已完成」
   * 全量同步：先清除该合同旧清单，再按草稿行写入，保证两处一致
   */
  async publish(contractId: string) {
    await this.assertNotArchived(contractId, '发布合同');
    const contract = await this.findOne(contractId);
    if (!contract.templateId) throw new BadRequestException('请先在基础信息中选择合同模板');
    const drafts = await this.prisma.contractDraftMaterial.findMany({
      where: { contractId },
      orderBy: { sortOrder: 'asc' },
    });
    await this.prisma.contractMaterial.deleteMany({ where: { contractId } });
    let pushed = 0;
    for (const [i, d] of drafts.entries()) {
      await this.prisma.contractMaterial.create({
        data: {
          contractId,
          materialBaseId: d.materialBaseId,
          unit: d.unit || '',
          qty: d.qty,
          priceBeforeTax: d.priceBeforeTax,
          taxRatePct: d.taxRatePct,
          priceWithTax: d.priceWithTax,
          totalWithTax: d.totalWithTax,
          remark: d.remark,
          sortOrder: d.sortOrder || i + 1,
        },
      });
      pushed += 1;
    }
    await this.prisma.contract.update({
      where: { id: contractId },
      data: { status: CONTRACT_STATUS.APPROVING, version: { increment: 1 } },
    });
    // 补充协议：清单已固化，按清单重算「带符号增量」（业务口径：合同当前金额 = 主合同 + Σ 增量）
    const delta = await this.recalcSupplementDelta(contractId);
    await this.syncLinkedTaskStatus(contractId);
    return {
      pushed,
      status: CONTRACT_STATUS.APPROVING,
      ...(delta ? { changeAmount: delta.amount, changeQty: delta.qty } : {}),
    };
  }

  /** 状态互转（需求修正：DRAFT 草稿中 / APPROVING 待签章 / SIGNED 已签章） */
  /**
   * 补充协议：按清单重算**带符号增量**并落库。
   *
   * 为什么要服务端算：补充协议的 `amount` 是自由填写字段，涨价/降价场景下用户往往填的是
   * "剩余数量 × 新价"，直接相加会把那部分数量的原值**重复计入**；真正要加的是差额
   * （见 `common/utils/supplement-delta.ts` 的说明）。
   *
   * ⚠️ 只在**已发布**（草稿清单已固化为正式清单）时重算：草稿阶段变更尚未生效，
   * 不应抬高防超结的上限。非补充协议、或没有父合同 → 不做任何事。
   */
  private async recalcSupplementDelta(contractId: string) {
    const c = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { isSupplement: true, parentContractId: true, supplementTypeCode: true },
    });
    if (!c || c.isSupplement !== 'Y' || !c.parentContractId) return null;

    const select = { materialBaseId: true, qty: true, priceWithTax: true, totalWithTax: true };
    const [suppRows, parentRows] = await Promise.all([
      this.prisma.contractMaterial.findMany({ where: { contractId }, select }),
      this.prisma.contractMaterial.findMany({ where: { contractId: c.parentContractId }, select }),
    ]);
    const delta = computeSupplementDelta({
      typeCode: c.supplementTypeCode,
      suppRows: suppRows as any,
      parentRows: parentRows as any,
    });
    await this.prisma.contract.update({
      where: { id: contractId },
      data: { changeAmount: delta.amount, changeQty: delta.qty, version: { increment: 1 } },
    });
    return delta;
  }

  async setStatus(contractId: string, status: string) {
    await this.assertNotArchived(contractId, '变更合同状态');
    if (!CONTRACT_STATUSES.includes(status)) {
      throw new BadRequestException('状态取值非法（DRAFT / APPROVING / SIGNED）');
    }
    await this.assertContractExists(contractId);
    await this.prisma.contract.update({
      where: { id: contractId },
      data: { status, version: { increment: 1 } },
    });
    await this.syncLinkedTaskStatus(contractId);
    return { status };
  }

  /**
   * 任务 7：合同签章驳回 → 回退到「合同起草」（DRAFT），纯状态回退。
   * 仅「待签章 / 已签章」可驳回；回退后若是采购任务主合同，则同步回退任务状态到「合同编制中」。
   */
  async rejectToDraft(contractId: string) {
    await this.assertNotArchived(contractId, '驳回合同');
    const c = await this.findOne(contractId);
    // 状态机守卫（单一事实源）：仅「待签章 / 已签章」可驳回回合同起草
    assertContractRejectable(c.status);
    await this.prisma.contract.update({
      where: { id: contractId },
      data: { status: CONTRACT_STATUS.DRAFT, signedFilePath: null, version: { increment: 1 } },
    });
    // 关联采购任务（且为本任务主合同）时，同步任务状态（合同编制中 / 合同待签章 / 已完成）
    await this.syncLinkedTaskStatus(contractId);
    return this.findOne(contractId);
  }

  /**
   * 任务关联的「主合同」= 该任务生成时间最早的合同。
   * 同一批生成时 createdAt 可能相同，再按编号排序保证确定性；
   * 采购任务与合同的关联只由 `Contract.taskId` 一条表达。
   */
  private async mainContractOf(taskId: string) {
    return this.prisma.contract.findFirst({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
      select: { id: true },
    });
  }

  /**
   * 合同状态变化后，同步其**采购任务**的合同阶段状态
   * （DRAFT → 合同编制中 / APPROVING → 合同待签章 / SIGNED → 已完成，映射见 `contractStageTaskStatus`）。
   *
   * 调用时机：签章、状态互转、提交（草稿→待签章）、驳回回起草。
   * 仅在「该合同是其任务的主合同」且「任务已走完阶段链」时同步——避免用户在起草页把合同
   * 关联到流程中的任务时误改该任务状态（那种情况下任务状态仍应由阶段进度决定）。
   */
  private async syncLinkedTaskStatus(contractId: string) {
    const c = await this.prisma.contract.findUnique({
      where: { id: contractId },
      select: { id: true, taskId: true, status: true },
    });
    if (!c?.taskId) return;
    const task = await this.prisma.procurementTask.findUnique({
      where: { id: c.taskId },
      select: { id: true, type: true, stage: true, preMeetingRequired: true, status: true },
    });
    if (!task) return;
    // 未走完阶段链时不介入：任务状态仍由阶段进度决定
    if (task.stage < stageChain(task.type, task.preMeetingRequired).length) return;
    // 非主合同：任务状态跟随主合同，不由本合同的变更改写
    if ((await this.mainContractOf(c.taskId))?.id !== contractId) return;
    const next = contractStageTaskStatus(c.status);
    if (next === task.status) return;
    await this.prisma.procurementTask.update({
      where: { id: task.id },
      data: { status: next, version: { increment: 1 } },
    });
  }

  /** 合同是否存在（用于起草子资源校验） */
  private async assertContractExists(contractId: string) {
    const c = await this.prisma.contract.findUnique({ where: { id: contractId } });
    if (!c) throw new NotFoundException('合同不存在');
    return c;
  }

  /** 从合同编号尾部提取年份顺序码（如 ...-2026002 → 2026002），用于固化 yearSeq */
  private extractYearSeq(code: string): string | null {
    const m = code.match(/(\d{4})(\d{2,})\s*$/);
    return m ? `${m[1]}${m[2]}` : null;
  }

  private async validateDict(data: any) {
    await this.dict.validate('contract_type', data.typeCode);
    await this.dict.validate('contract_sub_type', data.subTypeCode);
    await this.dict.validate('yes_no', data.isFramework);
    await this.dict.validate('yes_no', data.isSupplement);
    await this.dict.validate('payment_method', data.paymentMethodCode);
    await this.dict.validate('contract_execution_status', data.execStatus);
    if (data.isSupplement === 'Y') {
      await this.dict.validate('supplement_agreement_type', data.supplementTypeCode, true);
    }
  }

  /**
   * 付款安排取值校验（业务口径 2026-10-16：创建合同时**二选一**）。
   *
   * 取值不在 `PAYMENT_MODES` 里且不是 `CUSTOM` → 400。**不要放宽成任意字符串**：
   * 付款安排决定「月度比例」，写错了 `currentPayRatio` 派生值就错，台账列与付款预警都会跟着错，
   * 而且很难从界面上看出来。
   */
  private assertPaymentMode(mode: unknown) {
    if (mode === undefined || mode === null || mode === '') return;
    const known = Object.keys(PAYMENT_MODES);
    if (!known.includes(String(mode)) && String(mode) !== CUSTOM_PAYMENT_MODE) {
      throw new BadRequestException(
        `付款安排「${mode}」不在可选范围内，请选择：${known.map((k) => `${k}（${PAYMENT_MODES[k].label}）`).join('、')}` +
          `、${CUSTOM_PAYMENT_MODE}（自定义，需另填月度结算办理比例）`,
      );
    }
  }

  /**
   * 重算并落库**当前生效付款比例**（`ContractExt.currentPayRatio`，业务口径 2026-10-16 定为派生列）。
   *
   * 判定只有一处实现（`common/utils/pay-ratio.ts` 的 `resolveEffectivePayRatio`）：
   * ① 已完已结（总结算办理完成）→ 100%；② 否则按付款安排的月度比例；③ 自定义安排 → 合同上手填的比例。
   *
   * ⚠️ **推不出来时返回 `null` 且不动原值**：把"未知"改写成某个数，台账「当前合同付款比例」列与
   * 付款预警都会给出假口径（"未填 ≠ 0"的既定原则在这儿同样适用）。
   * ⚠️ 台账列、逾期引擎的 `paymentRatio`、工作台付款预警都读这一列 —— 改了这里就是改了那三处的口径。
   */
  async syncPayRatio(contractId: string, tx?: TxClient): Promise<number | null> {
    const db: any = tx || this.prisma;
    const c = await db.contract.findUnique({
      where: { id: contractId },
      select: {
        execStatus: true,
        paymentMode: true,
        ext: { select: { settlementPayRatio: true } },
      },
    });
    if (!c) return null;
    const next = resolveEffectivePayRatio({
      execStatus: c.execStatus,
      paymentMode: c.paymentMode,
      customRatio: c.ext?.settlementPayRatio == null ? null : Number(c.ext.settlementPayRatio),
    });
    if (next === null) return null;
    const exist = await db.contractExt.findUnique({ where: { contractId }, select: { currentPayRatio: true } });
    // 没有扩展行时不擅自创建（ext 由合同保存流程维护；这里凭空建行会让"合同有没有扩展信息"失真）
    if (!exist) return null;
    if (Number(exist.currentPayRatio) === next) return next;
    await db.contractExt.update({ where: { contractId }, data: { currentPayRatio: next } });
    return next;
  }

  async create(data: any, projectId: string, user: any, tx?: TxClient) {
    const db: any = tx || this.prisma;
    if (!data.code) throw new BadRequestException('合同编号不能为空');
    await this.assertCodeUnique(data.code, projectId);
    await this.validateDict(data);
    this.assertPaymentMode(data.paymentMode);

    // 名称自动生成（需求 3.4）：未手填名称或显式 autoName 时按规则拼接并锁定
    if (data.autoName !== false && (!data.name || data.autoName === true)) {
      const built = await this.buildName({
        typeCode: data.typeCode,
        materialDescription: data.materialDescription,
        supplierId: data.supplierId,
        projectId,
      });
      if (built.name) data.name = built.name;
    }
    // 模板变量值统一按 JSON 文本持久化
    if (data.formData && typeof data.formData !== 'string') {
      data.formData = JSON.stringify(data.formData);
    }

    // 编号段落固化：yearSeq / codeAbbrUsed 未传时自动补齐
    if (!data.yearSeq) data.yearSeq = this.extractYearSeq(data.code);
    if (!data.codeAbbrUsed) {
      const proj = await db.project.findUnique({ where: { id: projectId } });
      data.codeAbbrUsed = proj?.codeAbbr || null;
    }

    // 补充协议：未传编号/顺序码时按「原合同编号（N+1）」自动生成
    if (data.isSupplement === 'Y' && data.parentContractId) {
      const parent = await db.contract.findUnique({ where: { id: data.parentContractId } });
      if (!parent) throw new BadRequestException('父合同不存在');
      if (parent.isSupplement === 'Y') throw new BadRequestException('补充协议不能再派生补充协议，请选择主合同');
      if (parent.projectId !== projectId) throw new BadRequestException('父合同与当前项目不一致');
      if (parent.archivedAt) throw new BadRequestException('父合同已归档，不能新增补充协议');
      if (!data.supplementSeq) {
        const count = await db.contract.count({ where: { parentContractId: data.parentContractId } });
        data.supplementSeq = count + 1;
      }
      if (!data.code) data.code = `${parent.code}（${data.supplementSeq}）`;
      if (!data.yearSeq) data.yearSeq = parent.yearSeq;
      await this.assertCodeUnique(data.code, projectId);
    }

    const { attachments, ext, ...rest } = data;
    const contract = await db.contract.create({
      data: {
        ...pickFields(rest, CONTRACT_FIELDS, { label: '合同' }),
        projectId,
        signDate: data.signDate ? new Date(data.signDate) : null,
        amount: num(data.amount),
        taxRate: num(data.taxRate),
        createdBy: user?.userId,
      },
    });
    if (ext) await this.saveExt(contract.id, ext, tx);
    // 付款安排 / 扩展信息落库后重算「当前生效比例」（派生列，见 syncPayRatio）
    await this.syncPayRatio(contract.id, tx);
    if (Array.isArray(attachments)) {
      await db.contractAttachment.createMany({
        data: attachments.map((a: any) => ({ contractId: contract.id, fileName: a.fileName, url: a.url, size: a.size })),
      });
    }
    // 需求 2.1/2.3：创建合同时可从物资基础库（项目物资清单数据源）选择物资，
    // 派生生成合同物资清单（唯一数据源），序号从 1 开始
    const materialIds = Array.isArray(data.materialIds) ? data.materialIds : [];
    if (materialIds.length) {
      if (!tx) await this.material.derive(contract.id, materialIds); // 导入事务中不派生，避免跨连接锁等待
    }
    return this.findOne(contract.id);
  }

  async update(id: string, data: any, user: any) {
    await this.assertNotArchived(id, '修改合同');
    const before = await this.findOne(id);
    assertVersion(before, data); // 乐观锁：版本号不一致说明已被他人修改
    // 合同编号正式生成后不可变更（历史数据固化）
    if (data.code && data.code !== before.code) {
      throw new BadRequestException('合同编号生成后不可变更');
    }
    delete data.code;
    // 需求修正5 / 需求 2.1：发布后（待签章/已签章）合同类型固化不可修改；
    // 历史空状态数据在 UI 上按「待签章」展示，同样视为已发布
    if (
      data.typeCode !== undefined &&
      data.typeCode !== before.typeCode &&
      (before.status ?? CONTRACT_STATUS.APPROVING) !== CONTRACT_STATUS.DRAFT
    ) {
      throw new BadRequestException('合同已发布，合同类型不可修改');
    }
    await this.validateDict({ ...before, ...data });
    this.assertPaymentMode(data.paymentMode);
    // 名称自动生成（需求 3.4）：起草页传 autoName=true 时按规则重算并锁定
    if (data.autoName === true) {
      const built = await this.buildName({
        typeCode: data.typeCode ?? before.typeCode,
        materialDescription: data.materialDescription ?? before.materialDescription,
        supplierId: data.supplierId ?? before.supplierId,
        projectId: before.projectId,
      });
      if (built.name) data.name = built.name;
    }
    if (data.formData && typeof data.formData !== 'string') {
      data.formData = JSON.stringify(data.formData);
    }
    const { attachments, ext, ...rest } = data;
    // 签订日期仅在显式传入时更新，避免未携带该字段的编辑请求把已有签订日期清空
    const signDatePatch =
      data.signDate !== undefined ? { signDate: data.signDate ? new Date(data.signDate) : null } : {};
    const contract = await this.prisma.contract.update({
      where: { id },
      data: {
        ...pickFields(rest, CONTRACT_FIELDS, { label: '合同' }),
        ...signDatePatch,
        /**
         * ⚠️ 必须**按"传了才写"**处理：`num(undefined)` 返回 `null`，无条件赋值会让任何部分更新
         * （例如只改付款安排）把合同额/税率**静默清空**。显式传 `null` 仍然是"清空"（业务上要能改回空）。
         */
        ...(data.amount !== undefined ? { amount: num(data.amount) } : {}),
        ...(data.taxRate !== undefined ? { taxRate: num(data.taxRate) } : {}),
        version: { increment: 1 },
      },
    });
    if (ext) await this.saveExt(id, ext);
    // 付款安排 / 执行情况（execStatus）变更后重算「当前生效比例」
    await this.syncPayRatio(id);
    // 需求修正2：合同税率变更 → Tab2 合同清单所有物料税率同步更新并重算金额
    if (data.taxRate !== undefined) {
      await this.syncDraftTaxFromContract(id);
    }
    if (Array.isArray(attachments)) {
      await this.prisma.contractAttachment.deleteMany({ where: { contractId: id } });
      if (attachments.length) {
        await this.prisma.contractAttachment.createMany({
          data: attachments.map((a: any) => ({ contractId: id, fileName: a.fileName, url: a.url, size: a.size })),
        });
      }
    }
    await this.logChanges(before, { ...before, ...rest }, user);
    return this.findOne(contract.id);
  }

  private async logChanges(before: any, after: any, user: any) {
    const diffs: any[] = [];
    for (const field of Object.keys(FIELD_LABELS)) {
      let b = before[field];
      let a = after[field];
      if (field === 'signDate') {
        b = fmtDate(b);
        a = fmtDate(a);
      }
      if (b instanceof Date) b = fmtDate(b);
      if (a instanceof Date) a = fmtDate(a);
      if (String(b ?? '') !== String(a ?? '')) {
        diffs.push({
          contractId: before.id,
          field,
          fieldLabel: FIELD_LABELS[field],
          beforeValue: String(b ?? ''),
          afterValue: String(a ?? ''),
          operatorId: user?.userId,
          operator: user?.realName || user?.username,
        });
      }
    }
    if (diffs.length) await this.prisma.contractChangeLog.createMany({ data: diffs });
  }

  async changes(id: string) {
    return this.prisma.contractChangeLog.findMany({ where: { contractId: id }, orderBy: { createdAt: 'desc' } });
  }

  async remove(id: string, projectId: string) {
    const exists = await this.prisma.contract.findFirst({ where: { id, projectId }, select: { id: true } });
    if (!exists) throw new NotFoundException('合同不存在');
    await this.assertNotArchived(id, '删除合同');
    /**
     * 有下游单据的合同不允许物理删除（改为归档）：新表外键为 Restrict，
     * 不先拦会由数据库抛 500；这里给出可操作的 400 提示。
     */
    const chainIds = await contractChainIds(this.prisma, id);
    const [receipts, settlements, daily, finals, invoices, payments] = await Promise.all([
      this.prisma.receiptOrder.count({ where: { projectId, materialContractId: { in: chainIds } } }),
      this.prisma.settlement.count({ where: { projectId, contractId: { in: chainIds } } }),
      this.prisma.dailyReport.count({ where: { projectId, contractId: { in: chainIds } } }),
      this.prisma.finalSettlement.count({ where: { projectId, contractId: { in: chainIds } } }),
      this.prisma.invoice.count({ where: { projectId, contractId: { in: chainIds } } }),
      this.prisma.paymentRecord.count({ where: { projectId, contractId: { in: chainIds } } }),
    ]);
    if (receipts + settlements + daily + finals + invoices + payments > 0) {
      throw new BadRequestException('存在下游单据（收领单/总日报/结算/总结算/发票/付款），不能删除合同，请改为归档');
    }
    await this.prisma.contract.delete({ where: { id } });
    return true;
  }

  // ==================== 合同起草（需求 2.1） ====================

  /** 草稿判定：执行情况为 DRAFT 或尚未填写，且为当前用户创建（projectId 缺省时不限项目） */
  private draftWhere(userId: string, projectId?: string, status?: string) {
    // 需求 2.3：起草菜单仅保留未完成草稿（status=DRAFT 或历史遗留空状态），
    // 已发布/已完成合同统一展示在「合同查询」
    const where: any = { createdBy: userId };
    if (projectId) where.projectId = projectId;
    if (status) {
      where.OR = [{ status }, { status: null, execStatus: CONTRACT_EXECUTION_STATUS.DRAFT }];
      if (status === CONTRACT_STATUS.DRAFT) where.OR.push({ status: null, execStatus: null });
    }
    return where;
  }

  /** 当前用户的草稿列表（数据隔离：仅本人创建；需求 2.3 默认仅返回未完成草稿） */
  async findDrafts(userId: string, projectId?: string, status?: string) {
    return this.prisma.contract.findMany({
      where: this.draftWhere(userId, projectId, status || CONTRACT_STATUS.DRAFT),
      orderBy: { updatedAt: 'desc' },
      include: { supplier: { select: { id: true, name: true } } },
    });
  }

  /** 删除草稿：仅本人创建且未提交的合同可删（物理删除，草稿无关联业务数据） */
  async removeDraft(id: string, userId: string) {
    const c = await this.prisma.contract.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('草稿不存在');
    if (c.createdBy !== userId) throw new BadRequestException('只能删除本人创建的草稿');
    if (c.execStatus && c.execStatus !== CONTRACT_EXECUTION_STATUS.DRAFT) throw new BadRequestException('该合同已提交，不能作为草稿删除');
    await this.prisma.contract.delete({ where: { id } });
    return true;
  }

  // ==================== 合同查询（需求 2.2：已发布/正式合同） ====================

  /**
   * 合同查询列表：展示待签章/已签章的正式合同（发布后流转至此；历史空状态数据一并兼容展示）
   * 筛选：编号/名称关键词、供应商、签订日期范围
   */
  async findPublished(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const and: any[] = [{ projectId }];
    // 需求修正6：待签章/已签章；status=null 与历史 COMPLETED 数据一并兼容展示
    and.push({ OR: [{ status: { in: [...PUBLISHED_STATUSES, LEGACY_CONTRACT_STATUS_COMPLETED] } }, { status: null }] });
    if (query.keyword) {
      and.push({ OR: [{ code: { contains: query.keyword } }, { name: { contains: query.keyword } }] });
    }
    if (query.supplierId) and.push({ supplierId: query.supplierId });
    const signDate: any = {};
    if (query.signDateStart) signDate.gte = new Date(query.signDateStart);
    if (query.signDateEnd) signDate.lte = new Date(`${query.signDateEnd}T23:59:59`);
    if (Object.keys(signDate).length) and.push({ signDate });
    const where = { AND: and };
    const [list, total] = await Promise.all([
      this.prisma.contract.findMany({
        where,
        skip,
        take,
        orderBy: { updatedAt: 'desc' },
        include: { supplier: { select: { id: true, name: true } } },
      }),
      this.prisma.contract.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  /**
   * 是否属于「未发布（草稿中）」：判定口径与「合同起草」草稿列表（draftWhere）保持一致
   * 需求 2.2：草稿中不可导出 Word，待签章/已签章均可导出
   */
  private isDraftContract(c: { status?: string | null; execStatus?: string | null }) {
    if (c.status === CONTRACT_STATUS.DRAFT) return true;
    // 历史遗留：合同状态为空时，执行情况为 DRAFT 或同样为空，均视为起草中的草稿
    if (!c.status && (c.execStatus === CONTRACT_STATUS.DRAFT || !c.execStatus)) return true;
    return false;
  }

  /**
   * 导出 Word（.docx，需求 2.2）：按创建时选择的合同模板生成正文，
   * 占位符替换后包含「物料编码清单」「合同清单」两张子表，文件名 {合同名称}.docx
   */
  async exportWord(id: string, projectId: string) {
    const contract = await this.prisma.contract.findUnique({ where: { id } });
    if (!contract) throw new NotFoundException('合同不存在');
    if (contract.projectId !== projectId) throw new BadRequestException('合同不属于当前项目');
    // 状态准入（需求 2.2）：草稿中不可导出；待签章 / 已签章均可导出
    if (this.isDraftContract(contract)) {
      throw new BadRequestException('草稿中的合同不可导出，请先发布后再导出 Word 文件');
    }
    if (!contract.templateId) throw new BadRequestException('该合同未关联合同模板，无法导出');
    let manual: Record<string, any> = {};
    if (contract.formData) {
      try {
        manual = JSON.parse(contract.formData);
      } catch {
        /* formData 损坏时忽略，按空变量处理 */
      }
    }
    const gen = await this.templateSvc.generate(
      { templateId: contract.templateId, contractId: id, manual },
      projectId,
    );
    const html = gen.html;
    // 需求 2.2：导出 Word 必须包含「物料编码清单」「合同清单」两张子表；
    // 模板未放置表格占位符时，自动追加到正文末尾
    let body = html;
    if (!/<table/i.test(body)) {
      const tables = await this.templateSvc.buildMaterialTables(id);
      body += `<h2>附件一：物料编码清单</h2>${tables.codeTable}`;
      body += `<h2>附件二：合同清单</h2>${tables.itemTable}`;
    }
    const full = `<!DOCTYPE html><html><head><meta charset="utf-8" /><style>
      body { font-family: '宋体', SimSun, serif; font-size: 12pt; line-height: 1.8; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #000; padding: 4pt 6pt; font-size: 10.5pt; }
    </style></head><body>${body}</body></html>`;
    // html-to-docx 1.8 不支持单元格上的百分比宽度（<td style="width:50%"> 会抛 Invalid XML name: @w），
    // 转换前将 td/th 的百分比宽度按 600px 版心换算为像素宽度，保留原列宽比例
    const safeHtml = full.replace(
      /(<t[dh]\b[^>]*\bstyle=")([^"]*)(")/gi,
      (_m: string, pre: string, style: string, post: string) =>
        pre +
        style.replace(/width\s*:\s*([\d.]+)\s*%/gi, (_s: string, p: string) =>
          `width: ${Math.round(parseFloat(p) * 6)}px`,
        ) +
        post,
    );
    let buffer = (await HTMLtoDOCX(safeHtml, null, { table: { row: { cantSplit: true } } })) as Buffer;

    // 功能四：页面设置（页边距/页眉/页码）底层 docx 补丁
    if (gen.pageSetup) {
      try {
        const ps = typeof gen.pageSetup === 'string' ? JSON.parse(gen.pageSetup) : gen.pageSetup;
        if (ps && (ps.margin || ps.header || ps.footerFormat)) {
          // 解析页眉中的 {变量名}
          const values: Record<string, any> = (gen as any).values || {};
          let headerText = ps.header || '';
          Object.entries(values).forEach(([k, v]) => {
            headerText = headerText.split(`{${k}}`).join(String(v ?? ''));
          });
          buffer = await patchDocx(buffer, { ...ps, header: headerText });
        }
      } catch {
        /* 页面设置解析失败时忽略，仍导出基础 docx */
      }
    }
    // 需求 2.2：导出文件名使用完整合同名称
    return { buffer, filename: `${contract.name}.docx` };
  }

  // ==================== 合同签章（需求修正4） ====================

  private static readonly SIGNED_ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.docx'];
  private static readonly SIGNED_MAX_SIZE = 20 * 1024 * 1024;

  /**
   * 上传签章合同（需求修正4 / 需求 2.3）：保存文件 + 记录签订日期/备注，状态置为「已签章」
   * - 本次选择的签订日期直接覆盖合同主表 signDate（原值有则覆盖、无则写入）
   * - signedDate 保留同一日期以兼容历史逻辑，signedAt 记录本次签章操作时间
   * - 支持重复上传覆盖旧文件，并允许修改签订日期
   */
  async sign(id: string, file: any, signDate?: string, remark?: string) {
    await this.assertNotArchived(id, '签章');
    if (!file) throw new BadRequestException('请上传签章合同文件');
    await this.assertContractExists(id);
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ContractService.SIGNED_ALLOWED_EXT.includes(ext)) {
      throw new BadRequestException('签章文件仅支持 PDF/JPG/PNG/DOCX 格式');
    }
    if (file.size > ContractService.SIGNED_MAX_SIZE) {
      throw new BadRequestException('签章文件大小不能超过 20MB');
    }
    if (!signDate) throw new BadRequestException('请选择签订日期');
    const chosen = new Date(signDate);
    if (Number.isNaN(chosen.getTime())) throw new BadRequestException('签订日期格式不正确');
    // 落盘统一走 StorageService（相对键 `signed/<文件名>`；目录/命名/URL 规则都收在存储层）
    const saved = await this.storage.save(file.buffer, { sub: 'signed', ext });
    /**
     * 冻结**签订时点的供应商信息快照**（业务口径 2026-10-15）：
     * 合同正文导出取快照而非当前主数据，否则供应商改名/换银行会改变历史合同的再导出内容。
     * 每次签章（含重新签章）都刷新为当时的主数据。
     */
    const forSnapshot = await this.findOne(id);
    const supplierSnapshot = JSON.stringify(pickSupplierSnapshot(forSnapshot?.supplier));
    await this.prisma.contract.update({
      where: { id },
      data: {
        supplierSnapshot,
        signedFilePath: saved.key,
        signedFileName: file.originalname,
        signDate: chosen, // 需求 2.3：覆盖合同主表签订日期
        signedDate: chosen, // 兼容历史展示逻辑
        signedAt: new Date(), // 签章操作时间
        signedRemark: remark || null,
        status: CONTRACT_STATUS.SIGNED,
        version: { increment: 1 },
      },
    });
    // 合同签章 → 同步采购任务状态（主合同则为「已完成」）
    await this.syncLinkedTaskStatus(id);
    return this.findOne(id);
  }

  /** 下载签章合同文件（按合同 ID 返回文件流） */
  async signedFile(id: string) {
    const c = await this.prisma.contract.findUnique({ where: { id } });
    if (!c?.signedFilePath) throw new NotFoundException('该合同尚未上传签章文件');
    if (!(await this.storage.exists(c.signedFilePath))) throw new NotFoundException('签章文件已丢失，请重新上传');
    const buffer = await this.storage.read(c.signedFilePath);
    return { buffer, filename: c.signedFileName || c.signedFilePath.split('/').pop() || 'signed' };
  }

  async saveExt(contractId: string, data: any, tx?: TxClient) {
    if (!tx) await this.assertNotArchived(contractId, '修改合同扩展信息');
    const db: any = tx || this.prisma;
    await this.dict.validate('procurement_source', data.procurementSrc);
    await this.dict.validate('is_direct_purchase', data.isDirectPurchase);
    await this.dict.validate('supplier_category', data.supplierCategory);
    const payload: any = {
      financeCode: data.financeCode,
      procurementSrc: data.procurementSrc,
      isDirectPurchase: data.isDirectPurchase,
      bidName: data.bidName,
      currentPayRatio: num(data.currentPayRatio),
      // 月度结算办理比例：仅「自定义付款安排」时使用（标准安排的比例由安排本身决定）
      settlementPayRatio: num(data.settlementPayRatio),
      supplierCategory: data.supplierCategory,
      bidStartDate: data.bidStartDate ? new Date(data.bidStartDate) : null,
      bidWinDate: data.bidWinDate ? new Date(data.bidWinDate) : null,
      disclosureDate: data.disclosureDate ? new Date(data.disclosureDate) : null,
      complaint: data.complaint,
    };
    const exist = await db.contractExt.findUnique({ where: { contractId } });
    const saved = exist
      ? await db.contractExt.update({ where: { contractId }, data: payload })
      : await db.contractExt.create({ data: { contractId, ...payload } });
    // 付款安排能推出比例时，`currentPayRatio` 一律以派生值为准（前端已改成只读展示）
    await this.syncPayRatio(contractId, tx);
    return saved;
  }

  async getExt(contractId: string) {
    return this.prisma.contractExt.findUnique({ where: { contractId } });
  }

  // ---------------- Excel ----------------
  /**
   * 批量导入（需求 2.1）：全成功或全失败
   * 先全量校验（必填 + 合同编号唯一 + 供应商关联），任一失败不写库；全部通过后在事务内写入
   */
  async import(buffer: Buffer, projectId: string, user: any, fileName?: string) {
    const rows = await this.excel.parse(buffer, [2]);
    const resolve = async (type: string, val: any) => {
      if (!val) return null;
      const items = await this.dict.options(type);
      const hit = items.find((i: any) => i.itemCode === val || i.itemName === val);
      return hit ? hit.itemCode : null;
    };
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'contract', moduleName: '合同台账', projectId, fileName, userId: user?.userId, username: user?.username }, rows, {
      plan: async (r) => {
        const code = String(r['合同编号'] ?? '').trim();
        if (!code) throw new RowError('合同编号为必填项', '合同编号');
        notDup(code, `批内重复：合同编号 ${code} 在导入文件中出现多次`, '合同编号');
        const { exists } = await this.checkCode(code, projectId);
        if (exists) throw new RowError(`唯一性校验失败：合同编号 ${code} 已存在`, '合同编号');
        const supplierName = String(r['供应商'] ?? '').trim();
        if (!supplierName) throw new RowError('供应商为必填项', '供应商');
        const supplier = await this.prisma.supplier.findFirst({ where: { name: supplierName } });
        if (!supplier) throw new RowError(`关联校验失败：供应商库中不存在「${supplierName}」`, '供应商');
        const amount = num(r['合同额']);
        if (amount === null) throw new RowError('合同额为必填数字', '合同额');
        const taxRaw = num(r['税率(%)']) ?? num(r['税率']);
        return {
          code,
          name: r['合同名称'] || code,
          typeCode: await resolve('contract_type', r['合同类型']),
          supplierId: supplier.id,
          signDate: r['签订日期'] || null,
          amount,
          taxRate: taxRaw !== null ? (taxRaw > 1 ? taxRaw / 100 : taxRaw) : null,
          remark: r['备注'] || null,
        };
      },
      write: async (plans, tx: TxClient) => {
        for (const p of plans) await this.create(p, projectId, user, tx);
        return { created: plans.length };
      },
    });
  }

  /** 合同台账填写模板（需求 3.3，实际字段口径） */
  async template(projectId: string) {
    const types = await this.dict.options('contract_type');
    const columns: TemplateColumn[] = [
      { label: '合同编号', key: 'code', required: true, width: 20, example: 'HT-2026-0001', desc: '项目内唯一，按编号规则填写' },
      { label: '合同名称', key: 'name', required: true, width: 28, example: '螺纹钢采购合同' },
      { label: '合同类型', key: 'typeCode', type: 'select', width: 16, example: '采购合同', options: types.map((i: any) => i.itemName).filter(Boolean) },
      { label: '供应商', key: 'supplier', required: true, width: 26, example: '某某钢铁贸易有限公司', desc: '须为供应商库中已存在的供应商名称' },
      { label: '签订日期', key: 'signDate', type: 'date', width: 14, example: '2026-08-20' },
      { label: '合同额', key: 'amount', required: true, type: 'money', width: 16, example: 6900000 },
      { label: '税率(%)', key: 'taxRatePct', type: 'number', width: 10, example: 13, desc: '百分比数字，常见值 13、9、6、3、1' },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '合同台账', sheetName: '数据', columns });
  }
}

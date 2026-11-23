import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '@cms/calc/numeric';
import { toDate } from '@cms/calc/time';
import { assertInProject, assertVersion, buildResult, paginate, versionedUpdate } from '../../common/utils/helpers';
import { round2, round4 } from '@cms/calc/money';
import { calcPriceWithTax, calcTotalWithTax } from '@cms/calc/amounts';

import { TxClient } from '../../common/services/import-runner.service';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict';
import { keywordWhere } from '../../common/utils/list-where';
/**
 * 发票/收领单的 `settlementId` 挂接关系**归各自模块所有**（第 22 轮审计 P3）：
 * 结算单只描述「按结算期把谁挂上来」的意图，实际写表走这两个模块的公开入口。
 *
 * 但 invoice / receipt-order 反过来静态依赖 settlement（`InvoiceService` / `ReceiptOrderService`
 * 注入 `SettlementService`），静态互引会让模块级依赖图成环（`scripts/check-module-boundaries.mjs`
 * 的 SCC 检查会拦），所以这里改成**调用时动态加载**：Node 会缓存模块实例，只有首次多一次 Promise。
 */
const invoiceWrites = () => import('../invoice');
const receiptOrderWrites = () => import('../receipt-order');

async function attachInvoicesToSettlement(db: any, ids: string[], settlementId: string): Promise<number> {
  return (await invoiceWrites()).attachInvoicesToSettlement(db, ids, settlementId);
}
async function detachInvoices(db: any, ids: string[], projectId?: string): Promise<number> {
  return (await invoiceWrites()).detachInvoices(db, ids, projectId);
}
async function detachInvoicesOfSettlement(db: any, settlementId: string): Promise<number> {
  return (await invoiceWrites()).detachInvoicesOfSettlement(db, settlementId);
}
async function attachReceiptOrdersToSettlement(db: any, ids: string[], settlementId: string): Promise<number> {
  return (await receiptOrderWrites()).attachReceiptOrdersToSettlement(db, ids, settlementId);
}
async function detachReceiptOrders(db: any, ids: string[], projectId?: string): Promise<number> {
  return (await receiptOrderWrites()).detachReceiptOrders(db, ids, projectId);
}
async function detachReceiptOrdersOfSettlement(db: any, settlementId: string): Promise<number> {
  return (await receiptOrderWrites()).detachReceiptOrdersOfSettlement(db, settlementId);
}
import { assertSettlementProgress, assertSettlementRejectable, SETTLEMENT_STATUS, SITE_CONFIRM_STATUS } from '../../constants/workflowGuards';
// 总结算单状态常量（第 21 轮审计：不要再裸写 'SETTLED'）；发票金额口径统一走 countedInvoiceWhere（作废/红冲不计入）
import { FINAL_SETTLEMENT_STATUS, countedInvoiceWhere } from '../../constants/statuses';
import { buildSettlementItemsFromDailyRows } from './settlement-from-daily';
import { buildSettlementItemsFromReceiptOrders } from './settlement-from-receipts';
import { SysParamService } from '../../common/services/sys-param.service';
import { ContractLockService } from '../../common/services/contract-lock.service';
import { ProjectScopeService } from '../../common/services/project-scope.service';
import { SettlementLedgerService } from './settlement-ledger.service';
import { normalizePolicy, checkOverAmount } from '../../domain/amount-guard';
// 链口径（合同当前金额 / 累计结算 / 累计付款）统一在 contract-chain：防超结的上限与
// 业务口径「合同当前金额 = 主合同 + 补充协议增量」必须是同一个实现
import {
  contractChainAmount,
  chainSettledTotal,
  chainMaterialQty,
  chainSettledItemQty,
} from '../../query';
// 月份归集口径（`YYYY-MM`）与结算期纯函数：台账、发票/收领单自动匹配、月度结算期三处**共用**，
// 不要在各服务里各写一份 `getFullYear/getMonth` 拼接
import {
  monthKey,
  periodMonthKey,
  periodKeyOf,
  startDayOf,
  formatDay,
  currentSettlementPeriod,
  previousSettlementPeriod,
} from '../../domain/settlement-period';

const SETTLE_FIELDS = [
  'projectId', 'contractId', 'code', 'typeCode', 'amount', 'deductAmount', 'actualAmount',
  'settleDate', 'statusCode', 'remark',
];
/** update 白名单：不含 projectId —— 归属只能由 create 决定 */
const SETTLE_UPDATE_FIELDS = SETTLE_FIELDS.filter((f) => f !== 'projectId');
/** 清单项级结算明细的写字段白名单（items 随结算单 body 一并传） */
const SETTLEMENT_ITEM_FIELDS = ['materialBaseId', 'qty', 'priceBeforeTax', 'taxRatePct', 'remark', 'sortOrder'];

@Injectable()
export class SettlementService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private sysParam: SysParamService,
    private lock: ContractLockService,
    private scope: ProjectScopeService,
    private ledger: SettlementLedgerService,
  ) {}

  // ==================== 结算台账（已抽离至 SettlementLedgerService，此处保留同名转发） ====================
  // P1-3：台账自动字段/CRUD/导出导入整体拆入 SettlementLedgerService；控制器与
  // finance / invoice / receipt-order / archive 等外部调用点保持不变（走这里的转发）。

  async syncLedgerByContract(contractId: string, tx?: TxClient) {
    return this.ledger.syncLedgerByContract(contractId, tx);
  }

  async refreshLedger(projectId: string) {
    return this.ledger.refreshLedger(projectId);
  }

  async findLedger(query: any = {}, projectId: string, maxPageSize = 500) {
    return this.ledger.findLedger(query, projectId, maxPageSize);
  }

  async ledgerOne(id: string, projectId?: string) {
    return this.ledger.ledgerOne(id, projectId);
  }

  async createLedger(data: any, projectId: string, tx?: TxClient, opts?: { fromImport?: boolean }) {
    return this.ledger.createLedger(data, projectId, tx, opts);
  }

  async updateLedger(id: string, data: any, projectId?: string) {
    return this.ledger.updateLedger(id, data, projectId);
  }

  async removeLedger(id: string, projectId?: string) {
    return this.ledger.removeLedger(id, projectId);
  }

  async exportComplianceSheet(contractId: string, projectId: string, year?: number, month?: number) {
    return this.ledger.exportComplianceSheet(contractId, projectId, year, month);
  }

  async exportLedger(projectId: string, settleMonth?: string) {
    return this.ledger.exportLedger(projectId, settleMonth);
  }

  async templateLedger(projectId: string) {
    return this.ledger.templateLedger(projectId);
  }

  async importLedger(
    buffer: Buffer,
    projectId: string,
    meta?: { fileName?: string; user?: any; validateOnly?: boolean; mode?: string },
  ) {
    return this.ledger.importLedger(buffer, projectId, meta);
  }


  // ---------------- 结算单 ----------------

  /**
   * 防超结校验（口径见 .claude/rules/backend-conventions.md「金额上限」）：累计结算（含补充协议链、排除草稿与自身）+ 本次 ≤ 合同链金额。
   * 策略取系统参数 `settlement.over_amount_policy`（BLOCK 拦截 / WARN 仅提示 / OFF 不校验，默认 WARN）。
   *
   * ⚠️ 仅在**交互式写入**（无 tx）且结果状态非草稿时执行：事务内不得调用 `sysParam`
   *    （它用事务外的 PrismaClient 连接，连接池耗尽会挂起，见 receipt-order.service 同款说明）；
   *    草稿只是暂存，不构成已发生结算，故不计入上限。
   */
  private async checkOverSettlement(
    contractId: string | null | undefined,
    currentAmount: number,
    excludeId?: string,
  ): Promise<{ overAmountWarning?: string }> {
    if (!contractId) return {};
    const policy = normalizePolicy(await this.sysParam.get('settlement.over_amount_policy', 'WARN'));
    if (policy === 'OFF') return {};
    const [limit, used] = await Promise.all([
      contractChainAmount(this.prisma, contractId),
      chainSettledTotal(this.prisma, contractId, excludeId),
    ]);
    const res = checkOverAmount({ limit, used, current: currentAmount, label: '结算' });
    if (!res.exceeded) return {};
    if (policy === 'BLOCK') throw new BadRequestException(res.message);
    console.warn('[结算/防超结]', res.message);
    return { overAmountWarning: res.message };
  }

  /** 结果状态是否为草稿（草稿不参与防超结校验） */
  private isDraft(statusCode: any): boolean {
    return String(statusCode ?? SETTLEMENT_STATUS.DRAFT) === SETTLEMENT_STATUS.DRAFT;
  }

  // ---------------- 清单项级结算明细（业务 2026-10-17） ----------------

  /** 明细行归一化：白名单 + 数值清洗 + 服务端重算综合单价/合价（不信任前端） */
  private normalizeItem(d: any, index: number) {
    const out: any = pickFields(d, SETTLEMENT_ITEM_FIELDS, { label: '结算明细' });
    out.qty = out.qty === null ? null : round4(out.qty);
    out.priceBeforeTax = num(out.priceBeforeTax);
    out.taxRatePct = num(out.taxRatePct);
    // 税率未填时沿用旧口径：按 0% 处理（含税单价 = 税前单价），不把整行置空
    out.priceWithTax = calcPriceWithTax(out.priceBeforeTax, out.taxRatePct ?? 0, 4);
    out.totalWithTax = calcTotalWithTax(out.priceWithTax, out.qty, 2);
    out.sortOrder = out.sortOrder ?? index + 1;
    return out;
  }

  /**
   * **量级校验闸门**（清单项级，业务 2026-10-17）：
   * Σ(本单明细 qty) + 链上历史已结算明细量 ≤ 合同链清单量（`chainMaterialQty`）。
   * 策略复用 `settlement.over_amount_policy`（BLOCK 拦截 / WARN 提示 / OFF 不校验，默认 WARN）；
   * 链上某物资**无清单行 = 无上限**（与金额口径「无金额=无上限」一致，不拦）。
   * ⚠️ 仅在**非草稿**且**无外部事务**时执行（事务内不得调 sysParam，同 checkOverSettlement）。
   */
  private async checkOverSettlementQty(
    contractId: string | null | undefined,
    items: any[],
    excludeId?: string,
  ): Promise<{ overQtyWarning?: string }> {
    if (!contractId || !items.length) return {};
    const policy = normalizePolicy(await this.sysParam.get('settlement.over_amount_policy', 'WARN'));
    if (policy === 'OFF') return {};
    const [baselines, used] = await Promise.all([
      chainMaterialQty(this.prisma, contractId),
      chainSettledItemQty(this.prisma, contractId, excludeId),
    ]);
    const incoming = new Map<string, number>();
    for (const it of items) {
      if (!it.materialBaseId) continue;
      incoming.set(it.materialBaseId, (incoming.get(it.materialBaseId) || 0) + (Number(it.qty) || 0));
    }
    const names = items.length
      ? await this.prisma.materialBase.findMany({
          where: { id: { in: [...incoming.keys()] } },
          select: { id: true, name: true, spec: true },
        })
      : [];
    const nameOf = new Map(names.map((n: any) => [n.id, `${n.name} / ${n.spec || '-'}`]));
    const overs: string[] = [];
    for (const [mid, qty] of incoming) {
      const baseline = baselines.get(mid);
      if (baseline === undefined) continue; // 链上无清单行 = 无上限
      const already = used.get(mid) || 0;
      if (already + qty > baseline) {
        overs.push(`${nameOf.get(mid) || mid}（已结 ${already} + 本单 ${qty} ＞ 清单 ${baseline}）`);
      }
    }
    if (!overs.length) return {};
    const message = `结算量超过合同清单量：${overs.join('；')}`;
    if (policy === 'BLOCK') throw new BadRequestException(message);
    console.warn('[结算/量级闸门]', message);
    return { overQtyWarning: message };
  }

  /**
   * 同事务内整体替换明细（replace-all 语义，随 create/update 一起写）；
   * 返回明细行（含服务端重算的价格）。
   */
  private async syncItems(settlementId: string, items: any[], db: any) {
    const list = Array.isArray(items) ? items : [];
    /**
     * 无物资主数据的行**不许静默丢弃**（第 24 轮审计）：原来 `filter(d => d?.materialBaseId)`
     * 把这类行悄悄扔掉——提交方以为明细存进去了，实际少行、金额对不上，比报错更难查。
     * 校验放在 deleteMany **之前**：报错时库内既有明细原样保留。
     */
    const badIdx = list.findIndex((d: any) => !d?.materialBaseId);
    if (badIdx >= 0) {
      throw new BadRequestException(
        `结算明细第 ${badIdx + 1} 行缺少物资（materialBaseId）：明细必须挂物资主数据，` +
          '否则量级校验与开累统计都无从计算。请先补齐物资再保存。',
      );
    }
    await db.settlementItem.deleteMany({ where: { settlementId } });
    if (!list.length) return [];
    await db.settlementItem.createMany({
      data: list.map((d: any, i: number) => ({
        ...this.normalizeItem(d, i),
        settlementId,
      })),
    });
    return db.settlementItem.findMany({
      where: { settlementId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * 结算明细的来源行：该结算单**已挂收领单**的明细（明细缺失的收领单退回它推送的总日报行）。
   * 业务口径 2026-11-21：明细不再是"只有自动生成才带得出来"，挂上收领单就能落明细。
   */
  private async loadItemSourceOrders(settlementId: string) {
    const orders: any[] = await this.prisma.receiptOrder.findMany({
      where: { settlementId },
      orderBy: [{ orderDate: 'asc' }, { orderNo: 'asc' }],
      select: {
        id: true,
        orderNo: true,
        details: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            materialId: true,
            receivedQty: true,
            priceBeforeTax: true,
            taxRatePct: true,
            priceWithTax: true,
            totalPrice: true,
          },
        },
      },
    });
    if (!orders.length) return [];
    // 兜底来源：这些收领单推送出去的总日报行（同一次查询批量取，避免 N+1）
    const dailyRows: any[] = await this.prisma.dailyReport.findMany({
      where: { receiptOrderId: { in: orders.map((o) => o.id) } },
      select: {
        receiptOrderId: true,
        materialBaseId: true,
        materialName: true,
        receiptNo: true,
        settleQty: true,
        priceBeforeTax: true,
        taxRatePct: true,
        priceAfterTax: true,
        amountBeforeTax: true,
        amountAfterTax: true,
      },
    });
    const byOrder = new Map<string, any[]>();
    for (const r of dailyRows) {
      const key = r.receiptOrderId as string;
      byOrder.set(key, [...(byOrder.get(key) || []), r]);
    }
    return orders.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      details: o.details || [],
      dailyRows: byOrder.get(o.id) || [],
    }));
  }

  /**
   * **预览**按已挂收领单能带出的结算明细（只算不写）。
   * 供编辑器「按收领单带出明细」先看结果：明细合计与表头金额的差额一起返回，
   * 差额非 0 时由前端提示（本功能**不改表头金额**，金额仍以人工录入为准）。
   */
  async previewItemsFromReceipts(id: string, projectId?: string) {
    const s: any = await this.findOne(id, projectId);
    const orders = await this.loadItemSourceOrders(id);
    const built = buildSettlementItemsFromReceiptOrders(orders);
    return this.itemsFromReceiptsPayload(s, built);
  }

  /**
   * **落库**：按已挂收领单重建该结算单的明细（replace-all，与 syncItems 同语义）。
   *
   * 三条边界（业务口径 2026-11-21）：
   * 1. 只写明细，**不动表头金额/扣款/状态**——金额可能已定稿甚至已结算，
   *    服务端不该悄悄改；差额由返回值给出，人工确认后自行调整。
   * 2. 没有已挂收领单、或收领单带不出任何明细 → 直接 400，**绝不清空**既有明细
   *    （空结果清空会被误当成"按收领单重算"的正常结果）。
   * 3. 不做量级闸门：闸门是「提交结算」时的事（`checkOverSettlementQty`），
   *    这里的明细会参与后续提交校验，故本方法保持幂等、可反复调用。
   */
  async rebuildItemsFromReceipts(id: string, projectId?: string) {
    const s: any = await this.findOne(id, projectId);
    await this.lock.assertWritable(s.contractId, '按收领单带出结算明细');
    const orders = await this.loadItemSourceOrders(id);
    if (!orders.length) {
      throw new BadRequestException('该结算单还没有挂接收领单，无法带出明细；请先在收领单上选择结算单');
    }
    const built = buildSettlementItemsFromReceiptOrders(orders);
    if (!built.items.length) {
      const why = built.ordersWithoutItems.length
        ? `（${built.ordersWithoutItems.join('、')} 的明细缺少物资主数据或实收数量为空）`
        : '';
      throw new BadRequestException(`已挂收领单带不出可用明细${why}，请先在收领单上补全物资与实收数量`);
    }
    const rows: any[] = await this.prisma.$transaction((t) => this.syncItems(id, built.items, t));
    return { ...this.itemsFromReceiptsPayload(s, built), items: rows, saved: true };
  }

  /** 预览/落库共用的返回体（口径一致，避免两处各拼一遍） */
  private itemsFromReceiptsPayload(s: any, built: ReturnType<typeof buildSettlementItemsFromReceiptOrders>) {
    const headerAmount = num(s.actualAmount);
    return {
      settlementId: s.id,
      code: s.code,
      contractId: s.contractId,
      /** 表头金额（actualAmount）：本功能不改它 */
      headerAmount,
      /** 明细合计（Σ 合价，与落到明细行上的 totalWithTax 同口径） */
      itemsAmount: built.amount,
      /** 差额 = 明细合计 − 表头金额；非 0 说明明细与人工录入的金额不一致，需人工核对 */
      // headerAmount 可空（表头未填）：此时差额无意义，返回 null 让前端显示「—」而不是假 0
      diff: headerAmount === null ? null : round2(built.amount - headerAmount),
      items: built.items,
      receiptOrderCount: built.receiptOrderCount,
      detailRowCount: built.detailRowCount,
      dailyFallbackOrderCount: built.dailyFallbackOrderCount,
      ordersWithoutItems: built.ordersWithoutItems,
      skippedRowCount: built.skippedRowCount,
      skippedNames: built.skippedNames,
      skippedNoQtyRowCount: built.skippedNoQtyRowCount,
      skippedNetZeroRowCount: built.skippedNetZeroRowCount,
      skippedInvalidPriceRowCount: built.skippedInvalidPriceRowCount,
    };
  }

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.statusCode) where.statusCode = query.statusCode;
    const kw = keywordWhere(['code', 'contract.name'], query.keyword);
    if (kw) where.OR = kw.OR;
    const [list, total] = await Promise.all([
      this.prisma.settlement.findMany({
        where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: { contract: { select: { id: true, code: true, name: true, supplierId: true, supplier: { select: { id: true, name: true } } } } },
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string, projectId?: string) {
    const s = await this.prisma.settlement.findUnique({
      where: { id },
      include: {
        contract: true,
        items: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: { materialBase: { select: { id: true, name: true, spec: true, unit: true } } },
        },
      },
    });
    // 防御纵深：路由层已按项目校验成员关系，这里再核一次归属，避免按 id 直读跨项目单据。
    // 用结算单自身的 projectId 判定：contractId 可空（无合同结算单同样要能打开），
    // 走 contract.projectId 会把合法的无合同单据误判成「不存在」。
    return assertInProject(s, projectId, '结算单不存在');
  }

  async create(data: any, projectId: string, tx?: TxClient) {
    /**
     * 状态缺省为**草稿**：`Settlement.statusCode` 可空，而 `isDraft(null)` 会把空状态当草稿
     * 跳过防超结闸门、`notDraft` 又把 NULL 当非草稿计入累计/审定 —— 两边相反，
     * 不传状态就能"不计闸门但计入已结"。新写入一律落一个明确状态，NULL 只留给历史数据。
     */
    data = { ...data, statusCode: data.statusCode ?? SETTLEMENT_STATUS.DRAFT };
    await this.lock.assertWritable(data.contractId, '新增结算单');
    // 引用合同必须属于当前项目（防 projectId=A、contractId=B 的跨项目串数据）
    await this.scope.assertContractInProject(data.contractId, projectId, '合同');
    await this.dict.validate('settlement_type', data.typeCode);
    await this.dict.validate('settlement_status', data.statusCode);
    // 新建没有「迁移」可言，状态迁移守卫只在 update() 里做（见 assertSettlementProgress）
    // 同合同同月唯一（业务口径 2026-10-16，见 assertMonthUniqueForContract 的说明）
    await this.assertMonthUniqueForContract(data.contractId, data.settleDate);
    const actual = data.actualAmount ?? (num(data.amount) || 0) - (num(data.deductAmount) || 0);
    // 防超结：仅交互式写入（非事务）且非草稿时校验
    const warn =
      tx || this.isDraft(data.statusCode)
        ? {}
        : await this.checkOverSettlement(data.contractId, num(actual) ?? 0);
    // 清单项级量级闸门（同防超结口径：非事务、非草稿才校验）
    // ⚠️ 校验用「过滤后的 items」（无物资的行不参与量级），但**落库传原始 items**：
    //    否则缺物资的行会被这里先滤掉，`syncItems` 的校验永远看不到它，
    //    replace-all 反而把既有明细删光（第 24 轮审计实测踩到）。
    const rawItems: any[] = Array.isArray(data.items) ? data.items : [];
    const items: any[] = rawItems.filter((d: any) => d?.materialBaseId);
    const qtyWarn =
      tx || this.isDraft(data.statusCode) ? {} : await this.checkOverSettlementQty(data.contractId, items);
    const created: any = await (async () => {
      /**
       * 单头 + 明细必须同一事务落库：`syncItems` 是「先删后插」的 replace-all，
       * 若 createMany 失败（如前端传了不存在的 materialBaseId 撞外键、数值超 Decimal 范围），
       * 无事务时要么留下「有单头、无明细」的孤儿结算单，要么（update 路径）把原明细删光。
       * 调用方已带 tx（如月度结算生成）时沿用它的连接，不再嵌套事务。
       */
      const write = async (db: any) => {
        // 并发防重：先取「合同 + 结算期」事务级咨询锁，再在锁内复查同期唯一。
        // 外层预检只负责给出可读错误；真正的原子性在这里（见 lockSettlementPeriod）。
        await this.lockSettlementPeriod(db, data.contractId, data.settleDate);
        await this.assertMonthUniqueForContract(data.contractId, data.settleDate, undefined, db);
        const row: any = await db.settlement.create({
          data: {
            ...pickFields(data, SETTLE_FIELDS, { label: '结算单' }), projectId,
            amount: num(data.amount), deductAmount: num(data.deductAmount), actualAmount: num(actual),
            settleDate: toDate(data.settleDate),
          },
        });
        if (rawItems.length) await this.syncItems(row.id, rawItems, db);
        return row;
      };
      return tx ? write(tx) : this.prisma.$transaction((t) => write(t));
    })();
    /**
     * 结算单 → 台账（业务口径 2026-10-16：一结算单对应一行台账）。
     * ⚠️ 只在**无外部事务**时刷新：`computeLedgerAutoFields` 走 `this.prisma`（事务外连接），
     * 在事务里读不到尚未提交的结算单。事务内的调用方（如导入）需在提交后自行
     * 调 `refreshLedger(projectId)` 或 `syncLedgerByContract()`——导入路径已如此处理。
     */
    if (!tx && created?.contractId) {
      // 先补挂该合同本月尚未关联的发票/收领单（它们会进台账的「本月开票额」），再刷新台账
      await this.linkOrphansForContract(created.contractId);
      await this.syncLedgerByContract(created.contractId);
    }
    return { ...created, ...warn, ...qtyWarn };
  }

  async update(id: string, data: any, projectId?: string) {
    const before = await this.findOne(id, projectId);
    // 显式传 null = "不改状态"：空状态会让 isDraft / notDraft 给出相反结论，新写入不允许落 NULL
    data = { ...data };
    if (data.statusCode === null) delete data.statusCode;
    assertVersion(before, data);
    await this.lock.assertWritable(before.contractId, '修改结算单');
    if (data.contractId) {
      await this.scope.assertContractInProject(data.contractId, projectId ?? before.projectId, '合同');
    }
    if (data.contractId && data.contractId !== before.contractId) {
      await this.lock.assertWritable(data.contractId, '修改结算单');
    }
    await this.dict.validate('settlement_type', data.typeCode);
    await this.dict.validate('settlement_status', data.statusCode);
    // 状态迁移守卫（第 5 轮审计）：只允许沿链路前进，回退必须走 reject()
    if (data.statusCode !== undefined && data.statusCode !== null) {
      assertSettlementProgress(before.statusCode, data.statusCode);
    }
    // 同合同同月唯一（改日期/改合同都要校验，排除自身）
    await this.assertMonthUniqueForContract(
      data.contractId ?? before.contractId,
      data.settleDate ?? before.settleDate,
      id,
    );
    const payload: any = pickFields(data, SETTLE_UPDATE_FIELDS, { label: '结算单' });
    ['amount', 'deductAmount', 'actualAmount'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (data.settleDate) payload.settleDate = toDate(data.settleDate);
    delete payload.version;
    // 防超结：按「更新后」的状态与金额校验（草稿不校验）
    const resultingStatus = payload.statusCode ?? before.statusCode;
    const resultingActual =
      payload.actualAmount !== undefined
        ? num(payload.actualAmount)
        : payload.amount !== undefined || payload.deductAmount !== undefined
          ? (num(payload.amount ?? before.amount) || 0) - (num(payload.deductAmount ?? before.deductAmount) || 0)
          : num(before.actualAmount);
    const effectiveContractId = payload.contractId ?? before.contractId;
    const warn = this.isDraft(resultingStatus)
      ? {}
      : await this.checkOverSettlement(effectiveContractId, num(resultingActual) ?? 0, id);
    // 草稿 → 提交的转换：合同已「已完已结」时禁止（月度结算是总结算明细快照的来源）
    if (!this.isDraft(resultingStatus) && this.isDraft(before.statusCode)) {
      const settled = await this.prisma.finalSettlement.findFirst({
        where: { contractId: effectiveContractId, statusCode: FINAL_SETTLEMENT_STATUS.SETTLED },
        select: { id: true },
      });
      if (settled) {
        throw new BadRequestException('合同已完成总结算，月度结算不可再提交；如需调整请先作废总结算单');
      }
    }
    // 清单项级量级闸门：items 传入时按「更新后」校验（排除自身历史明细）。
    // ⚠️ 提交（非草稿）时**必须**校验，即使 body 不带 items——否则草稿期录入的超量明细
    //    可以靠「只传状态」的部分更新提交，绕过 BLOCK 策略（驳回-重提路径同理）。
    const rawItems: any[] = Array.isArray(data.items) ? data.items : [];
    const items: any[] = rawItems.filter((d: any) => d?.materialBaseId);
    if (this.isDraft(resultingStatus)) {
      // 草稿豁免（设计如此：草稿是暂存，不构成已发生结算）
    } else if (data.items) {
      await this.checkOverSettlementQty(effectiveContractId, items, id);
    } else {
      // 未带 items 的提交：按库中现存明细校验
      const existing = await this.prisma.settlementItem.findMany({
        where: { settlementId: id },
        select: { materialBaseId: true, qty: true },
      });
      await this.checkOverSettlementQty(
        effectiveContractId,
        existing.map((d) => ({ materialBaseId: d.materialBaseId, qty: d.qty })),
        id,
      );
    }
    // 单头与明细同一事务：明细 replace-all 失败时不能留下「单头已改、明细被删光」的半成品
    const updated: any = await this.prisma.$transaction(async (t) => {
      // 并发防重：旧期与新期都加锁（排序后获取）。改合同/改日期时两把都要，
      // 否则「A→B」与「B→A」两个方向并发会各自通过预检。
      const lockKeys = [
        await this.settlementPeriodLockKey(t, before.contractId, before.settleDate),
        await this.settlementPeriodLockKey(t, effectiveContractId, payload.settleDate ?? before.settleDate),
      ].filter(Boolean) as string[];
      await this.lockKeys(t, lockKeys);
      await this.assertMonthUniqueForContract(
        effectiveContractId,
        payload.settleDate ?? before.settleDate,
        id,
        t,
      );
      /**
       * 换合同：原来挂在本单上的发票/收领单属于**旧合同**，必须解绑。
       * 不解除会同时污染两边台账：旧合同的发票因 `settlementId` 非空不再计入旧行，
       * 新合同的台账却按 `settlementId` 把它算进「本月开票额」（一出一进，凭空串账）。
       * 提交后由下方 affected 循环重新挂载（各自按自己的合同 + 结算期）。
       */
      if (payload.contractId && payload.contractId !== before.contractId) {
        // 发票/收领单的 `settlementId` 归各自模块所有：写入走 invoice / receipt-order 的公开入口
        await detachInvoicesOfSettlement(t, id);
        await detachReceiptOrdersOfSettlement(t, id);
      }
      const row: any = await versionedUpdate(t.settlement, id, before.version, payload);
      if (data.items) await this.syncItems(id, rawItems, t);
      return row;
    });
    // 结算单 → 台账：改了日期/合同会影响两个月（旧月要解除关联并重算、新月要建行），故两边都刷。
    // 同理也要**重算发票/收领单的关联**（改了月份后，旧关联按新月份解绑、当月未关联的补挂）。
    const affected = new Set<string>([before.contractId, updated.contractId].filter(Boolean) as string[]);
    for (const cid of affected) {
      await this.linkOrphansForContract(cid);
      await this.syncLedgerByContract(cid);
    }
    return { ...updated, ...warn };
  }

  async remove(id: string, projectId?: string) {
    const before: any = await this.findOne(id, projectId);
    await this.lock.assertWritable(before.contractId, '删除结算单');
    /**
     * 已完成总结算（SETTLED）的合同，月度结算是总结算明细的唯一来源（第 5 轮审计）：
     * 删掉后明细的 settlementId 变 NULL、金额成无源快照，台账累计结算归零，
     * 但合同仍是 DONE_SETTLED + 付款比例 100% → 同一合同出现「已完已结 + 累计结算 0」。
     * update()/reject() 早就拦了这条，只有 remove() 漏了。
     */
    const settled = await this.prisma.finalSettlement.findFirst({
      where: { contractId: before.contractId, statusCode: FINAL_SETTLEMENT_STATUS.SETTLED },
      select: { id: true, code: true },
    });
    if (settled) {
      throw new BadRequestException(
        `合同已完成总结算（${settled.code || settled.id}），月度结算不可删除；请先在总结算单上作废并回退已结算状态`,
      );
    }
    await this.prisma.settlement.delete({ where: { id } });
    // 台账行上的 settlementId 由 DB 级 `SET NULL` 解除，随后重算该合同的台账
    // （该行会退回"仅费用行"形态：monthSettleAmount=0、settleCount=0）
    if (before?.contractId) await this.syncLedgerByContract(before.contractId);
    return true;
  }

  /**
   * 任务 7：结算驳回 → 回填（回退到「草稿」状态，可重新编辑提交）。
   * 纯状态回退；仅「已确认 / 已开票 / 已付款 / 已完成」等已提交状态可驳回。
   */
  async reject(id: string, projectId?: string, version?: number) {
    const before: any = await this.findOne(id, projectId);
    // 与 update 同语义：前端带回列表/详情里的 version 时必须一致（并发编辑 → 409）
    if (version !== undefined) assertVersion(before, { version });
    await this.lock.assertWritable(before.contractId, '驳回结算单');
    // 状态机守卫（单一事实源）：仅已提交（待确认及之后）可驳回回填，草稿不可重复驳回
    assertSettlementRejectable(before.statusCode);
    // 合同已「已完已结」（总结算附件已上传）时，月度结算是总结算明细的来源，
    // 驳回/修改会让 DONE_SETTLED 断言与底层链脱钩 → 必须先作废总结算单。
    const settled = await this.prisma.finalSettlement.findFirst({
      where: { contractId: before.contractId, statusCode: FINAL_SETTLEMENT_STATUS.SETTLED },
      select: { id: true, code: true },
    });
    if (settled) {
      throw new BadRequestException(
        `合同已完成总结算（${settled.code || settled.id}），月度结算不可驳回；请先在总结算单上作废并回退已结算状态`,
      );
    }
    await this.dict.validate('settlement_status', SETTLEMENT_STATUS.DRAFT);
    await this.prisma.settlement.update({
      where: { id },
      data: { statusCode: SETTLEMENT_STATUS.DRAFT, version: { increment: 1 } },
    });
    // 驳回后状态回到草稿 → 不再构成已发生结算：台账必须重刷（此前漏掉，
    // 台账「本月结算额/开票额」与结算单状态无限期矛盾），关联的发票/收领单
    // 也要按新月份重算归属（与 remove() 同一套收尾）。
    if (before.contractId) {
      await this.linkOrphansForContract(before.contractId);
      await this.syncLedgerByContract(before.contractId);
    }
    return this.findOne(id, projectId);
  }

  // ---------------- 结算期加锁 / 同合同同期唯一（结算写入守卫） ----------------


  /**
   * 事务级咨询锁：把「同一合同 + 同一结算期」的建单/改期串行化。
   *
   * `Settlement.settleDate` 是日期、结算期由项目起始日派生，**无法直接建唯一索引**；
   * 并发下「先查后写」的两个请求会同时通过预检、各插一张同期结算单，
   * 而台账 `monthSettleAmount` 会把两张相加（`settlementId` 却只挂一张）→ 结算额翻倍。
   *
   * 必须在**写入所在的同一事务**内调用：`pg_advisory_xact_lock` 随事务提交/回滚自动释放。
   */
  private async lockSettlementPeriod(db: any, contractId: string | null | undefined, settleDate: unknown) {
    const key = await this.settlementPeriodLockKey(db, contractId, settleDate);
    if (key) await this.lockKeys(db, [key]);
  }

  private async settlementPeriodLockKey(
    db: any,
    contractId: string | null | undefined,
    settleDate: unknown,
  ): Promise<string | null> {
    if (!contractId || !settleDate) return null;
    const owner = await db.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    const startDay = owner ? await this.startDayOf(owner.projectId, db) : 1;
    const period = periodKeyOf(startDay, settleDate as any);
    return period ? `${contractId}|${period}` : null;
  }

  /** 按排序后的键逐把加锁：同一事务要锁「旧期 + 新期」时，顺序一致才不会互相等待成死锁 */
  private async lockKeys(db: any, keys: string[]) {
    for (const key of [...new Set(keys)].sort()) {
      // pg_advisory_xact_lock 返回 void，Prisma 无法反序列化 void 列；
      // 用子查询只 SELECT 常量，锁仍由内层函数获取
      await db.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('settlement-period'), hashtext(${key})) AS lock_id) AS l`;
    }
  }

  /**
   * **同合同同月只允许一张结算单**（业务口径 2026-10-16）。
   *
   * 起因：台账已改为"一结算单对应一行台账"（`SettlementLedger.settlementId`），
   * 而同月里该行的结算额、发票额、资金费用都是按**月**归集的——同月两张结算单会让
   * 这些口径无法归属（要么重复计入，要么得引入分摊规则）。业务确认"不存在这种情况"，
   * 故在登记时就**报错拦住**，而不是静默合并。
   */
  private async assertMonthUniqueForContract(
    contractId: string | null | undefined,
    settleDate: unknown,
    excludeId?: string,
    db: any = this.prisma,
  ) {
    if (!contractId || !settleDate) return;
    /**
     * 判据是**账期**（期末所在月），不是自然月（第 23 轮审计）。
     * 起始日不是 1 日时，一期跨两个自然月（起始日 26 → 10/26–11/25），
     * 原来按自然月查重会让「10/28」和「11/20」两张单都通过校验 —— 同一期出现两张结算单，
     * 而发票/台账的「本月开票额」「本月结算额」都是按行（合同 × 账期）归集的，无从分摊。
     */
    const owner = await db.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    const startDay = owner ? await this.startDayOf(owner.projectId, db) : 1;
    const period = periodKeyOf(startDay, settleDate);
    if (!period) return;
    const same = await db.settlement.findMany({
      where: { contractId, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, code: true, settleDate: true },
    });
    const dup = same.find((r: any) => periodKeyOf(startDay, r.settleDate) === period);
    if (dup) {
      const span = currentSettlementPeriod(startDay, settleDate as string | Date);
      throw new BadRequestException(
        `该合同本期（${formatDay(span.start)} ~ ${formatDay(span.end)}，账期 ${period}）已有结算单` +
          `${dup.code ? `（${dup.code}）` : ''}：同一合同同一结算期只允许一张结算单。`,
      );
    }
  }


  // ---------------- 发票 / 收领单 ↔ 结算单 的关联（业务口径 2026-10-16） ----------------

  /** 项目的**月度结算起始日**（未设置 → 1，即自然月）；关联归属与生成结算都按它算期 */
  private async startDayOf(projectId: string, db: any = this.prisma): Promise<number> {
    const p = await db.project.findUnique({ where: { id: projectId }, select: { settlementStartDate: true } });
    return startDayOf(p?.settlementStartDate);
  }

  /**
   * 结算口径是否只认「已确认」的现场记录（系统参数 `settlement.require_confirmed`，默认 true）。
   * 与 `daily-report.service.requireConfirmed()` 同一口径——结算生成从总日报带出明细后，
   * 这里也必须在查询日报行时套同一层过滤，否则开关会只对部分入口生效。
   */
  private async requireConfirmed(): Promise<boolean> {
    const v = await this.sysParam.get('settlement.require_confirmed', 'true');
    return String(v).toLowerCase() !== 'false';
  }

  /**
   * 同合同 + **同一结算期**的那张结算单 id（没有 → `null`）—— 发票/收领单**自动匹配**的口径。
   *
   * 「同一结算期」而不是「同一自然月」：起始日不是 1 日时两者会错开
   * （起始日 26 日 → 期 9/26–10/25 属于 10 月），9/28 的单据就该归到期末 10/25 的那张结算单上。
   * 起始日 = 1 日时（业务给的例子）两者等价。判据本身在 `periodKeyOf()`。
   */
  async findSettlementIdFor(
    contractId: string | null | undefined,
    date: unknown,
  ): Promise<string | null> {
    if (!contractId || !monthKey(date)) return null;
    const c = await this.prisma.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    if (!c) return null;
    const startDay = await this.startDayOf(c.projectId);
    const want = periodKeyOf(startDay, date);
    if (!want) return null;
    const list: any[] = await this.prisma.settlement.findMany({
      where: { contractId },
      select: { id: true, settleDate: true },
      // ⚠️ 必须与 computeLedgerAutoFields / linkOrphansForContract 同一选单规则（settleDate desc, id desc）：
      // 历史同期多张时，自动挂发票的那张要与台账认的那张是同一张，否则发票不计入本月开票额（P1-4）
      orderBy: [{ settleDate: 'desc' }, { id: 'desc' }],
    });
    return list.find((s) => periodKeyOf(startDay, s.settleDate) === want)?.id ?? null;
  }

  /**
   * 发票/收领单与结算单的关联**必须同项目、同合同、同结算期**。
   *
   * 为什么强制同期：台账的「本月开票额」是按**行**（合同 + 结算期）汇总的，跨期关联会让一张发票
   * 出现在它并不属于的那一行上，口径就散了。同合同的判断在 `contractId` 两边都有值时才做
   * （收领单用的是 `materialContractId`，可能为空）；日期两边都能解析出期时才比期。
   *
   * 返回该结算单，供调用方直接落 `settlementId`。
   */
  async assertLinkable(
    settlementId: string,
    projectId: string,
    opts: { contractId?: string | null; date?: unknown; label: string },
  ) {
    const s = await this.prisma.settlement.findUnique({
      where: { id: settlementId },
      select: { id: true, projectId: true, contractId: true, settleDate: true, code: true },
    });
    if (!s || s.projectId !== projectId) throw new NotFoundException('结算单不存在');
    // 合同必须**完全一致**：一贯为 null（无合同单据 ↔ 无合同结算单）才放行。
    // 一边有合同、一边没有同样拒绝——否则发票会挂到别合同的结算单上，
    // 台账按 `{ settlementId, contractId }` 归集时它就会从本合同的开票额里消失。
    const mineContract = opts.contractId ?? null;
    const settlementContract = s.contractId ?? null;
    if (mineContract !== settlementContract) {
      throw new BadRequestException(`该结算单不属于本${opts.label}的合同，无法关联。`);
    }
    const startDay = await this.startDayOf(projectId);
    const own = periodKeyOf(startDay, s.settleDate);
    const mine = periodKeyOf(startDay, opts.date);
    if (own && mine && own !== mine) {
      throw new BadRequestException(
        `该结算单的结算期是 ${own}（期末 ${monthKey(s.settleDate)}），` +
          `与本${opts.label}的日期不在同一个结算期：结算台账按「合同 + 结算期」汇总，只能关联同期的结算单。`,
      );
    }
    return s;
  }

  /**
   * **自动匹配**：把该合同**尚未关联**的发票/收领单挂到同期那张结算单上，
   * 并把已经挂在某张结算单上、却**不在它的结算期内**的行解绑（改了结算日期或项目起算日之后要重算）。
   *
   * - 发票的日期：`结算账期` 文本优先（解析得出月份时），否则用开票日期；
   * - 收领单的日期：下单日期；合同取 `materialContractId`（物资合同）；
   * - **只动未关联的行**：人工指定的关联不会被自动改（除非它与结算期矛盾，那属于脏数据，
   *   由第二遍「解绑」纠正 —— 与台账刷新「先清后挂」同一个道理）。
   *
   * 关联变化会影响台账的「本月开票额」，调用方随后要 `syncLedgerByContract()`。
   */
  async linkOrphansForContract(contractId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    const empty = { invoices: 0, receiptOrders: 0, detached: 0 };
    if (!contractId) return empty;
    const contract = await db.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    if (!contract) return empty;
    const settlements: any[] = await db.settlement.findMany({
      where: { contractId },
      select: { id: true, settleDate: true },
      // 与 computeLedgerAutoFields 同口径：同期多张时取最近一张（settleDate desc, id desc），
      // 否则发票挂在 A 张、台账按 B 张算开票额 → 本月开票额凭空为 0（第 22 轮审计 P1-4）
      orderBy: [{ settleDate: 'desc' }, { id: 'desc' }],
    });
    if (!settlements.length) return empty;

    const startDay = await this.startDayOf(contract.projectId, db);
    /** 结算单 id → 它所属的结算期（标签）；算不出期的结算单（没填日期）不参与关联 */
    const periodOf = new Map<string, string>();
    for (const s of settlements) {
      const key = periodKeyOf(startDay, s.settleDate);
      if (key && !periodOf.has(key)) periodOf.set(key, s.id);
    }
    if (!periodOf.size) return empty;

    /**
     * 单据日期：发票优先用「结算账期」文本（它才是账期口径），认不出才退回开票日期；
     * 收领单只有下单日期。⚠️ 两处都必须与 `computeLedgerAutoFields()` 同口径。
     */
    const invoiceDate = (i: any) => periodMonthKey(i.settlePeriod) ?? i.invoiceDate;

    const linkedIds = [...periodOf.values()];
    // ① 解绑：挂在某张结算单上、但不在它的结算期内的行（改过 settleDate 之后会留下这种）
    const linkedInv: any[] = await db.invoice.findMany({
      where: { settlementId: { in: linkedIds } },
      select: { id: true, settlementId: true, settlePeriod: true, invoiceDate: true, contractId: true },
    });
    const staleInv = linkedInv
      .filter((i: any) => {
        const sid = i.settlementId;
        const period = [...periodOf.entries()].find(([, id]) => id === sid)?.[0];
        const own = periodKeyOf(startDay, invoiceDate(i));
        // 结算期不符，或发票属于**别的**合同（结算单换过合同后留下的陈旧关联）→ 解绑。
        // ⚠️ `contractId` 可空（历史/手填发票）：空合同的已挂发票不能因本合同刷新被误解绑。
        return Boolean(period && own && own !== period) || Boolean(i.contractId && i.contractId !== contractId);
      })
      .map((i: any) => i.id);
    let detached = 0;
    if (staleInv.length) {
      detached += await detachInvoices(db, staleInv, contract.projectId);
    }
    const linkedRo: any[] = await db.receiptOrder.findMany({
      where: { settlementId: { in: linkedIds } },
      select: { id: true, settlementId: true, orderDate: true, materialContractId: true },
    });
    const staleRo = linkedRo
      .filter((r: any) => {
        const sid = r.settlementId;
        const period = [...periodOf.entries()].find(([, id]) => id === sid)?.[0];
        const own = periodKeyOf(startDay, r.orderDate);
        // 同发票：结算期不符或收领单不属于本合同 → 解绑；
        // `materialContractId` 可空（历史/手工单）的已挂收领单不能因本合同刷新被误解绑
        return Boolean(period && own && own !== period) || Boolean(r.materialContractId && r.materialContractId !== contractId);
      })
      .map((r: any) => r.id);
    if (staleRo.length) {
      detached += await detachReceiptOrders(db, staleRo, contract.projectId);
    }

    // ② 挂载：未关联 + 与本合同同期
    let invoices = 0;
    let receiptOrders = 0;
    const orphanInv: any[] = await db.invoice.findMany({
      // 作废/红冲票不参与自动挂载（与期组合发现同口径）：否则审计视图会出现「作废票已挂当期结算单」
      where: { settlementId: null, contractId, ...countedInvoiceWhere() },
      select: { id: true, settlePeriod: true, invoiceDate: true },
    });
    const orphanRo: any[] = await db.receiptOrder.findMany({
      where: { settlementId: null, materialContractId: contractId },
      select: { id: true, orderDate: true },
    });
    for (const [period, settlementId] of periodOf) {
      const invIds = orphanInv
        .filter((i: any) => periodKeyOf(startDay, invoiceDate(i)) === period)
        .map((i: any) => i.id);
      if (invIds.length) {
        invoices += await attachInvoicesToSettlement(db, invIds, settlementId);
      }
      const roIds = orphanRo.filter((r: any) => periodKeyOf(startDay, r.orderDate) === period).map((r: any) => r.id);
      if (roIds.length) {
        receiptOrders += await attachReceiptOrdersToSettlement(db, roIds, settlementId);
      }
    }
    return { invoices, receiptOrders, detached };
  }

  // ---------------- 月度结算自动生成（业务口径 2026-10-16） ----------------

  /**
   * 预览「上一期」的抓取情况（结算单页顶部提示用）：
   * 该期有几张**未挂结算单**的收领单、涉及几个合同 —— 有值就说明该生成结算了。
   *
   * 期间算法见 `domain/settlement-period.ts`（期 = 起始日 → 下月同日的前一日；
   * 起始日取项目的「月度结算起始日期」，未设置按自然月）。
   */
  async previewPreviousPeriod(projectId: string, refDate?: string) {
    const startDay = await this.startDayOf(projectId);
    const period = previousSettlementPeriod(startDay, refDate ? new Date(refDate) : new Date());
    const gated = await this.requireConfirmed();
    /**
     * 结算来源 = **总日报行**（业务口径 2026-10-18：有总日报之后才有结算单）。
     * 收领单推送的日报行与手工录入的日报行同属来源；`require_confirmed` 开启时只算「已确认」行。
     */
    const rows = await this.prisma.dailyReport.findMany({
      where: {
        projectId,
        contractId: { not: null },
        entryDate: { gte: period.start, lt: period.endExclusive },
        ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}),
      },
      select: { id: true, contractId: true },
    });
    const contractIds = [...new Set(rows.map((r: any) => r.contractId as string))];
    // 已有结算单的合同不算"待生成"（同合同同期唯一，重跑会跳过）
    const existing = await this.prisma.settlement.findMany({
      where: { projectId, contractId: { in: contractIds }, settleDate: { gte: period.start, lt: period.endExclusive } },
      select: { contractId: true },
    });
    const done = new Set(existing.map((s: any) => s.contractId));
    const pending = contractIds.filter((id) => !done.has(id));
    return {
      month: period.month,
      startDate: formatDay(period.start),
      endDate: formatDay(period.end),
      startDay,
      /** 期间内参与结算口径的总日报行数 */
      dailyRowCount: rows.length,
      /** 兼容旧前端字段：语义已改为"总日报行数" */
      orderCount: rows.length,
      /** 还需要生成结算单的合同数 */
      pendingContracts: pending.length,
      /** 期间内完全没有可结算的日报行（前端据此提示"本期无可结算数据"而不是"去生成"） */
      empty: rows.length === 0,
    };
  }

  /**
   * **生成本期（默认上一期）结算单**（业务口径 2026-10-18）。
   *
   * 来源 = 该期间内的**总日报行**（`DailyReport`，按 `contractId` 归合同、`entryDate` 分期；
   * `settlement.require_confirmed` 开启时只算「已确认」行）。每个合同生成**一张草稿**结算单，
   * 明细按物资（`materialBaseId`）聚合并从日报行带出——**数量/单价/税率可由人在结算单上修改**；
   * `settleDate` = **期末**（台账 `settleMonth` 由它派生，两边必须同口径）。
   *
   * 收领单仍按 id **回挂**到本期结算单上（发票/台账按关联归集需要）；但明细金额**不再从收领单明细算**，
   * 这是“总日报是结算量唯一来源”的落点。
   *
   * **幂等**：同一合同同一期已有结算单 → 跳过（`skipped` 计数），并把该合同本期尚未挂单的
   * 收领单补挂到那张已有结算单上（补关联、**不改金额**；金额定稿后不由服务端擅自改动）。
   * 重跑不会重复生成结算单；并发下即使两个请求同时通过预检，`create()` 的同期唯一校验也会拦下后一个，
   * 这里把它算作"跳过"。
   *
   * ⚠️ 收领单的回挂**不**走 `linkOrphansForContract()`：那个函数按"结算期"匹配，
   * 而这里我们已知每张收领单属于本期的哪一张结算单 —— 直接按 id 回挂更准且更快。
   */
  async generateForPeriod(
    projectId: string,
    opts: { refDate?: string; contractId?: string | null; user?: any } = {},
  ) {
    const startDay = await this.startDayOf(projectId);
    const period = previousSettlementPeriod(startDay, opts.refDate ? new Date(opts.refDate) : new Date());
    const gated = await this.requireConfirmed();
    // 结算明细来源：期内总日报行（业务口径 2026-10-18）
    const dailyRows = await this.prisma.dailyReport.findMany({
      where: {
        projectId,
        contractId: { not: null },
        entryDate: { gte: period.start, lt: period.endExclusive },
        ...(opts.contractId ? { contractId: opts.contractId } : {}),
        ...(gated ? { confirmStatusCode: SITE_CONFIRM_STATUS.CONFIRMED } : {}),
      },
      select: {
        contractId: true,
        materialBaseId: true,
        materialName: true,
        receiptNo: true,
        settleQty: true,
        priceBeforeTax: true,
        taxRatePct: true,
        priceAfterTax: true,
        amountBeforeTax: true,
        amountAfterTax: true,
      },
    });
    // 收领单只用于回挂（发票/台账按关联归集），不再参与明细金额计算
    const receipts = await this.prisma.receiptOrder.findMany({
      where: {
        projectId,
        settlementId: null,
        materialContractId: { not: null },
        ...(opts.contractId ? { materialContractId: opts.contractId } : {}),
        orderDate: { gte: period.start, lt: period.endExclusive },
      },
      select: { id: true, materialContractId: true },
    });

    const rowsByContract = new Map<string, any[]>();
    for (const r of dailyRows) {
      const cid = r.contractId as string;
      const list = rowsByContract.get(cid) ?? [];
      list.push(r);
      rowsByContract.set(cid, list);
    }
    const receiptsByContract = new Map<string, any[]>();
    for (const o of receipts) {
      const cid = o.materialContractId as string;
      const list = receiptsByContract.get(cid) ?? [];
      list.push(o);
      receiptsByContract.set(cid, list);
    }

    const contractIds = [...rowsByContract.keys()];
    const contracts: any[] = contractIds.length
      ? await this.prisma.contract.findMany({
          where: { id: { in: contractIds } },
          select: { id: true, code: true },
        })
      : [];
    const codeOf = new Map(contracts.map((c: any) => [c.id, c.code]));

    let created = 0;
    let skipped = 0;
    let skippedArchived = 0;
    let skippedNoItems = 0;
    let skippedRowCount = 0;
    let skippedNoQtyRows = 0;
    let skippedNetZeroRows = 0;
    let skippedInvalidPriceRows = 0;
    const warnings: string[] = [];
    const createdItems: any[] = [];
    // 按 contractId 排序后再逐合同加锁：并发两次生成若处理顺序相反，事务级咨询锁会互相等待成死锁
    for (const [contractId, list] of [...rowsByContract.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      // 已归档合同不再生成结算单（归档前已要求结算收口；这里只防手工触发）
      if (await this.lock.isArchived(contractId)) {
        skippedArchived++;
        continue;
      }
      const existing = await this.findSettlementIdFor(contractId, period.end);
      const contractReceipts = receiptsByContract.get(contractId) ?? [];
      if (existing) {
        /**
         * 该合同本期**已有结算单** → 不重复生成，但把这些尚未挂单的收领单**补挂**上去
         * （否则它们会一直悬空：本期再也不会被"抓取"到了）。
         * ⚠️ 只补关联、**不动结算单金额** —— 金额可能已定稿甚至已提交，
         * 服务端不该悄悄改它；要改由人在结算单上改。
         * `skipped` 只在确有新收领单需要补挂时 +1（与改造前语义一致：没有新数据不算“跳过一张”）。
         */
        if (contractReceipts.length) {
          await attachReceiptOrdersToSettlement(
            this.prisma,
            contractReceipts.map((o: any) => o.id),
            existing,
          );
          skipped++;
        }
        continue;
      }

      // 总日报行 → 清单项级结算明细（按 materialBaseId 聚合；带不出的行计入 skipped）
      const built = buildSettlementItemsFromDailyRows(list);
      skippedRowCount += built.skippedRowCount;
      skippedNoQtyRows += built.skippedNoQtyRowCount;
      skippedNetZeroRows += built.skippedNetZeroRowCount;
      skippedInvalidPriceRows += built.skippedInvalidPriceRowCount;
      if (built.skippedRowCount > 0) {
        warnings.push(
          `${codeOf.get(contractId) || contractId}：${built.skippedRowCount} 条总日报行缺少物资主数据，未带出明细${
            built.skippedNames.length ? `（${built.skippedNames.join('、')}…）` : ''
          }`,
        );
      }
      if (built.skippedNoQtyRowCount > 0) {
        warnings.push(
          `${codeOf.get(contractId) || contractId}：${built.skippedNoQtyRowCount} 条总日报行结算数量为空或为 0，未带入结算金额，请补数量后手工调整`,
        );
      }
      if (built.skippedNetZeroRowCount > 0) {
        warnings.push(
          `${codeOf.get(contractId) || contractId}：${built.skippedNetZeroRowCount} 条总日报行按物资净结算数量为 0（收退货已互相抵消），未生成明细，请核对原始日报`,
        );
      }
      if (built.skippedInvalidPriceRowCount > 0) {
        warnings.push(
          `${codeOf.get(contractId) || contractId}：${built.skippedInvalidPriceRowCount} 条总日报行单价/税率异常（超出可存范围），未带入明细，请核对原始数据`,
        );
      }
      if (!built.items.length) {
        // 全是无法带出的行（无物资主数据、数量为空/0、净数量为 0）→ 不生成空壳结算单
        skippedNoItems++;
        continue;
      }

      try {
        // 结算单头 + 明细 + 收领单回挂放在同一事务：任一步失败（如异常数据导致
        // Decimal 溢出）都不会留下「有单头、无明细」的孤儿结算单，重跑也不会因
        // 同期已有结算单而被跳过。
        const settlement: any = await this.prisma.$transaction(async (tx) => {
          const created = await this.create(
            {
              contractId,
              code: `JS${period.month.replace('-', '')}-${codeOf.get(contractId) || ''}`,
              typeCode: 'PROGRESS', // 月度结算按「进度款」记；如有异议可在结算单上改
              statusCode: SETTLEMENT_STATUS.DRAFT,
              amount: built.amount,
              actualAmount: built.amount,
              settleDate: period.end,
              items: built.items,
              remark: `按月度结算期自动生成（${monthKey(period.start)}-${String(period.start.getDate()).padStart(2, '0')} ~ ${monthKey(period.end)}-${String(period.end.getDate()).padStart(2, '0')}，含 ${list.length} 条总日报行${
                built.skippedRowCount ? `；${built.skippedRowCount} 条无物资主数据已跳过` : ''
              }${built.skippedNoQtyRowCount ? `；${built.skippedNoQtyRowCount} 条结算数量为空或为 0 已跳过` : ''}${
                built.skippedNetZeroRowCount ? `；${built.skippedNetZeroRowCount} 条净数量为 0 已跳过` : ''
              }${
                built.skippedInvalidPriceRowCount ? `；${built.skippedInvalidPriceRowCount} 条单价/税率异常已跳过` : ''
              }）`,
            },
            projectId,
            tx as any,
          );
          if (contractReceipts.length) {
            await attachReceiptOrdersToSettlement(
              tx,
              contractReceipts.map((o: any) => o.id),
              created.id,
            );
          }
          return created;
        });
        // 事务提交后重刷台账（本期结算额/开票额都以结算单为准）
        await this.syncLedgerByContract(contractId);
        created++;
        createdItems.push({
          id: settlement.id,
          code: settlement.code,
          contractId,
          amount: built.amount,
          items: built.items.length,
          dailyRows: list.length,
          receiptOrders: contractReceipts.length,
        });
      } catch (e: any) {
        /**
         * 只有「同合同同期已有结算单」这一个 400 算跳过（并发下预检与写入之间的窗口）。
         * ⚠️ 不能把所有 400 都当跳过：`create()` 里还有字典校验（如 `settlement_type`
         * 没有 `PROGRESS` 取值）与归档锁，一并吞掉会让接口以 `created=0 / skipped=N`
         * 正常返回，把配置错误伪装成「本期无可生成数据」。
         */
        if (e instanceof BadRequestException && String(e.message).includes('只允许一张结算单')) {
          skipped++;
          continue;
        }
        throw e;
      }
    }

    return {
      month: period.month,
      startDate: formatDay(period.start),
      endDate: formatDay(period.end),
      startDay,
      /** 期内参与结算口径的总日报行数 */
      dailyRows: dailyRows.length,
      /** 期内回挂到结算单的收领单数（明细金额不再取自收领单） */
      receiptOrders: receipts.length,
      created,
      skipped,
      /** 因合同已归档而跳过的合同数 */
      skippedArchived,
      /** 有日报行但全部无法带出（无物资主数据 / 数量为空或 0 / 净数量为 0）、未能生成结算单的合同数 */
      skippedNoItems,
      /** 因缺少物资主数据、结算数量为空/0 或净数量为 0 而未能带出的日报行总数 */
      skippedRows: skippedRowCount + skippedNoQtyRows + skippedNetZeroRows + skippedInvalidPriceRows,
      /** 其中：缺少物资主数据的行数 */
      skippedMaterialRows: skippedRowCount,
      /** 其中：结算数量为空/0 的行数 */
      skippedNoQtyRows,
      /** 其中：按物资聚合后净数量为 0（收退货抵消）的行数 */
      skippedNetZeroRows,
      /** 其中：单价/税率异常的行数 */
      skippedInvalidPriceRows,
      warnings,
      /**
       * 金额为 0 的生成张数：日报行**没有单价/金额**时（数据没录全）就会算出 0 元。
       * 这不是错误（照常生成草稿，由人补金额），但**必须提示**——否则 0 元结算单会被直接提交。
       */
      zeroAmount: createdItems.filter((i) => !i.amount).length,
      contracts: createdItems,
    };
  }

}

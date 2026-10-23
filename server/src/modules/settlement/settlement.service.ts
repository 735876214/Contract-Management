import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, toDate, assertVersion, assertYearMonth } from '../../common/utils/helpers';
import { round2 } from '../../common/utils/money';

/**
 * 导出件末尾的合计行标记（`styled.exportTable({ totalsLabel: '汇总' })` 写进「项目」列）。
 * 回流时这一行不是数据行，必须跳过，否则「合同编号为必填项」整批报错（第 22 轮审计 P1-2 跟进）。
 */
const LEDGER_TOTALS_MARKERS = new Set(['汇总', '合计', '总计']);

/** 取表格里的第一个非空值：兼容模板列名与导出表头（导出件带 a/b/c/d 角标） */
const pickAny = (r: any, ...labels: string[]): any => {
  for (const label of labels) {
    const v = r[label];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
};
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { assertSettlementProgress, assertSettlementRejectable, SETTLEMENT_STATUS, SITE_CONFIRM_STATUS } from '../../constants/workflowGuards';
// 总结算单状态常量（第 21 轮审计：不要再裸写 'SETTLED'）
import { FINAL_SETTLEMENT_STATUS } from '../../constants/statuses';
import { buildSettlementItemsFromDailyRows } from '../../common/utils/settlement-from-daily';
import { SysParamService } from '../../common/services/sys-param.service';
import { ContractLockService } from '../../common/services/contract-lock.service';
import { normalizePolicy, checkOverAmount } from '../../common/utils/amount-guard';
// 链口径（合同当前金额 / 累计结算 / 累计付款）统一在 contract-chain：防超结的上限与
// 业务口径「合同当前金额 = 主合同 + 补充协议增量」必须是同一个实现
import {
  contractChainAmount,
  chainSettledTotal,
  chainMaterialQty,
  chainSettledItemQty,
} from '../../common/utils/contract-chain';
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
} from '../../common/utils/settlement-period';

const SETTLE_FIELDS = [
  'projectId', 'contractId', 'code', 'typeCode', 'amount', 'deductAmount', 'actualAmount',
  'settleDate', 'statusCode', 'remark',
];
/** update 白名单：不含 projectId —— 归属只能由 create 决定 */
const SETTLE_UPDATE_FIELDS = SETTLE_FIELDS.filter((f) => f !== 'projectId');
/** 清单项级结算明细的写字段白名单（items 随结算单 body 一并传） */
const SETTLEMENT_ITEM_FIELDS = ['materialBaseId', 'qty', 'priceBeforeTax', 'taxRatePct', 'remark', 'sortOrder'];
const LEDGER_FIELDS = [
  'projectId', 'contractId', 'settleMonth', 'monthSettleAmount', 'monthInvoiceAmount', 'settleCount',
  'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount', 'monthActualPurchase',
  'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome', 'isOnAccount', 'remark',
];
/** update 白名单：不含 projectId —— 台账归属只能由 create 决定 */
const LEDGER_UPDATE_FIELDS = LEDGER_FIELDS.filter((f) => f !== 'projectId');

@Injectable()
export class SettlementService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private excel: ExcelService,
    private styled: StyledExcelService,
    private tpl: ImportTemplateService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
    private sysParam: SysParamService,
    private lock: ContractLockService,
  ) {}

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
    out.qty = num(out.qty);
    out.priceBeforeTax = num(out.priceBeforeTax);
    out.taxRatePct = num(out.taxRatePct);
    out.priceWithTax =
      out.priceBeforeTax != null && out.taxRatePct != null
        ? Number((out.priceBeforeTax * (1 + out.taxRatePct / 100)).toFixed(4))
        : out.priceBeforeTax;
    out.totalWithTax =
      out.priceWithTax != null && out.qty != null ? round2(out.priceWithTax * out.qty) : null;
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
    await db.settlementItem.deleteMany({ where: { settlementId } });
    const rows = (Array.isArray(items) ? items : []).filter((d: any) => d?.materialBaseId);
    if (!rows.length) return [];
    const baseRows = await db.materialBase.findMany({
      where: { id: { in: rows.map((d: any) => d.materialBaseId) } },
      select: { id: true, unit: true },
    });
    const unitOf = new Map(baseRows.map((b: any) => [b.id, b.unit]));
    await db.settlementItem.createMany({
      data: rows.map((d: any, i: number) => ({
        ...this.normalizeItem(d, i),
        settlementId,
      })),
    });
    return db.settlementItem.findMany({
      where: { settlementId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.contractId) where.contractId = query.contractId;
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.statusCode) where.statusCode = query.statusCode;
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { contract: { name: { contains: query.keyword } } }];
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
    if (!s) throw new NotFoundException('结算单不存在');
    // 防御纵深：路由层已按项目校验成员关系，这里再核一次归属，避免按 id 直读跨项目单据。
    // 用结算单自身的 projectId 判定：contractId 可空（无合同结算单同样要能打开），
    // 走 contract.projectId 会把合法的无合同单据误判成「不存在」。
    if (projectId && s.projectId !== projectId) throw new NotFoundException('结算单不存在');
    return s;
  }

  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.lock.assertWritable(data.contractId, '新增结算单');
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
        : await this.checkOverSettlement(data.contractId, num(actual));
    // 清单项级量级闸门（同防超结口径：非事务、非草稿才校验）
    const items: any[] = Array.isArray(data.items) ? data.items.filter((d: any) => d?.materialBaseId) : [];
    const qtyWarn =
      tx || this.isDraft(data.statusCode) ? {} : await this.checkOverSettlementQty(data.contractId, items);
    const created: any = await db.settlement.create({
      data: {
        ...pickFields(data, SETTLE_FIELDS, { label: '结算单' }), projectId,
        amount: num(data.amount), deductAmount: num(data.deductAmount), actualAmount: num(actual),
        settleDate: toDate(data.settleDate),
      },
    });
    if (items.length) await this.syncItems(created.id, items, db);
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
    assertVersion(before, data);
    await this.lock.assertWritable(before.contractId, '修改结算单');
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
      : await this.checkOverSettlement(effectiveContractId, resultingActual, id);
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
    const items: any[] = Array.isArray(data.items) ? data.items.filter((d: any) => d?.materialBaseId) : [];
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
    const updated: any = await this.prisma.settlement.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
    if (data.items) await this.syncItems(id, items, this.prisma);
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
  async reject(id: string, projectId?: string) {
    const before: any = await this.findOne(id, projectId);
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
    return this.findOne(id);
  }

  // ---------------- 结算台账 ----------------

  /**
   * 结算台账自动抓取字段（数据自动生成，不依赖手工录入）：
   * - 本月结算额 / 结算次数：按结算月份从结算单（Settlement.settleDate）抓取实结金额
   * - 本月开票额：**优先按 `settlementId` 精确归集**（发票与结算单对应），未关联的退回按「合同 + 月份」
   * - 保理贴息：从资金费用台账保理费用（FactoringCost，融资利息 + 手续费）按结算月份抓取
   * - 逾期利息：从资金费用台账逾期利息（OverdueInterest，未减免行）按结算月份抓取
   */
  async computeLedgerAutoFields(contractId: string, settleMonth: string) {
    /**
     * 结算单按**账期**筛选（第 21 轮审计）：原来用「自然月窗口」`[M-01, M+1-01)` 查 settleDate，
     * 起始日不是 1 日时，一张落在期初（如前一个月月末几天）的结算单会被算到相邻月份的行上，
     * 结果「本月结算额」在本月缺失、在邻月凭空多出。账期标签由 `periodKeyOf` 给出（期末所在月）。
     */
    const period = settleMonth;
    // 台账「本月结算额」**包含草稿**（有意与 contract-chain 的 notDraft 不同——
    // 见 backend-conventions.md「累计结算有两个口径」：台账回答“这条链的账现在是多少”，
    // 自动生成的草稿也是账面数据；防超结/履约才排除草稿）。
    // 按 settleDate 倒序取单：同月多张（历史数据）时稳定取最近一张作为关联目标。
    const owner = await this.prisma.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    const startDay = owner ? await this.startDayOf(owner.projectId) : 1;
    const settlements = (
      await this.prisma.settlement.findMany({
        where: { contractId },
        // 同一账期多张结算单（历史数据）时取「最近一张」，并带 id 兜底保证与 linkOrphansForContract 完全同一张（第 22 轮审计 P1-4）
        orderBy: [{ settleDate: 'desc' }, { id: 'desc' }],
      })
    ).filter((r: any) => periodKeyOf(startDay, r.settleDate) === period);
    /** 该行对应的结算单（同合同同月唯一 → 至多一张）；无则 null = 「仅费用行」 */
    const settlementId = (settlements[0] as any)?.id ?? null;
    const [invoices, factoring, overdue] = await Promise.all([
      /**
       * 发票按月归集（业务口径 2026-10-16「发票与结算单对应」）：
       * ① **已挂到本行结算单**的发票全算 —— 精确到单据，与「结算账期」那串自由文本怎么写无关；
       * ② **未挂任何结算单**的，退回按「合同 + 月份」归集（兼容存量数据，也支撑"当月无结算单"的仅费用行）；
       * ⚠️ 已挂到**别的**结算单的发票一律不算 —— 它属于那一行的口径，两边都计会重复。
       */
      this.prisma.invoice.findMany({
        where: settlementId
          ? { OR: [{ settlementId }, { contractId, settlementId: null }] }
          : { contractId, settlementId: null },
        select: { id: true, settlementId: true, settlePeriod: true, invoiceDate: true, amountWithTax: true },
      }),
      this.prisma.factoringCost.findMany({ where: { contractId, settlementMonth: settleMonth } }),
      this.prisma.overdueInterest.findMany({ where: { contractId, settlementMonth: settleMonth } }),
    ]);
    const monthSettleAmount = round2(settlements.reduce((s: number, r: any) => s + (num(r.actualAmount ?? r.amount) || 0), 0));
    /** 该行对应的结算单数：同合同同月唯一 → 恒为 0（仅费用行）或 1（字段保留兼容导出/列定义） */
    const settleCount = settlements.length;
    const monthInvoiceAmount = round2(
      invoices
        .filter(
          (i: any) =>
            (settlementId && i.settlementId === settlementId) ||
            (periodMonthKey(i.settlePeriod) ?? periodKeyOf(startDay, i.invoiceDate)) === settleMonth,
        )
        .reduce((s: number, i: any) => s + (num(i.amountWithTax) || 0), 0),
    );
    const factoringDiscount = round2(
      factoring.reduce((s: number, r: any) => {
        const cost = num(r.totalCost) ?? (num(r.financingInterest) || 0) + (num(r.handlingFee) || 0);
        return s + (cost || 0);
      }, 0),
    );
    const overdueSum = round2(overdue.reduce((s: number, r: any) => (r.waived ? s : s + (num(r.overdueInterest) || 0)), 0));
    return {
      monthSettleAmount,
      monthInvoiceAmount,
      settleCount,
      factoringDiscount,
      overdueInterest: overdueSum,
      settlementId,
    };
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
  ) {
    if (!contractId || !settleDate) return;
    /**
     * 判据是**账期**（期末所在月），不是自然月（第 23 轮审计）。
     * 起始日不是 1 日时，一期跨两个自然月（起始日 26 → 10/26–11/25），
     * 原来按自然月查重会让「10/28」和「11/20」两张单都通过校验 —— 同一期出现两张结算单，
     * 而发票/台账的「本月开票额」「本月结算额」都是按行（合同 × 账期）归集的，无从分摊。
     */
    const owner = await this.prisma.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    const startDay = owner ? await this.startDayOf(owner.projectId) : 1;
    const period = periodKeyOf(startDay, settleDate);
    if (!period) return;
    const same = await this.prisma.settlement.findMany({
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

  /**
   * 生成/刷新**一行**台账（按 合同 + 月份 upsert），并把 `settlementId` 一并落库。
   * 这是"结算单驱动台账"与"仅费用行"两条路径的**同一个汇合点**——
   * 自动字段（含 `settlementId`）全部来自 `computeLedgerAutoFields()`，不要在别处手拼。
   */
  private async upsertLedgerRow(
    contractId: string,
    projectId: string,
    settleMonth: string,
    tx?: TxClient,
  ) {
    const db: any = tx || this.prisma;
    const auto = await this.computeLedgerAutoFields(contractId, settleMonth);
    const exist = await db.settlementLedger.findFirst({ where: { projectId, contractId, settleMonth } });
    if (exist) {
      return db.settlementLedger.update({
        where: { id: exist.id },
        data: { ...auto, version: { increment: 1 } },
      });
    }
    try {
      return await db.settlementLedger.create({ data: { projectId, contractId, settleMonth, ...auto } });
    } catch (e: any) {
      // 先查后建在并发下必然有竞态：两个「刷新台账」、或导入发票的 afterCommit 与保存结算单同时到达，
      // 后到者撞 @@unique([projectId, contractId, settleMonth]) 抛 P2002 → 整个事务回滚变 500。
      // 这里退化为更新已有行，让并发两侧都成功（幂等）。
      if (e?.code !== 'P2002') throw e;
      const row = await db.settlementLedger.findFirst({ where: { projectId, contractId, settleMonth } });
      if (!row) throw e;
      return db.settlementLedger.update({
        where: { id: row.id },
        data: { ...auto, version: { increment: 1 } },
      });
    }
  }

  /**
   * 需求 2.3：合同物资/金额变更时，自动重新派生该合同下全部结算台账的自动抓取字段
   * （本月结算额、本月开票额、结算次数、保理贴息、逾期利息、对应结算单）。
   *
   * 2026-10-16 起它**同时负责建行**：该合同每张结算单所在的月份都必须有台账行并挂上
   * `settlementId`（此前它只刷新"已存在的行"，而全仓又没有调用点 —— 这正是
   * "台账与结算单看不出关联"的根因）。仅费用行（无结算单）也一并重算。
   */
  async syncLedgerByContract(contractId: string, tx?: TxClient) {
    if (!contractId) return 0;
    const db: any = tx || this.prisma;
    const contract = await db.contract.findUnique({ where: { id: contractId }, select: { projectId: true } });
    if (!contract) return 0;
    const projectId: string = contract.projectId;

    const months = new Set<string>();
    const startDay = await this.startDayOf(projectId, db);
    // (a) 该合同所有结算单所在的**账期**（期末所在月），不是自然月（第 21 轮审计）
    const settlements = await db.settlement.findMany({
      where: { contractId },
      select: { settleDate: true },
    });
    for (const s of settlements) {
      const m = periodKeyOf(startDay, s.settleDate);
      if (m) months.add(m);
    }
    // (b) 已有台账行的月份（含**仅费用行**：无结算单但有资金费用/逾期利息）
    const rows = await db.settlementLedger.findMany({
      where: { contractId },
      select: { settleMonth: true },
    });
    for (const r of rows) if (r.settleMonth) months.add(r.settleMonth);

    const run = async (exec: any) => {
      /**
       * ① **先清后挂**：`settlementId` 是唯一键，结算单改了月份时，
       * 旧月份的行上仍挂着它——不先清掉，新月份建行时就会撞唯一约束
       * （真库实测：这正是"改月份"用例暴露的问题）。
       */
      await exec.settlementLedger.updateMany({
        where: { contractId, settlementId: { not: null } },
        data: { settlementId: null },
      });
      // ② 再逐月 upsert：每行重新挂上它**当月**的那张结算单（或保持 null = 仅费用行）
      for (const m of months) await this.upsertLedgerRow(contractId, projectId, m, exec);
    };
    // 整体放在一个事务里：清空与重挂之间不能有窗口（否则中途失败会留下"全部无关联"的台账）
    if (tx) await run(tx);
    else await this.prisma.$transaction(async (t) => run(t), { timeout: 30000 });

    return months.size;
  }

  /** 一键自动生成/刷新台账：扫描结算单、收票登记、资金费用台账中的合同+月份组合，自动生成缺失行并刷新自动字段 */
  async refreshLedger(projectId: string) {
    // 资金费用两张表没有 projectId 列（只挂 contractId），先取本项目合同再按 id 过滤：
    // 原先 `findMany({ select })` 全表读，再在内存里用 contractIds 过筛——
    // 表一大就整表进内存，且与「查询必须自带项目过滤」的铁律相悖。
    const contracts = await this.prisma.contract.findMany({ where: { projectId }, select: { id: true } });
    const contractIdList = contracts.map((c: any) => c.id);
    const [settlements, invoices, factoring, overdue] = await Promise.all([
      this.prisma.settlement.findMany({ where: { projectId }, select: { contractId: true, settleDate: true } }),
      this.prisma.invoice.findMany({ where: { projectId }, select: { contractId: true, settlePeriod: true, invoiceDate: true } }),
      contractIdList.length
        ? this.prisma.factoringCost.findMany({ where: { contractId: { in: contractIdList } }, select: { contractId: true, settlementMonth: true } })
        : [],
      contractIdList.length
        ? this.prisma.overdueInterest.findMany({ where: { contractId: { in: contractIdList } }, select: { contractId: true, settlementMonth: true } })
        : [],
    ]);
    const contractIds = new Set(contracts.map((c: any) => c.id));
    const combos = new Set<string>();
    const add = (contractId: string | null, month: string | null) => {
      if (contractId && month) combos.add(`${contractId}|${month}`);
    };
    // 结算单 → 台账月份必须按**账期**（期末所在月），不能用自然月：起始日不是 1 日时
    // 一张 10/28 的结算单属于 10/26–11/25 这一期，台账行应落在「2026-11」（第 21 轮审计）
    const startDay = await this.startDayOf(projectId);
    for (const s of settlements) add(s.contractId, periodKeyOf(startDay, s.settleDate));
    for (const i of invoices) add(i.contractId, periodMonthKey(i.settlePeriod) ?? periodKeyOf(startDay, i.invoiceDate));
    for (const f of factoring) if (contractIds.has(f.contractId)) add(f.contractId, f.settlementMonth);
    for (const o of overdue) if (contractIds.has(o.contractId)) add(o.contractId, o.settlementMonth);
    let created = 0;
    let updated = 0;
    /**
     * 第 15/16 轮审计：原来每个「合同 × 月份」组合先 `findFirst` 再 `upsertLedgerRow`
     * （组合数 × 7 次串行往返），100 合同 × 12 个活跃月 ≈ 8400 次串行 SQL，
     * 同步 HTTP 必然超网关超时，期间还占着连接池。
     *
     * 现在：① 一次性把本项目已有台账行的 (contractId, settleMonth) 读回来定位「新增/更新」，
     * 省掉每个组合的一次点查；② 按 8 并发分批跑 upsert，把往返从「串行 N」压成「N/8」。
     * 单行 upsert 内部仍是原来的节奏（自动字段、settlementId 都在那里落），不改语义。
     */
    const existing = await this.prisma.settlementLedger.findMany({
      where: { projectId },
      select: { contractId: true, settleMonth: true },
    });
    const existed = new Set(existing.map((r: any) => `${r.contractId}|${r.settleMonth}`));
    const combosArr = Array.from(combos);
    const CONCURRENCY = 8;
    for (let i = 0; i < combosArr.length; i += CONCURRENCY) {
      const slice = combosArr.slice(i, i + CONCURRENCY);
      await Promise.all(
        slice.map(async (combo) => {
          const [contractId, settleMonth] = combo.split('|');
          // 与「结算单驱动」共用同一个 upsert（自动字段 + settlementId 都在那里落）
          await this.upsertLedgerRow(contractId, projectId, settleMonth);
        }),
      );
      for (const combo of slice) {
        if (existed.has(combo)) updated++;
        else created++;
      }
    }
    return { created, updated };
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
      orderBy: { createdAt: 'asc' },
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
    if (opts.contractId && s.contractId && s.contractId !== opts.contractId) {
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
      select: { id: true, settlementId: true, settlePeriod: true, invoiceDate: true },
    });
    const staleInv = linkedInv
      .filter((i: any) => {
        const sid = i.settlementId;
        const period = [...periodOf.entries()].find(([, id]) => id === sid)?.[0];
        const own = periodKeyOf(startDay, invoiceDate(i));
        return period && own && own !== period;
      })
      .map((i: any) => i.id);
    let detached = 0;
    if (staleInv.length) {
      detached += (await db.invoice.updateMany({ where: { id: { in: staleInv } }, data: { settlementId: null } })).count;
    }
    const linkedRo: any[] = await db.receiptOrder.findMany({
      where: { settlementId: { in: linkedIds } },
      select: { id: true, settlementId: true, orderDate: true },
    });
    const staleRo = linkedRo
      .filter((r: any) => {
        const sid = r.settlementId;
        const period = [...periodOf.entries()].find(([, id]) => id === sid)?.[0];
        const own = periodKeyOf(startDay, r.orderDate);
        return period && own && own !== period;
      })
      .map((r: any) => r.id);
    if (staleRo.length) {
      detached += (await db.receiptOrder.updateMany({ where: { id: { in: staleRo } }, data: { settlementId: null } })).count;
    }

    // ② 挂载：未关联 + 与本合同同期
    let invoices = 0;
    let receiptOrders = 0;
    const orphanInv: any[] = await db.invoice.findMany({
      where: { settlementId: null, contractId },
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
        invoices += (await db.invoice.updateMany({ where: { id: { in: invIds } }, data: { settlementId } })).count;
      }
      const roIds = orphanRo.filter((r: any) => periodKeyOf(startDay, r.orderDate) === period).map((r: any) => r.id);
      if (roIds.length) {
        receiptOrders += (await db.receiptOrder.updateMany({ where: { id: { in: roIds } }, data: { settlementId } })).count;
      }
    }
    return { invoices, receiptOrders, detached };
  }

  // ---------------- 月度结算自动生成（业务口径 2026-10-16） ----------------

  /**
   * 预览「上一期」的抓取情况（结算单页顶部提示用）：
   * 该期有几张**未挂结算单**的收领单、涉及几个合同 —— 有值就说明该生成结算了。
   *
   * 期间算法见 `common/utils/settlement-period.ts`（期 = 起始日 → 下月同日的前一日；
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
        taxRate: true,
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
    let skippedInvalidPriceRows = 0;
    const warnings: string[] = [];
    const createdItems: any[] = [];
    for (const [contractId, list] of rowsByContract) {
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
          await this.prisma.receiptOrder.updateMany({
            where: { id: { in: contractReceipts.map((o: any) => o.id) } },
            data: { settlementId: existing },
          });
          skipped++;
        }
        continue;
      }

      // 总日报行 → 清单项级结算明细（按 materialBaseId 聚合；带不出的行计入 skipped）
      const built = buildSettlementItemsFromDailyRows(list);
      skippedRowCount += built.skippedRowCount;
      skippedNoQtyRows += built.skippedNoQtyRowCount;
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
          `${codeOf.get(contractId) || contractId}：${built.skippedNoQtyRowCount} 条总日报行缺少结算数量，未带入结算金额，请补数量后手工调整`,
        );
      }
      if (built.skippedInvalidPriceRowCount > 0) {
        warnings.push(
          `${codeOf.get(contractId) || contractId}：${built.skippedInvalidPriceRowCount} 条总日报行单价/税率异常（超出可存范围），未带入明细，请核对原始数据`,
        );
      }
      if (!built.items.length) {
        // 全是无法带出的行（或来源行没有可结算数据）→ 不生成空壳结算单
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
              }${built.skippedNoQtyRowCount ? `；${built.skippedNoQtyRowCount} 条缺少结算数量已跳过` : ''}${
                built.skippedInvalidPriceRowCount ? `；${built.skippedInvalidPriceRowCount} 条单价/税率异常已跳过` : ''
              }）`,
            },
            projectId,
            tx as any,
          );
          if (contractReceipts.length) {
            await tx.receiptOrder.updateMany({
              where: { id: { in: contractReceipts.map((o: any) => o.id) } },
              data: { settlementId: created.id },
            });
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
        // 并发下撞上"同合同同期唯一"：这与"已有结算单"是同一类结果，算跳过而不是报错
        const isDup = e instanceof BadRequestException || e?.status === 400 || e?.getStatus?.() === 400;
        if (isDup) {
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
      /** 有日报行但全部缺少物资主数据/结算数量、未能生成结算单的合同数 */
      skippedNoItems,
      /** 因缺少物资主数据或结算数量而未能带出的日报行总数 */
      skippedRows: skippedRowCount + skippedNoQtyRows + skippedInvalidPriceRows,
      /** 其中：缺少物资主数据的行数 */
      skippedMaterialRows: skippedRowCount,
      /** 其中：缺少结算数量的行数 */
      skippedNoQtyRows,
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

  async findLedger(query: any = {}, projectId: string, maxPageSize = 500) {
    const { skip, take } = paginate(query, maxPageSize);
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

  async ledgerOne(id: string, projectId?: string) {
    const l = await this.prisma.settlementLedger.findUnique({ where: { id } });
    if (!l) throw new NotFoundException('结算台账记录不存在');
    // 与 findOne 相同的防御纵深：台账行按 id 直读同样要核归属
    if (projectId && l.projectId !== projectId) throw new NotFoundException('结算台账记录不存在');
    return l;
  }

  /**
   * 台账里的**只读派生字段**（业务口径 2026-10-16："资金费用在结算台账中只读，若修改需要从资金费用台账中修改"）。
   *
   * 两者都来自**别的台账**：`factoringDiscount ← 资金费用台账（FactoringCost）`、
   * `overdueInterest ← 逾期利息台账（OverdueInterest）`。它们本来就会被 `computeLedgerAutoFields()`
   * 在每次刷新时覆盖——与其"改了没用"，不如**明确报错**并把人引到正确的入口
   * （静默忽略会让人以为改成功了，那比报错更糟）。
   */
  private static readonly READONLY_LEDGER_FIELDS = ['factoringDiscount', 'overdueInterest'] as const;

  private assertLedgerWritable(data: any) {
    const bad = SettlementService.READONLY_LEDGER_FIELDS.filter((f) => data?.[f] !== undefined);
    if (bad.length) {
      throw new BadRequestException(
        `结算台账的「${bad.join('、')}」是**只读**派生字段：` +
          '资金费用请到「资金费用台账」修改、逾期利息请到「逾期利息」处修改，保存后结算台账会自动同步。',
      );
    }
  }

  /**
   * @param opts.fromImport 仅**台账导入**路径传 true：导入模板里仍带着「保理贴息/逾期利息」两列，
   *   且改造前它们同样会被 `computeLedgerAutoFields()` 覆盖（"从业务数据自动抓取，忽略手工传入"）——
   *   行为不变，只是不再被只读断言拦下。**接口调用方一律不给这个开关**。
   */
  async createLedger(data: any, projectId: string, tx?: TxClient, opts?: { fromImport?: boolean }) {
    const db: any = tx || this.prisma;
    if (!opts?.fromImport) this.assertLedgerWritable(data);
    // 结算月份同样按字符串精确匹配（台账按月列、自动抓取结算单/开票额都按它），格式错会静默对不上
    assertYearMonth(data.settleMonth, '结算月份');
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = { ...pickFields(data, LEDGER_FIELDS, { label: '结算台账' }), projectId };
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    if (payload.contractId && payload.settleMonth) {
      const auto: any = await this.computeLedgerAutoFields(payload.contractId, payload.settleMonth);
      /**
       * **填充式**合并（第 22 轮审计 P1-1）：自动抓取只补空值，不再无条件覆盖。
       * 原来 `Object.assign(payload, auto)` 有两个后果：
       * ① 当月没有结算单/发票时，用户填的「本月结算额」「本月开票额」被抹成 null —— 数据凭空消失；
       * ② 模板里这几列照旧让人填，填了既不生效也不提示。
       * 现在的口径：有业务单据 → 以系统抓取值为准（台账是派生视图，口径不能被人手改歪）；
       * 系统算不出来（当月无结算单/发票/资金费用）→ 保留手工填写值，不再清空。
       */
      for (const [k, v] of Object.entries(auto)) {
        if (payload[k] === undefined || payload[k] === null) payload[k] = v;
      }
      /**
       * 「本月结算额」「结算次数」是**纯派生**列（业务口径 2026-10-22）：
       * 只有一个来源 —— 该账期内的结算单（没有结算单就是 0 / 0），任何手填值一律无效。
       * 其余自动列保留上面的「填充式」：系统算不出来时不抹掉用户填的值。
       */
      payload.monthSettleAmount = auto.monthSettleAmount;
      payload.settleCount = auto.settleCount;
      payload.settlementId = auto.settlementId;
    }
    // 唯一键预检（@@unique([projectId, contractId, settleMonth])）：直接 create 撞键会抛未捕获的
    // P2002 变成 500，这里先给出可读的 400
    await this.assertLedgerMonthUnique(projectId, payload.contractId ?? null, payload.settleMonth ?? null);
    try {
      return await db.settlementLedger.create({ data: payload });
    } catch (e: any) {
      // 预检与写入之间仍有窗口（同一个用户双击「新增」、或两个标签页同时提交）：
      // P2002 说明这一行刚好被别人建了，转成与预检一致的可读 400，而不是未捕获的 500
      if (e?.code !== 'P2002') throw e;
      throw new BadRequestException(
        `该合同 ${payload.settleMonth ?? ''} 的结算台账已存在，请勿重复新增`,
      );
    }
  }

  async updateLedger(id: string, data: any, projectId?: string) {
    const old = await this.ledgerOne(id, projectId);
    assertVersion(old, data);
    await this.assertLedgerWritable(data);
    assertYearMonth(data.settleMonth, '结算月份');
    await this.dict.validate('yes_no', data.isOnAccount);
    const payload: any = pickFields(data, LEDGER_UPDATE_FIELDS, { label: '结算台账' });
    ['monthSettleAmount', 'monthInvoiceAmount', 'yearSettleAmount', 'cumPurchaseAmount', 'startSettleAmount',
      'monthActualPurchase', 'factoringDiscount', 'overdueInterest', 'yearSettleIncome', 'cumSettleIncome'].forEach((f) => {
      if (payload[f] !== undefined) payload[f] = num(payload[f]);
    });
    if (payload.settleCount !== undefined) payload.settleCount = Number(payload.settleCount) || null;
    // 自动生成：以本次变更后的合同+月份为准重新抓取
    const contractId = payload.contractId ?? old.contractId;
    const settleMonth = payload.settleMonth ?? old.settleMonth;
    if (contractId && settleMonth) {
      Object.assign(payload, await this.computeLedgerAutoFields(contractId, settleMonth));
    }
    delete payload.version;
    // 唯一键预检：把月份/合同改成已存在的组合时，前端的 update 会撞 P2002 → 500，这里统一转 400
    await this.assertLedgerMonthUnique(old.projectId, contractId ?? null, settleMonth ?? null, id);
    return this.prisma.settlementLedger.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }

  /** 台账「合同 + 结算月」项目内唯一（DB 有 @@unique，这里提前给出可读错误） */
  private async assertLedgerMonthUnique(projectId: string, contractId: string | null, settleMonth: string | null, excludeId?: string) {
    if (!contractId || !settleMonth) return;
    const dup = await this.prisma.settlementLedger.findFirst({
      where: { projectId, contractId, settleMonth, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    });
    if (dup) throw new BadRequestException(`该合同 ${settleMonth} 的结算台账已存在，请勿重复新增`);
  }

  async removeLedger(id: string, projectId?: string) {
    await this.ledgerOne(id, projectId);
    await this.prisma.settlementLedger.delete({ where: { id } });
    return true;
  }

  /** 月度结算单合规性检查表（需求 2.7）：表头信息 + 检查项清单 + 签字区 */
  async exportComplianceSheet(contractId: string, projectId: string, year?: number, month?: number) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { name: true } }, project: { select: { name: true } } },
    });
    if (!contract) throw new NotFoundException('合同不存在');
    const project = contract.project || (await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } }));
    const info = [
      ['项目名称', project?.name || ''],
      ['分供方名称', contract.supplier?.name || ''],
      ['合同名称', contract.name],
      ['年度 / 月份', `${year || '____'} 年 ${month || '__'} 月`],
    ];
    /**
     * 结算额占合同额比例的**自动档位**。
     *
     * 口径与台账/工作台一致（业务口径 2026-10-15）：
     * - 分子 = 链上累计结算额（`actualAmount` 回退 `amount`，**排除草稿**）
     * - 分母 = **合同当前金额** = 主合同 + Σ 补充协议带符号增量（**不是**本合同的 amount）
     *
     * 分母未知（合同未填金额）时保持空白 □ 并注明"金额未填，无法判定"——
     * 这与"未填 ≠ 0"的既定口径一致，不臆造一个档位。
     */
    const [chainAmount, chainSettled] = await Promise.all([
      contractChainAmount(this.prisma, contractId),
      chainSettledTotal(this.prisma, contractId),
    ]);
    const ratioPct = chainAmount && chainAmount > 0 ? Number(((chainSettled / chainAmount) * 100).toFixed(2)) : null;
    const TIERS: [string, (pct: number) => boolean][] = [
      ['未超100%', (p) => p <= 100],
      ['100%-110%', (p) => p > 100 && p <= 110],
      ['110%-130%', (p) => p > 110 && p <= 130],
      ['130%以上', (p) => p > 130],
    ];
    const ratioTierText =
      ratioPct === null
        ? '结算额占合同额比例（未超100% □　100%-110% □　110%-130% □　130%以上 □）' +
          '　实际比例：合同当前金额未填，无法判定'
        : '结算额占合同额比例（' +
          TIERS.map(([label, hit]) => `${label} ${hit(ratioPct) ? '☑' : '□'}`).join('　') +
          `）　实际比例：${ratioPct}%（已结算 ¥${chainSettled.toFixed(2)} ÷ 合同当前金额 ¥${chainAmount!.toFixed(2)}）`;

    const CHECKS: [string, string][] = [
      ['进场依据（首期月度结算填报）', '开始招标时间'],
      ['', '首次进场时间'],
      ['', '是否为先进场后招标（是 □　否 □）'],
      ['', '定标时间'],
      ['', '是否为先进场后定标（是 □　否 □）'],
      ['', '合同签订时间'],
      ['', '是否为先进场后签合同（是 □　否 □）'],
      ['结算增项情况', '结算清单未超合同清单（是 □　否 □）'],
      ['收验货系统', '是否为上传收验货系统物资（是 □　否 □）'],
      ['', '上传收验货系统数量'],
      ['', '上传收验货系统数量占比'],
      ['', '未传收验货系统数量'],
      ['', '未传收验货系统数量占比'],
      // 该行由下方按「已结算 ÷ 合同当前金额」**自动带出**（业务口径 2026-10-15）：
      // 这是本表里唯一能由系统判定的勾选项，其余（签字盖章、是否先进场后招标…）仍需人工勾
      ['结算增量情况', ratioTierText],
      ['签字盖章合规性', '供应商签字为法人或授权委托人签字（是 □　否 □）'],
      ['', '（分包）收料人员签字有材料员授权委托书（是 □　否 □）'],
      ['', '盖章为公章或公章授权章（是 □　否 □）'],
      ['对账周期', '按对账周期结算（是 □　否 □）'],
      ['结算支撑材料', '结算依据充足准确（是 □　否 □）'],
      ['结算办理严谨性', '物资名称、规格型号与合同清单相同（是 □　否 □）'],
      ['', '基本信息无漏填（是 □　否 □）'],
      ['', '资料格式美观整洁（是 □　否 □）'],
    ];
    let lastGroup = '';
    const rows = CHECKS.map(([g, item]) => {
      if (g) lastGroup = g;
      return { group: lastGroup, item, result: '', note: '' };
    });
    return this.styled.withWorkbook(async (wb) => {
      const ws = wb.addWorksheet('合规性检查表', { views: [{ state: 'frozen', ySplit: 8 }] });
      const colCount = 4;
      // 品牌行 + 标题行
      ws.mergeCells(1, 1, 1, colCount);
      const brand = ws.getCell(1, 1);
      brand.value = '〖中国建筑〗中国建筑土木建设有限公司物资管理表格';
      brand.font = { bold: true, size: 14, name: '微软雅黑' };
      brand.alignment = { horizontal: 'left', vertical: 'middle' };
      ws.getRow(1).height = 26;
      ws.mergeCells(2, 1, 2, colCount);
      const title = ws.getCell(2, 1);
      title.value = '月度结算单合规性检查表';
      title.font = { bold: true, size: 13, name: '微软雅黑' };
      title.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(2).height = 24;
      // 表头信息区
      info.forEach(([label, value], i) => {
        const r = 3 + i;
        ws.getCell(r, 1).value = label;
        ws.getCell(r, 1).font = { bold: true, size: 10.5, name: '微软雅黑' };
        ws.mergeCells(r, 2, r, colCount);
        ws.getCell(r, 2).value = value;
        ws.getCell(r, 2).font = { size: 10.5, name: '微软雅黑' };
        for (let c = 1; c <= colCount; c++) ws.getCell(r, c).border = {
          top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' },
        };
      });
      // 检查项表头
      const headerRowIdx = 3 + info.length;
      const header = ws.getRow(headerRowIdx);
      ['检查分组', '检查项', '检查结果', '备注说明'].forEach((h, i) => {
        const cell = header.getCell(i + 1);
        cell.value = h;
        cell.font = { bold: true, size: 11, name: '微软雅黑' };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });
      header.height = 22;
      // 检查项行
      rows.forEach((r, ri) => {
        const row = ws.getRow(headerRowIdx + 1 + ri);
        [r.group, r.item, r.result, r.note].forEach((v, ci) => {
          const cell = row.getCell(ci + 1);
          cell.value = v || null;
          cell.font = { size: 10.5, name: '微软雅黑' };
          cell.alignment = { horizontal: ci === 1 ? 'left' : 'center', vertical: 'middle', wrapText: ci === 1 };
          cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });
      });
      // 签字区
      const signRow = headerRowIdx + rows.length + 2;
      ws.getCell(signRow, 1).value = '项目经办人签字：____________';
      ws.getCell(signRow, 3).value = '物资部负责人复核：____________';
      ws.getCell(signRow, 1).font = { size: 10.5, name: '微软雅黑' };
      ws.getCell(signRow, 3).font = { size: 10.5, name: '微软雅黑' };
      ws.getColumn(1).width = 24;
      ws.getColumn(2).width = 56;
      ws.getColumn(3).width = 22;
      ws.getColumn(4).width = 20;
      ws.pageSetup = {
        paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0,
        printTitlesRow: `1:${headerRowIdx}`, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.2, footer: 0.2 },
      };
    });
  }

  /**
   * 导出用全量台账行：`findLedger({ pageSize: 2000 })` 受单页上限（默认 500）截断，
   * 台账行超过上限时导出文件**静默**少行、合计偏小。按页拉全量（与发票/付款导出同口径）。
   */
  private async allLedgerRows(projectId: string, settleMonth?: string): Promise<any[]> {
    const pageSize = 500;
    const out: any[] = [];
    for (let page = 1; page <= 1000; page += 1) {
      const res = await this.findLedger({ page, pageSize, ...(settleMonth ? { settleMonth } : {}) }, projectId, pageSize);
      const list = (res.list as any[]) ?? [];
      out.push(...list);
      if (list.length < pageSize || out.length >= Number(res.total ?? 0)) break;
    }
    return out;
  }

  /** 导出台账 Excel；`settleMonth` 传入时只导该月（归档按期目录用，避免每期都塞全项目台账） */
  async exportLedger(projectId: string, settleMonth?: string) {
    const all = await this.allLedgerRows(projectId, settleMonth);
    const res: any = { list: all, total: all.length };
    const yesNo = await this.dict.nameMap('yes_no');
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
    /**
     * 「本月采购额（公式复核）」原来直接取月采购额同一字段，等于把值抄了一遍、什么都没复核（第 22 轮审计 P2-16）。
     * 现在按台账**自身累计值**做一次独立核对：本月采购额 = 本月累计采购额 − 上月累计采购额。
     * 首个有累计值的月份无所谓复核对象，留空（不硬编 0，避免把"算不出来"和"确实是 0"混为一谈）。
     */
    const reviewOf = new Map<string, number | null>();
    const byContract = new Map<string, any[]>();
    for (const r of res.list as any[]) {
      if (!r.contractId) continue;
      const list = byContract.get(r.contractId) || [];
      list.push(r);
      byContract.set(r.contractId, list);
    }
    for (const list of byContract.values()) {
      list.sort((x, y) => String(x.settleMonth || '').localeCompare(String(y.settleMonth || '')));
      let prevCum: number | null = null;
      for (const r of list) {
        const cum = num(r.cumPurchaseAmount);
        if (cum === null || prevCum === null) reviewOf.set(r.id, null);
        else reviewOf.set(r.id, Number((cum - prevCum).toFixed(2)));
        if (cum !== null) prevCum = cum;
      }
    }
    const rows = (res.list as any[]).map((r) => ({
      projectName: project?.name || '',
      supplierName: r.contract?.supplier?.name, contractName: r.contract?.name, contractCode: r.contract?.code,
      settleMonth: r.settleMonth, monthSettleAmount: num(r.monthSettleAmount), monthInvoiceAmount: num(r.monthInvoiceAmount),
      settleCount: r.settleCount, yearSettleAmount: num(r.yearSettleAmount), monthActualPurchaseReview: reviewOf.get(r.id) ?? null,
      cumPurchaseAmount: num(r.cumPurchaseAmount),
      startSettleAmount: num(r.startSettleAmount), monthActualPurchase: num(r.monthActualPurchase),
      factoringDiscount: num(r.factoringDiscount), overdueInterest: num(r.overdueInterest),
      yearSettleIncome: num(r.yearSettleIncome), cumSettleIncome: num(r.cumSettleIncome),
      isOnAccountName: yesNo[r.isOnAccount]?.name || '',
    }));
    return this.styled.exportTable({
      sheetName: '结算台账',
      logoColumn: true,
      title: `结算台账（${project?.name || ''}${settleMonth ? ' · ' + settleMonth : ''}）`,
      columns: [
        { header: '项目', key: 'projectName', width: 140, type: 'center' },
        { header: '供应商名称', key: 'supplierName', width: 180 },
        { header: '合同名称', key: 'contractName', width: 200 },
        { header: '合同编号', key: 'contractCode', width: 180 },
        { header: '结算月份', key: 'settleMonth', width: 100, type: 'center' },
        { header: '本月结算额 a', key: 'monthSettleAmount', width: 140, type: 'money' },
        { header: '本月开票额', key: 'monthInvoiceAmount', width: 130, type: 'money' },
        { header: '结算次数', key: 'settleCount', width: 80, type: 'int' },
        { header: '本年结算额', key: 'yearSettleAmount', width: 140, type: 'money' },
        { header: '本月采购额（公式复核）', key: 'monthActualPurchaseReview', width: 160, type: 'money' },
        { header: '截止当月开累采购额', key: 'cumPurchaseAmount', width: 160, type: 'money' },
        { header: '开工结算额', key: 'startSettleAmount', width: 130, type: 'money' },
        { header: '当月实际采购额 b', key: 'monthActualPurchase', width: 140, type: 'money' },
        { header: '保理贴息 c', key: 'factoringDiscount', width: 110, type: 'money' },
        { header: '逾期利息 d', key: 'overdueInterest', width: 110, type: 'money' },
        { header: '本年结算对应收入（含税）', key: 'yearSettleIncome', width: 180, type: 'money' },
        { header: '开累结算对应收入（含税）', key: 'cumSettleIncome', width: 180, type: 'money' },
        { header: '是否挂账', key: 'isOnAccountName', width: 90, type: 'center' },
      ],
      rows,
      totalsKeys: ['monthSettleAmount', 'monthInvoiceAmount', 'monthActualPurchase', 'factoringDiscount', 'overdueInterest'],
      totalsLabel: '汇总',
    });
  }

  /** 结算台账填写模板（需求 3.3，实际字段口径） */
  async templateLedger(projectId: string) {
    const yesNo = await this.dict.options('yes_no');
    const columns: TemplateColumn[] = [
      { label: '合同编号', key: 'contractCode', required: true, width: 20, example: 'HT-2026-0001', desc: '须为合同台账中已存在的合同编号' },
      { label: '结算月份', key: 'settleMonth', required: true, type: 'text', width: 14, example: '2026-08', desc: '格式 YYYY-MM，填**账期标签**（期末所在月）：月度结算起始日不是 1 号时，一期跨两个自然月，按后一个月填' },
      { label: '本月结算额', key: 'monthSettleAmount', type: 'money', width: 16, example: 1234567.89, desc: '**系统派生**：本期结算单实际金额合计（本期无结算单即为 0）。此列填了也不生效，导入时忽略' },
      { label: '本月开票额', key: 'monthInvoiceAmount', type: 'money', width: 16, example: 1396621.72, desc: '当月有发票时以系统抓取值为准；无发票时才用手填值' },
      { label: '结算次数', key: 'settleCount', type: 'int', width: 10, example: 2, desc: '**系统派生**：本期结算单张数（同一合同同一账期恒为 0 或 1）。此列填了也不生效，导入时忽略' },
      { label: '开累采购额', key: 'cumPurchaseAmount', type: 'money', width: 16, example: 50000000 },
      { label: '开工结算额', key: 'startSettleAmount', type: 'money', width: 16, example: 1000000 },
      { label: '本月实际采购额', key: 'monthActualPurchase', type: 'money', width: 16, example: 1180000 },
      { label: '保理贴息', key: 'factoringDiscount', type: 'money', width: 14, example: 12345.67, desc: '系统从资金费用台账抓取，手填不生效' },
      { label: '逾期利息', key: 'overdueInterest', type: 'money', width: 14, example: 0, desc: '系统从逾期利息台账抓取，手填不生效' },
      { label: '本年结算收入', key: 'yearSettleIncome', type: 'money', width: 16, example: 8000000 },
      { label: '开累结算收入', key: 'cumSettleIncome', type: 'money', width: 16, example: 9000000 },
      { label: '是否挂账', key: 'isOnAccount', type: 'select', width: 10, example: '否', options: yesNo.map((i: any) => i.itemName).filter(Boolean) },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '结算台账', sheetName: '数据', columns });
  }

  /** 结算台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importLedger(buffer: Buffer, projectId: string, meta?: { fileName?: string; user?: any; validateOnly?: boolean; mode?: string }) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    /** 覆盖模式（第 22 轮审计 P1-1）：默认「只新增不覆盖」，导出→改→导回时用 upsert 才更新已有行 */
    const upsert = String(meta?.mode ?? '').toLowerCase() === 'upsert';
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'settlement-ledger', moduleName: '结算台账', projectId, fileName: meta?.fileName, userId: meta?.user?.userId, username: meta?.user?.username }, rows, {
      plan: async (r) => {
        // 导出件末尾的合计行不是数据行：跳过（返回 null 由 runner 忽略）
        if (LEDGER_TOTALS_MARKERS.has(String(r['项目'] ?? '').trim())) return null;
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const month = String(r['结算月份'] ?? '').trim();
        if (!/^\d{4}-\d{2}$/.test(month)) throw new RowError('结算月份为必填项，格式 YYYY-MM（如 2026-08）', '结算月份');
        notDup(`${contract.id}|${month}`, `唯一性校验失败：该合同 ${month} 的记录在本次导入中重复`, '结算月份');
        const dup: any = await this.prisma.settlementLedger.findFirst({
          where: { projectId, contractId: contract.id, settleMonth: month },
          select: { id: true },
        });
        if (dup && !upsert) {
          throw new RowError(
            `唯一性校验失败：该合同 ${month} 的结算台账已存在（如需覆盖，请勾选「已存在则更新」后再导入）`,
            '结算月份',
          );
        }
        const isOnAccount = String(r['是否挂账'] ?? '').trim();
        return {
          existingId: dup?.id ?? null,
          data: {
            contractId: contract.id,
            settleMonth: month,
            // 「本月结算额」纯派生（业务口径 2026-10-22）：表里填的一律忽略，写入时由系统按账期结算单重算
            monthSettleAmount: undefined,
            monthInvoiceAmount: num(r['本月开票额']),
            settleCount: undefined, // 结算次数同样纯派生（该账期结算单张数）
            cumPurchaseAmount: num(pickAny(r, '开累采购额', '截止当月开累采购额')),
            startSettleAmount: num(r['开工结算额']),
            monthActualPurchase: num(pickAny(r, '本月实际采购额', '当月实际采购额 b')),
            factoringDiscount: num(pickAny(r, '保理贴息', '保理贴息 c')),
            overdueInterest: num(pickAny(r, '逾期利息', '逾期利息 d')),
            yearSettleIncome: num(pickAny(r, '本年结算收入', '本年结算对应收入（含税）')),
            cumSettleIncome: num(pickAny(r, '开累结算收入', '开累结算对应收入（含税）')),
            isOnAccount: isOnAccount || null,
            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        let created = 0;
        let updated = 0;
        for (const p of plans as any[]) {
          if (upsert && p.existingId) {
            // 覆盖模式：只更新模板里的可写列（自动抓取字段仍是「系统算得出就用系统的」），并推进乐观锁版本
            const auto: any = p.data.contractId && p.data.settleMonth
              ? await this.computeLedgerAutoFields(p.data.contractId, p.data.settleMonth)
              : {};
            const payload: any = { ...p.data };
            for (const [k, v] of Object.entries(auto)) if (payload[k] === undefined || payload[k] === null) payload[k] = v;
            // 纯派生列强制用系统值（第 22 轮审计 P1-1 之后的补充：派生列不接受手填/表填）
            payload.monthSettleAmount = auto.monthSettleAmount;
            payload.settleCount = auto.settleCount;
            payload.settlementId = auto.settlementId;
            await tx.settlementLedger.update({ where: { id: p.existingId }, data: { ...payload, version: { increment: 1 } } });
            updated += 1;
          } else {
            await this.createLedger(p.data, projectId, tx, { fromImport: true });
            created += 1;
          }
        }
        return { created, updated };
      },
    }, meta?.validateOnly ?? false);
  }
}

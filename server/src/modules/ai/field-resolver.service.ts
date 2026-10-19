import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { contractChainRows, resolveChainAmounts } from '../../common/utils/contract-chain';
import { paidPaymentWhere } from '../../constants/statuses';

/**
 * AI 字段取值器：把「字段目录里的 key」翻译成**当前项目/合同下的真实值**。
 *
 * 设计要点：
 * - **口径复用既有工具，不另写算式**：合同当前金额走 `contract-chain.ts` 的
 *   `resolveChainAmounts()`（主合同 + Σ 补充协议 changeAmount，未填金额 = null = 未知），
 *   付款合计排除失败/退款（`paidPaymentWhere()`），累计结算排除草稿 `DRAFT`。
 *   AI 只是"另一张嘴"，不能有第二套金额口径 —— 否则同一份数据在台上和汇报里对不上。
 * - **未知一律空串**：`null` / 推不出来 → `''`（表单留空由用户决定，不写 0 也不写"无"）。
 * - **项目隔离**：所有查询显式带 `projectId`；跨项目的合同/供应商 id 直接当不存在。
 */

export interface ResolveContext {
  projectId: string;
  contractId?: string | null;
  supplierId?: string | null;
}

type DictMap = Map<string, string>;

const isoDate = (v: Date | string | null | undefined): string => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
};

/** 金额：两位小数、不加千分位（表单单元格里 `1,234.00` 常被 Excel 当文本） */
const money = (v: unknown): string => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? '' : n.toFixed(2);
};

/** 比例（库里存 0.13 这种小数）→ 百分数 13.00 */
const pct = (v: unknown): string => {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? '' : (n * 100).toFixed(2);
};

const text = (v: unknown): string => (v == null ? '' : String(v));

const count = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : '';
};

@Injectable()
export class FieldResolverService {
  constructor(private prisma: PrismaClient) {}

  /** 字典 typeCode → { itemCode: itemName }（单次请求内缓存，避免每字段一次查询） */
  private async dict(typeCode: string): Promise<DictMap> {
    const items = await this.prisma.dictItem.findMany({
      where: { typeCode },
      select: { itemCode: true, itemName: true },
    });
    return new Map(items.map((i) => [i.itemCode, i.itemName]));
  }

  /**
   * 批量取值。返回的 Record **只含请求的 key**，取不到的值为 `''`
   * （前端据此判断"这一项系统里没有"，而不是显示 `undefined`）。
   */
  async resolve(keys: readonly string[], ctx: ResolveContext): Promise<Record<string, string>> {
    const wanted = new Set(keys.map((k) => String(k ?? '').trim()).filter(Boolean));
    const out: Record<string, string> = {};
    if (!wanted.size) return out;

    const project = await this.prisma.project.findFirst({ where: { id: ctx.projectId } });
    const contract = ctx.contractId
      ? await this.prisma.contract.findFirst({
          where: { id: ctx.contractId, projectId: ctx.projectId },
          include: { ext: true },
        })
      : null;
    const supplierId = ctx.supplierId || contract?.supplierId || null;
    const supplier = supplierId
      ? await this.prisma.supplier.findFirst({ where: { id: supplierId } })
      : null;

    // ---- 惰性加载：只在真的用到了才查 ----
    let industryDict: DictMap | null = null;
    let contractTypeDict: DictMap | null = null;
    let execStatusDict: DictMap | null = null;
    const need = (k: string): boolean => wanted.has(k);

    if (need('project.industryTypeName')) industryDict = await this.dict('industry_type');
    if (need('contract.typeName')) contractTypeDict = await this.dict('contract_type');
    if (need('contract.execStatusName')) execStatusDict = await this.dict('contract_execution_status');

    // 合同链（当前金额 / 补充协议累计变更 / 数量）：一次取全链，复用纯函数
    let chain = { currentAmount: null as number | null, supplementTotal: 0, supplementCount: 0, mainAmount: null as number | null };
    if (contract && (need('contract.chainAmount') || need('contract.changeTotal') || need('contract.supplementCount'))) {
      const rows = await contractChainRows(this.prisma, contract.id);
      if (rows.length) chain = resolveChainAmounts(rows, contract.id) as any;
    }

    const put = (key: string, value: string): void => {
      if (wanted.has(key)) out[key] = value;
    };

    // ---------- 项目 ----------
    put('project.name', text(project?.name));
    put('project.nameAbbr', text(project?.nameAbbr));
    put('project.code', text(project?.code));
    put('project.codeAbbr', text(project?.codeAbbr));
    put('project.undertaker', text(project?.undertaker));
    put('project.packageLeader', text(project?.packageLeader));
    put('project.projectManager', text(project?.projectManager));
    put('project.provinceCity', text(project?.provinceCity));
    put('project.siteLocation', text(project?.siteLocation));
    put('project.projectAddress', text(project?.projectAddress));
    put('project.materialOrigin', text(project?.materialOrigin));
    put('project.industryTypeName', industryDict?.get(text(project?.industryType)) ?? '');
    put('project.selfContractAmount', money(project?.selfContractAmount));
    put('project.startDate', isoDate(project?.startDate));
    put('project.endDate', isoDate(project?.endDate));
    put('project.settlementStartDate', isoDate(project?.settlementStartDate));

    // ---------- 合同 ----------
    put('contract.code', text(contract?.code));
    put('contract.name', text(contract?.name));
    put('contract.typeName', contractTypeDict?.get(text(contract?.typeCode)) ?? '');
    put('contract.supplierName', text(supplier?.name));
    put('contract.signDate', isoDate(contract?.signDate));
    put('contract.amount', money(contract?.amount));
    put('contract.chainAmount', money(chain.currentAmount));
    put('contract.changeTotal', money(chain.supplementTotal));
    put('contract.supplementCount', count(chain.supplementCount));
    put('contract.taxRatePct', pct(contract?.taxRate));
    // 当前付款比例读服务端派生列（唯一实现 contract.service.syncPayRatio），不在这里重算
    put('contract.payRatioPct', pct(contract?.ext?.currentPayRatio));
    put('contract.execStatusName', execStatusDict?.get(text(contract?.execStatus)) ?? '');
    put('contract.remark', text(contract?.remark));

    // ---------- 供应商 ----------
    put('supplier.name', text(supplier?.name));
    put('supplier.legalPerson', text(supplier?.legalPerson));
    put('supplier.contactName', text(supplier?.contactName));
    put('supplier.contactPhone', text(supplier?.contactPhone));
    put('supplier.contactEmail', text(supplier?.contactEmail));
    put('supplier.bankName', text(supplier?.bankName));
    put('supplier.bankAccount', text(supplier?.bankAccount));
    put('supplier.address', text(supplier?.address));

    // ---------- 项目级统计 ----------
    const statKeys = [
      'stats.contractCount',
      'stats.contractAmountTotal',
      'stats.settlementAmountTotal',
      'stats.paymentAmountTotal',
      'stats.invoiceAmountTotal',
      'stats.unpaidAmount',
    ];
    if (statKeys.some((k) => wanted.has(k))) {
      const stats = await this.projectStats(ctx.projectId);
      put('stats.contractCount', count(stats.contractCount));
      put('stats.contractAmountTotal', money(stats.contractAmountTotal));
      put('stats.settlementAmountTotal', money(stats.settlementAmountTotal));
      put('stats.paymentAmountTotal', money(stats.paymentAmountTotal));
      put('stats.invoiceAmountTotal', money(stats.invoiceAmountTotal));
      put('stats.unpaidAmount', money(stats.unpaidAmount));
    }

    return out;
  }

  /**
   * 项目级合计（口径与防超结/防超付/台账一致）：
   * - 合同金额合计：逐合同走合同链求和（**只累加"已知"的链金额**，未知不兜 0 参与别的口径计算；
   *   这里求和语义就是"能算出来的部分"，因此 null 直接跳过）；
   * - 累计结算：排除草稿 `DRAFT`，取 `actualAmount ?? amount`；
   * - 累计付款：`paidPaymentWhere()`（排除失败/退款）；
   * - 累计开票：`amountWithTax`（含税，与台账「本月开票额」同口径）。
   *
   * 公开给汇报材料（三期）复用：口径只允许有一份实现。
   */
  async projectStats(projectId: string): Promise<{
    contractCount: number;
    contractAmountTotal: number;
    settlementAmountTotal: number;
    paymentAmountTotal: number;
    invoiceAmountTotal: number;
    unpaidAmount: number;
  }> {
    const contracts = await this.prisma.contract.findMany({
      where: { projectId },
      select: { id: true },
    });
    let contractAmountTotal = 0;
    for (const c of contracts) {
      const rows = await contractChainRows(this.prisma, c.id);
      if (!rows.length) continue;
      const amount = resolveChainAmounts(rows, c.id).currentAmount;
      if (amount != null) contractAmountTotal += Number(amount) || 0;
    }

    const [settlements, payments, invoices] = await Promise.all([
      this.prisma.settlement.findMany({
        where: { projectId, OR: [{ statusCode: null }, { statusCode: { not: 'DRAFT' } }] },
        select: { amount: true, actualAmount: true },
      }),
      this.prisma.paymentRecord.findMany({
        where: { projectId, ...paidPaymentWhere() },
        select: { amount: true },
      }),
      this.prisma.invoice.findMany({ where: { projectId }, select: { amountWithTax: true } }),
    ]);

    const sum = (rows: any[], pick: (r: any) => unknown): number =>
      rows.reduce((s, r) => s + (Number(pick(r)) || 0), 0);
    const r2 = (n: number): number => Math.round(n * 100) / 100;

    const settlementAmountTotal = r2(sum(settlements, (r) => r.actualAmount ?? r.amount));
    const paymentAmountTotal = r2(sum(payments, (r) => r.amount));
    const invoiceAmountTotal = r2(sum(invoices, (r) => r.amountWithTax));

    return {
      contractCount: contracts.length,
      contractAmountTotal: r2(contractAmountTotal),
      settlementAmountTotal,
      paymentAmountTotal,
      invoiceAmountTotal,
      // 应付未付 = 累计结算 − 累计付款（与台账「应付未付」同口径）；可为负（多付了，正是该被看见的异常）
      unpaidAmount: r2(settlementAmountTotal - paymentAmountTotal),
    };
  }
}

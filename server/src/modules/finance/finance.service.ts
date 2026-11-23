import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { num } from '../../common/calc/numeric';
import { canonicalMonthKey } from '../../common/calc/aggregate';
import { compareMonthKey } from '../../common/calc/time';
import { assertInProject, assertVersion, assertYearMonth, versionedUpdate } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { SettlementService } from '../settlement';
import { ContractService, updateContractFundingParams } from '../contract';
import { PAYMENT_MODES, modeTranchesOf, paymentModeViolation } from '../../common/utils/pay-ratio';
import { SysParamService } from '../../common/services/sys-param.service';
import {
  recalculatePayables,
  recomputePayableRows,
  round,
  payableDateOf,
  EMPTY_PAYABLE_DERIVED,
  type OverduePayableInput,
  type OverduePaymentInput,
} from './overdue-calculator';
import { summarizeOverdue, interestOf, buildOverdueStats } from '../../common/utils/overdue-summary';

/**
 * 内存分页切片（保理费用 / 逾期利息共用）。
 *
 * 为什么不做 SQL 分页：这两个列表的**合计行**是"该合同一共多少"（保理费用的合计、逾期利息的
 * `stats` 汇总），必须覆盖全量行；走 SQL 的 `skip/take` 就只剩当前页可汇总，口径会错。
 * 行数按月增长但量级很小（一个合同几十到几百行），先全量取回再切片最不容易出错。
 * 未传 `page`/`pageSize` 时**返回全量** —— 导出路径（Excel）依赖这个行为。
 */
function pageSlice<T>(rows: T[], query: any = {}): T[] {
  const pageSize = Number(query.pageSize);
  if (!pageSize || pageSize <= 0) return rows;
  const page = Math.max(1, Number(query.page) || 1);
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

/**
 * 资金费用服务（保理费用 / 逾期利息 / 合同资金参数）。
 *
 * ⚠️ **项目隔离例外（有意为之，勿"顺手"补 `projectId` 过滤）**：
 * 本模块的所有查询/写入都**不带** `projectId` 过滤，而是按 `contractId` 归属；
 * 归属校验由 controller 注入的 `@ProjectId()` + 本模块的 `contractScope(contractId, projectId)`
 * 共同完成（2026-10-20 补齐：此前注释声称"controller 已做入口校验"，但 controller 根本没有注入
 * `@ProjectId()`，任何有 finance:view 的用户拿到别项目的 contractId 就能读写）。
 * 原因：资金费用是**合同级**的下游台账，同一合同可能被跨项目的汇总视图复用；
 * 若在此再加一层 `projectId` 过滤，会导致「合同在 A 项目、费用记录查不到」的割裂。
 * 同一例外清单亦见 `docs/architecture.md` §5 与 `docs/03-API接口清单.md` §18。
 * 另两处同类例外：`dict`（全局字典）、`supplier`（受 `supplier.share.scope` 控制）。
 *
 * 补充（2026-11-18）：两个台账的**列表/导出**接口 `contractId` 为可选。不传时（前端默认视图，
 * 与结算台账一致）按 `where.contract.projectId = 当前项目` 出**跨合同全量**，这是本项目内
 * 唯一按 `projectId` 过滤的地方——它是**新增的读路径**，不改变上面"按 contractId 归属"的原则，
 * 也不是给旧查询补过滤。
 */

const FACTORING_FIELDS = [
  'contractId', 'seqNo', 'financingDate', 'financingAmount', 'actualReceipt',
  'financingInterest', 'handlingFee', 'settlementMonth', 'remark',
];
/** 应付款项（主表）可写字段：派生列（应付款金额/逾期起始/天数/利息）一律由引擎回写，不在白名单里 */
const PAYABLE_FIELDS = [
  'settlementMonth', 'materialAmount', 'paymentRatio', 'payableDate',
  'waived', 'prevCumulative', 'remark', 'isSettlementPeriod', 'periodSeq',
];
/** 付款流水（子表）可写字段 */
const PAYMENT_FIELDS = ['paymentDate', 'paymentAmount', 'remark'];

/**
 * 数值字段归一：空值 → null；非法值（NaN / Infinity）→ **400**。
 * 直接 `Number()` 交给 Prisma 会抛原始错误变成 500，用户只看到「服务器错误」；
 * 资金费用与逾期利息都是按金额计息的台账，非法值必须在入口挡掉。
 */
function finiteNumber(v: any, label: string): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new BadRequestException(`${label}必须是有效数字`);
  return n;
}

const fmt = (v: any) => {
  if (v === null || v === undefined || v === '') return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

@Injectable()
export class FinanceService {
  constructor(
    private prisma: PrismaClient,
    private excel: ExcelService,
    private sysParam: SysParamService,
    private styled: StyledExcelService,
    private settlement: SettlementService,
    private contractService: ContractService,
  ) {}

  // ==================== 合同资金参数 ====================

  /** 合同参数（付款模式/月利率/宽限期/上限比例），合同未设置时回落到系统参数默认值 */
  async contractParams(contractId: string, projectId?: string) {
    const contract: any = await this.contractScope(contractId, projectId);
    const [defRate, defGrace, defCap, mode100, mode3382] = await Promise.all([
      this.sysParam.get('finance.overdue.default_monthly_rate', '0.006'),
      this.sysParam.get('finance.overdue.default_grace_days', '7'),
      this.sysParam.get('finance.overdue.interest_cap_ratio', '0.05'),
      this.sysParam.get('finance.payment.mode_100_description'),
      this.sysParam.get('finance.payment.mode_3382_description'),
    ]);
    return {
      contractId,
      contractCode: contract.code,
      contractName: contract.name,
      supplierName: contract.supplier?.name || '',
      projectName: contract.project?.name || '',
      paymentMode: contract.paymentMode || '100',
      monthlyRate: num(contract.monthlyRate) ?? (Number(defRate) || 0.006),
      graceDays: contract.graceDays ?? (Number(defGrace) || 7),
      interestCapRatio: num(contract.interestCapRatio) ?? (Number(defCap) || 0.05),
      mode100Description: mode100,
      mode3382Description: mode3382,
      overrides: {
        monthlyRate: num(contract.monthlyRate),
        graceDays: contract.graceDays,
        interestCapRatio: num(contract.interestCapRatio),
        paymentMode: contract.paymentMode,
      },
    };
  }

  async updateContractParams(contractId: string, data: any, projectId?: string) {
    // 归档锁与项目归属都在 contractScope 里（找不到 / 不属于本项目都抛「合同不存在」）
    const contract: any = await this.contractScope(contractId, projectId);
    // 归档锁（document-relationships.md §5.2：归档后合同本体禁止写——这里改的正是合同行上的
    // 利率/付款模式等字段）。注意归档锁只拦本次**合同行写入**；下方的 recalcOverdue 属费用行
    // 补录口径（与归档后允许补录发票/付款同一决策），不受归档限制。
    if (contract.archivedAt) {
      throw new BadRequestException('合同已归档，禁止修改资金参数');
    }
    // 付款安排取值校验（与合同主流程同一份实现）：写错取值会让派生比例/逾期引擎
    // 拿不到分期定义，且从界面看不出来，必须在这里拦住。
    const modeMsg = paymentModeViolation(data.paymentMode);
    if (modeMsg) throw new BadRequestException(modeMsg);
    const payload: any = {};
    if (data.paymentMode !== undefined) payload.paymentMode = data.paymentMode || null;
    // 数值参数：NaN 会直接把 Prisma update 打成 500，负数会算出负利息，都必须在这里拦
    if (data.monthlyRate !== undefined) {
      const v = data.monthlyRate === null || data.monthlyRate === '' ? null : Number(data.monthlyRate);
      if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new BadRequestException('月利率必须为正数');
      payload.monthlyRate = v;
    }
    if (data.graceDays !== undefined) {
      const v = data.graceDays === null || data.graceDays === '' ? null : Number(data.graceDays);
      if (v !== null && (!Number.isInteger(v) || v < 0)) throw new BadRequestException('宽限期必须为非负整数');
      payload.graceDays = v;
    }
    if (data.interestCapRatio !== undefined) {
      const v = data.interestCapRatio === null || data.interestCapRatio === '' ? null : Number(data.interestCapRatio);
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw new BadRequestException('利息上限比例必须为非负数');
      payload.interestCapRatio = v;
    }
    // 合同行归 contract 模块所有：走对方的写入原语（字段口径/校验都在那边），不直接写表
    await updateContractFundingParams(this.prisma, contractId, payload);
    // 月利率/宽限期变了 → 先按新参数重算 OverdueInterest 的派生列（interestAmount/overdueInterest
    // 是持久化列，只有 recalcOverdue 会重算），再刷台账；付款模式变了 → 应付款日与利息起算都变，同样重算，
    // 且「当前生效付款比例」派生列（syncPayRatio 唯一实现）必须跟着切——台账列/逾期引擎/工作台预警都读它。
    if (data.monthlyRate !== undefined || data.graceDays !== undefined || data.paymentMode !== undefined) {
      await this.recalcOverdue(contractId);
      await this.settlement.syncLedgerByContract(contractId);
    }
    if (data.paymentMode !== undefined) {
      await this.contractService.syncPayRatio(contractId);
    }
    return this.contractParams(contractId);
  }

  /**
   * 按合同的付款模式为某结算月份生成应付款项（保留的旧入口）。
   * 主子表重构后它退化为「把该模式的期次直接传给 createOverdue」——分期生成只有**一处**实现，
   * 编辑器里也是先用 `paymentModes()` 拿到期次再当草稿编辑，口径完全一致。
   */
  async generateOverdueRows(contractId: string, settlementMonth: string, materialAmount: number, projectId?: string) {
    const params = await this.contractParams(contractId, projectId);
    const tranches = modeTranchesOf(params.paymentMode);
    if (!tranches?.length) throw new BadRequestException('自定义付款模式请手动录入应付款项');
    return this.createOverdue(
      {
        contractId,
        settlementMonth,
        materialAmount,
        tranches: tranches.map((t) => ({
          ratio: t.ratio,
          payableDate: payableDateOf(settlementMonth, t.plusMonths, t.day),
        })),
      },
      projectId,
    );
  }

  /** 可选付款安排（含各期比例/偏移/日期），供编辑器「按付款模式生成期次」使用 */
  paymentModes() {
    return Object.entries(PAYMENT_MODES).map(([mode, def]) => ({
      mode,
      label: def.label,
      tranches: def.tranches.map((t) => ({ ...t })),
    }));
  }

  // ==================== 保理费用台账 ====================

  /**
   * 按 id 取合同 + **项目归属校验**（资金费用的统一入口）。
   *
   * @param projectId 当前请求的项目上下文；不传则只校验合同存在（服务层内部调用/集成测试）。
   *   controller 一律注入 `@ProjectId()`，因此任何按 contractId 直达的路由（含列表、导出、
   *   按记录 id 改/删）都绕不过这道 404。
   */
  private async contractScope(contractId: string, projectId?: string) {
    if (!contractId) throw new NotFoundException('合同不存在');
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { supplier: { select: { name: true } }, project: { select: { name: true, codeAbbr: true } } },
    });
    return assertInProject(contract, projectId, '合同不存在');
  }

  /**
   * 保理费用列表（分页）。
   *
   * `contractId` **可选**：不传时按项目返回**全部合同**的保理费用行（页面与结算台账一样，
   * 打开即看全量，不需要先选合同）。项目隔离由 `where.contract.projectId` 保证；传了合同
   * 仍走 `contractScope` 的 404 校验（含跨项目防御）。
   *
   * ⚠️ 分页是**在内存里切片**的：合计 `totals` 必须覆盖**筛选后的全部行**（合计行就是"这些行
   * 一共多少"），若走 SQL 的 `skip/take` 就只能对当前页求和、口径会错。行数量级很小，
   * 先取全量再切片是这里最不容易出错的写法。
   */
  async listFactoring(contractId?: string, query: any = {}, projectId?: string) {
    const contract = contractId ? await this.contractScope(contractId, projectId) : null;
    if (!contractId && !projectId) throw new BadRequestException('缺少合同ID或项目上下文');
    // 不选合同 = 本项目全部合同的费用行；选了合同则锁定该合同
    const where: any = contractId ? { contractId } : { contract: { projectId } };
    const all = await this.prisma.factoringCost.findMany({
      where,
      orderBy: [{ contractId: 'asc' }, { seqNo: 'asc' }, { createdAt: 'asc' }],
      include: { contract: { select: { id: true, code: true, name: true, supplier: { select: { name: true } } } } },
    });
    // 筛选放在服务端：`settlementMonth` / `keyword`（备注）此前只在界面上有输入框、后端没生效
    const month = canonicalMonthKey(String(query.settlementMonth ?? '').trim());
    const keyword = String(query.keyword ?? '').trim().toLowerCase();
    const rows = all
      .filter((r: any) => !month || canonicalMonthKey(r.settlementMonth) === month)
      .filter((r: any) => !keyword || String(r.remark ?? '').toLowerCase().includes(keyword))
      .map((r: any) => ({
        ...r,
        supplierName: r.contract?.supplier?.name || '',
        contractCode: r.contract?.code || '',
        contractName: r.contract?.name || '',
      }));
    const totals = {
      financingAmount: round(rows.reduce((a: number, r: any) => a + (num(r.financingAmount) || 0), 0), 2),
      actualReceipt: round(rows.reduce((a: number, r: any) => a + (num(r.actualReceipt) || 0), 0), 2),
      financingInterest: round(rows.reduce((a: number, r: any) => a + (num(r.financingInterest) || 0), 0), 2),
      handlingFee: round(rows.reduce((a: number, r: any) => a + (num(r.handlingFee) || 0), 0), 2),
      totalCost: round(rows.reduce((a: number, r: any) => a + (num(r.totalCost) || 0), 0), 2),
    };
    return {
      contract: contract
        ? { id: contract.id, code: contract.code, name: contract.name, supplierName: contract.supplier?.name || '' }
        : null,
      list: pageSlice(rows, query),
      total: rows.length,
      totals,
    };
  }

  private factoringPayload(data: any, keep?: any) {
    // contractId 由 create() 显式注入（路径参数/表单），不从表单白名单里取——
    // 此前在白名单里过滤掉它又立刻校验 payload.contractId，create 永远 400。
    const payload = pickFields(data, FACTORING_FIELDS.filter((f) => f !== 'contractId'), { label: '保理费用' });
    const contractId = keep?.contractId ?? data.contractId;
    if (!keep && !contractId) throw new BadRequestException('缺少合同ID');
    if (contractId) payload.contractId = contractId;
    // 费用合计（含税）= 融资利息 + 手续费，服务端自动计算
    const interest = num(payload.financingInterest ?? keep?.financingInterest) || 0;
    const fee = num(payload.handlingFee ?? keep?.handlingFee) || 0;
    if (payload.financingInterest !== undefined || payload.handlingFee !== undefined || keep) {
      payload.totalCost = round(interest + fee, 2);
    }
    const labels: Record<string, string> = {
      financingAmount: '融资金额',
      actualReceipt: '实际到账金额',
      financingInterest: '融资利息',
      handlingFee: '手续费',
    };
    for (const k of Object.keys(labels)) {
      if (payload[k] !== undefined) payload[k] = finiteNumber(payload[k], labels[k]);
    }
    // 结算月份是台账「保理贴息」列的归集键（按字符串精确匹配），写成 2026-9 就永远不会被任何月份命中
    if (payload.settlementMonth !== undefined) assertYearMonth(payload.settlementMonth, '结算月份');
    // 前端传 YYYY-MM-DD 字符串，Prisma 需要完整 DateTime
    if (payload.financingDate !== undefined) {
      const d = payload.financingDate ? new Date(payload.financingDate) : null;
      payload.financingDate = d && !isNaN(d.getTime()) ? d : null;
    }
    return payload;
  }

  async createFactoring(data: any, projectId?: string) {
    await this.contractScope(data?.contractId, projectId);
    const payload = this.factoringPayload(data);
    const max = await this.prisma.factoringCost.aggregate({ where: { contractId: payload.contractId }, _max: { seqNo: true } });
    if (payload.seqNo === undefined) payload.seqNo = (max._max.seqNo || 0) + 1;
    const created = await this.prisma.factoringCost.create({ data: payload });
    // 保理贴息是台账的只读派生列（computeLedgerAutoFields 按合同+月抓取），
    // 写后必须重刷台账，否则台账停留在旧值直到无关事件触发同步。
    await this.settlement.syncLedgerByContract(payload.contractId);
    return created;
  }

  async updateFactoring(id: string, data: any, projectId?: string) {
    const old = await this.prisma.factoringCost.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('保理费用记录不存在');
    await this.contractScope(old.contractId, projectId);
    assertVersion(old, data);
    const payload: any = this.factoringPayload(data, old);
    delete payload.version;
    const updated = await versionedUpdate(this.prisma.factoringCost, id, old.version, payload);
    await this.settlement.syncLedgerByContract(updated.contractId);
    return updated;
  }

  async removeFactoring(id: string, projectId?: string) {
    const old = await this.prisma.factoringCost.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('保理费用记录不存在');
    await this.contractScope(old.contractId, projectId);
    await this.prisma.factoringCost.delete({ where: { id } });
    await this.settlement.syncLedgerByContract(old.contractId);
    return true;
  }

  async exportFactoring(contractId?: string, projectId?: string) {
    // 只用 listFactoring 的返回值：它的 `contract` 是精简版（id/code/name/supplierName），
    // 若与 contractScope 的完整合同对象做展开合并，后者会被覆盖掉，`contract.supplier?.name`
    // 恒为 undefined —— 导出标题会显示成「保理费用台账（）」。
    const { contract, list, totals } = await this.listFactoring(contractId, {}, projectId);
    // 不选合同 = 导整个项目的保理费用（页面「打开即看全量」自然也要能一次导全量）；
    // 此时标题里的合同换成项目，并补上供应商/合同两列，否则看不出某行属于哪个合同。
    if (!contract) {
      const project = projectId
        ? await this.prisma.project.findUnique({ where: { id: projectId }, select: { name: true } })
        : null;
      const buffer = await this.styled.exportTable({
        sheetName: '保理费用台账',
        logoColumn: true,
        title: `保理费用台账（${project?.name || '全部合同'}）`,
        columns: [
          { header: '供应商名称', key: 'supplierName', width: 180 },
          { header: '合同名称', key: 'contractName', width: 200 },
          { header: '合同编号', key: 'contractCode', width: 180 },
          { header: '序号', key: 'seqNo', width: 60, type: 'int' },
          { header: '融资到账时间', key: 'financingDate', width: 120, type: 'center' },
          { header: '融资金额', key: 'financingAmount', width: 130, type: 'money' },
          { header: '实际到账金额', key: 'actualReceipt', width: 130, type: 'money' },
          { header: '融资利息', key: 'financingInterest', width: 120, type: 'money' },
          { header: '手续费', key: 'handlingFee', width: 110, type: 'money' },
          { header: '费用合计（含税）', key: 'totalCost', width: 150, type: 'money' },
          { header: '结算月份', key: 'settlementMonth', width: 110, type: 'center' },
          { header: '备注', key: 'remark', width: 240 },
        ],
        rows: list.map((r: any) => ({
          supplierName: r.supplierName || '',
          contractName: r.contractName || '',
          contractCode: r.contractCode || '',
          seqNo: num(r.seqNo),
          financingDate: fmt(r.financingDate),
          financingAmount: num(r.financingAmount),
          actualReceipt: num(r.actualReceipt),
          financingInterest: num(r.financingInterest),
          handlingFee: num(r.handlingFee),
          totalCost: num(r.totalCost),
          settlementMonth: r.settlementMonth || '',
          remark: r.remark || '',
        })),
        totalsKeys: ['financingAmount', 'actualReceipt', 'financingInterest', 'handlingFee', 'totalCost'],
        totalsLabel: '合计',
      });
      return { buffer, filename: `保理费用台账-${project?.name || '全部合同'}.xlsx` };
    }
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('保理费用台账');
    const n = list.length + 4;
    this.styled.writeLogoHeader(ws, { title: `保理费用台账（${contract.supplierName || ''}）`, lastCol: 9 });
    ws.getCell(3, 1).value = `合同编号：${contract.code}　合同名称：${contract.name}`;
    const headers = ['序号', '融资到账时间', '融资金额', '实际到账金额', '融资利息', '手续费', '费用合计（含税）', '结算月份', '备注'];
    ws.getRow(4).values = headers;
    ws.getRow(4).font = { bold: true };
    list.forEach((r: any, i: number) => {
      ws.getRow(5 + i).values = [r.seqNo, fmt(r.financingDate), num(r.financingAmount), num(r.actualReceipt), num(r.financingInterest), num(r.handlingFee), num(r.totalCost), r.settlementMonth, r.remark || ''];
    });
    ws.getRow(n + 1).values = ['合计', '', totals.financingAmount, totals.actualReceipt, totals.financingInterest, totals.handlingFee, totals.totalCost, '', ''];
    ws.getRow(n + 1).font = { bold: true };
    ws.columns = [{ width: 6 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 12 }, { width: 10 }, { width: 16 }, { width: 12 }, { width: 24 }];
    const buf = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buf), filename: `保理费用台账-${contract.code}.xlsx` };
  }

  // ==================== 逾期利息台账（应付款项 + 付款流水） ====================

  /**
   * 重算并持久化整个合同的逾期利息台账（应付款项/付款流水的任何增删改后调用）。
   *
   * 主子表口径：应付款项（主）× 付款流水（子）→ 引擎跨期分配 → 派生列回写主表。
   * 派生列（应付款金额/逾期起始/计息金额/逾期天数/逾期利息）是**持久化快照**：
   * 写入时机不变（增删改后重算一次），读取时还会再按 asOfDate 现算一遍（见 listOverdue）。
   */
  private async recalcOverdue(contractId: string, asOfDate: Date = new Date()) {
    const params = await this.contractParams(contractId);
    const { payables, payments } = await this.loadOverdueTables(contractId);
    // 基准日只在 service 边界取一次并显式注入规则层；同一请求内的重算/统计不依赖多个「今天」
    const { derived } = recalculatePayables(payables, payments, {
      monthlyRate: params.monthlyRate,
      graceDays: params.graceDays,
      asOfDate,
      interestCapRatio: params.interestCapRatio,
    });
    for (let i = 0; i < payables.length; i++) {
      const d = derived.get(i);
      /**
       * 引擎判定该期不再逾期 / 不再有应付（例如付款被撤销、比例改回 0）时 `derived` 没有这一条。
       * 此时必须**清空**历史派生值：`if (!d) continue` + `?? undefined` 会把上次算出的
       * 逾期天数/利息留在库里，而导出/其他读方若取存储列，就会"期已不逾期、利息还在"，台账虚高。
       */
      await this.prisma.overduePayable.update({
        where: { id: payables[i].id as string },
        data: {
          monthlyRate: params.monthlyRate,
          payableAmount: d?.payableAmount ?? null,
          overdueStartDate: d?.overdueStartDate ?? null,
          interestAmount: d?.interestAmount ?? null,
          overdueDays: d?.overdueDays ?? null,
          overdueInterest: d?.overdueInterest ?? null,
        },
      });
    }
    return params;
  }

  /** 取某合同的应付款项（主）+ 付款流水（子），并转成引擎入参（Decimal → number） */
  private async loadOverdueTables(contractId: string) {
    const [payableRows, paymentRows] = await Promise.all([
      this.prisma.overduePayable.findMany({
        where: { contractId },
        orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.overduePayment.findMany({
        where: { contractId },
        orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    return {
      payableRows,
      paymentRows,
      payables: payableRows.map((r: any) => this.toPayableInput(r)),
      payments: paymentRows.map((r: any) => this.toPaymentInput(r)),
    };
  }

  /** Prisma 行 → 引擎入参（单合同/跨合同/预览三条路径共用，Decimal 归一为 number） */
  private toPayableInput(r: any): OverduePayableInput {
    return {
      id: r.id,
      settlementMonth: r.settlementMonth,
      periodSeq: r.periodSeq,
      materialAmount: num(r.materialAmount),
      paymentRatio: num(r.paymentRatio),
      payableDate: r.payableDate,
      waived: r.waived,
      prevCumulative: num(r.prevCumulative),
      remark: r.remark,
      isSettlementPeriod: r.isSettlementPeriod,
    };
  }

  private toPaymentInput(r: any): OverduePaymentInput {
    return {
      id: r.id,
      paymentDate: r.paymentDate,
      paymentAmount: num(r.paymentAmount) ?? 0,
      remark: r.remark,
    };
  }

  /**
   * 汇总本期视图的 stats：`totalPayment`（付款金额合计）**必须由付款流水侧给出**——
   * 主子表里付款额不挂在应付款项上，直接对行求和会恒得 0。
   * 这里取「视图内各期已分配到的付款额之和」，与表格「已付金额」列合计一致。
   */
  private summarizePayables(rows: any[]) {
    const paid = round(rows.reduce((a: number, r: any) => a + (num(r.paidAmount) || 0), 0), 2) || 0;
    return summarizeOverdue(rows as any[], (r) => interestOf(r), { totalPayment: paid });
  }

  /**
   * 逾期利息台账列表（页面与导出共用）。
   *
   * `contractId` **可选**：传了就是「某个合同的逾期利息计算表」（导出、签字区、上限比例都是
   * 合同级的，语义不变）；不传则按项目返回**全部合同**的期，页面与结算台账一样打开即看全量。
   * 跨合同时**每个合同用自己的月利率/宽限期/上限比例重算**（共用一套参数会算错利息），
   * `stats` 上限金额取各期「材料款 × 本合同中比例」之和，展示的 `capRatio` 是对应的加权比例。
   *
   * 一行 = 一期应付款项（含期次列）。同月多期就是多行，**不再按「合同+月份」合并**——
   * 合并是旧单表模型（材料款行 + 付款行 + 计息承载行）为"看起来像一行"打的展示补丁，
   * 现在主子结构本身就已经是一行一期，合并反而会把不同应付款日/不同比例的两期粘在一起。
   *
   * 读时重算：派生列不再读库内上次写入的快照，而是按本次查询的 asOfDate 走同一个
   * `recalculatePayables` 引擎现算一遍，彻底消除"过了几天没再编辑、未付完的利息却停在旧日期"。
   *
   * 关键顺序：**先全量取行再重算**——付款分配按逾期起始日跨月进行，若先按 settlementMonth
   * 过滤再做引擎重算，会漏掉跨月分配片段导致利息错误；故筛选只能发生在重算之后。
   */
  async listOverdue(contractId?: string, query: any = {}, projectId?: string, asOfDate?: Date) {
    const asOf = asOfDate instanceof Date && !isNaN(asOfDate.getTime()) ? asOfDate : new Date();
    const monthFilter = canonicalMonthKey(String(query.settlementMonth ?? '').trim());
    const pick = <T extends { settlementMonth?: string | null }>(rows: T[]): T[] =>
      monthFilter ? rows.filter((r) => canonicalMonthKey(r.settlementMonth) === monthFilter) : rows;

    if (contractId) {
      const params = await this.contractParams(contractId, projectId);
      const { payables, payments } = await this.loadOverdueTables(contractId);
      // 读时重算：基准日缺省取当前时刻（边界取一次），显式注入时用于单测/定时刷新等稳定口径
      const { rows: fresh } = recomputePayableRows(payables, payments, {
        monthlyRate: params.monthlyRate,
        graceDays: params.graceDays,
        asOfDate: asOf,
        interestCapRatio: params.interestCapRatio,
      });
      const scoped = pick(fresh as any[]).map((r: any) => ({
        ...r,
        supplierName: params.supplierName,
        contractCode: params.contractCode,
        contractName: params.contractName,
      }));
      scoped.sort(this.comparePayableRows);
      return {
        contract: params,
        list: pageSlice(scoped, query),
        total: scoped.length,
        stats: buildOverdueStats(this.summarizePayables(scoped), params.interestCapRatio),
      };
    }

    if (!projectId) throw new BadRequestException('缺少合同ID或项目上下文');
    return this.listOverdueByProject(projectId, query, asOf, pick);
  }

  /** 期次排序：结算月 → 期次 → 应付款日期（汇总的「上期开累」取当前结算月首行，顺序不能乱） */
  private comparePayableRows = (a: any, b: any): number =>
    compareMonthKey(canonicalMonthKey(a.settlementMonth) ?? '', canonicalMonthKey(b.settlementMonth) ?? '') ||
    (Number(a.periodSeq) || 0) - (Number(b.periodSeq) || 0) ||
    new Date(a.payableDate || 0).getTime() - new Date(b.payableDate || 0).getTime();

  /** 系统参数里的逾期默认值（跨合同批量视图一次取齐，避免逐合同重复查参数表） */
  private async overdueDefaults() {
    const [defRate, defGrace, defCap] = await Promise.all([
      this.sysParam.get('finance.overdue.default_monthly_rate', '0.006'),
      this.sysParam.get('finance.overdue.default_grace_days', '7'),
      this.sysParam.get('finance.overdue.interest_cap_ratio', '0.05'),
    ]);
    return { rate: Number(defRate) || 0.006, grace: Number(defGrace) || 7, cap: Number(defCap) || 0.05 };
  }

  /**
   * 跨合同视图：本项目全部合同的期，按合同分组各用自己的参数重算后合并。
   * 与单合同路径共用同一套重算引擎与汇总口径（`recomputePayableRows` / `summarizeOverdue`），
   * 保证「选一个合同看」与「看全部」对同一行给出相同数字。
   */
  private async listOverdueByProject(
    projectId: string,
    query: any,
    asOf: Date,
    pick: <T extends { settlementMonth?: string | null }>(rows: T[]) => T[],
  ) {
    const defaults = await this.overdueDefaults();
    const contracts: any[] = await this.prisma.contract.findMany({
      where: { projectId },
      select: {
        id: true, code: true, name: true, graceDays: true,
        monthlyRate: true, interestCapRatio: true,
        supplier: { select: { name: true } },
      },
    });
    const ids = contracts.map((c) => c.id);
    const byId = new Map<string, any>(contracts.map((c) => [c.id, c]));
    const [payableRows, paymentRows] = await Promise.all([
      this.prisma.overduePayable.findMany({
        where: { contractId: { in: ids } },
        orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.overduePayment.findMany({
        where: { contractId: { in: ids } },
        orderBy: [{ paymentDate: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);
    const paymentsByContract = new Map<string, OverduePaymentInput[]>();
    for (const p of paymentRows) {
      const list = paymentsByContract.get(p.contractId) || [];
      list.push(this.toPaymentInput(p));
      paymentsByContract.set(p.contractId, list);
    }
    const payablesByContract = new Map<string, any[]>();
    for (const p of payableRows) {
      const list = payablesByContract.get(p.contractId) || [];
      list.push(p);
      payablesByContract.set(p.contractId, list);
    }
    const merged: any[] = [];
    let capAmountSum = 0;
    for (const [cid, rows] of payablesByContract) {
      const c = byId.get(cid);
      if (!c) continue; // 合同被删/跨项目残留行：不展示，避免把越权数据带出
      const interestCapRatio = num(c.interestCapRatio) ?? defaults.cap;
      const { rows: fresh } = recomputePayableRows(
        rows.map((r: any) => this.toPayableInput(r)),
        paymentsByContract.get(cid) || [],
        {
          monthlyRate: num(c.monthlyRate) ?? defaults.rate,
          graceDays: c.graceDays ?? defaults.grace,
          asOfDate: asOf,
          interestCapRatio,
        },
      );
      const scoped = pick(fresh as any[]);
      capAmountSum += scoped.reduce((a, r: any) => a + (num(r.materialAmount) || 0) * interestCapRatio, 0);
      merged.push(
        ...scoped.map((r: any) => ({
          ...r,
          supplierName: c.supplier?.name || '',
          contractCode: c.code,
          contractName: c.name,
        })),
      );
    }
    merged.sort((a, b) => this.comparePayableRows(a, b) || String(a.contractId).localeCompare(String(b.contractId)));
    const summary = this.summarizePayables(merged);
    // 上限比例各合同可能不同 → 展示加权比例（Σ材料款×本合同中比例 ÷ Σ材料款）；
    // 于是 `buildOverdueStats` 用 材料款合计 × 加权比例 得到的上限金额 = 各合同上限之和。
    const weightedRatio = summary.totalMaterial ? capAmountSum / summary.totalMaterial : 0;
    return {
      contract: null,
      list: pageSlice(merged, query),
      total: merged.length,
      stats: buildOverdueStats(summary, weightedRatio),
    };
  }

  // ---------- 应付款项（主） CRUD ----------

  /** 期次归一：比例统一成 0-1 小数，应付款日期统一成 Date（前端传 YYYY-MM-DD 或 Date） */
  private normalizeTranches(tranches: any, fallbackRatio: any): { ratio: number; payableDate: Date | null }[] {
    const list = Array.isArray(tranches) && tranches.length ? tranches : [{ ratio: fallbackRatio }];
    return list.map((t: any, i: number) => {
      const ratio = t?.ratio === null || t?.ratio === undefined || t?.ratio === '' ? 1 : Number(t.ratio);
      if (!Number.isFinite(ratio) || ratio <= 0) {
        throw new BadRequestException(`第 ${i + 1} 期付款比例必须是大于 0 的数字`);
      }
      if (ratio > 1) throw new BadRequestException(`第 ${i + 1} 期付款比例不能超过 100%`);
      let payableDate: Date | null = null;
      if (t?.payableDate) {
        const d = new Date(t.payableDate);
        if (isNaN(d.getTime())) throw new BadRequestException(`第 ${i + 1} 期应付款日期不是有效日期`);
        payableDate = d;
      }
      return { ratio, payableDate };
    });
  }

  /**
   * 新建应付款项（支持一次建多期）。
   *
   * 入参：`{ contractId, settlementMonth, materialAmount, tranches?: [{ ratio, payableDate }],
   *          waived?, prevCumulative?, remark? }`
   * 材料款金额按各期比例**拆分**落库（`materialAmount = 材料款 × 比例`），与统计口径一致：
   * 材料款合计 = 各行之和 = 本期材料款总额。
   */
  async createOverdue(data: any, projectId?: string) {
    const contractId = String(data?.contractId || '').trim();
    if (!contractId) throw new BadRequestException('缺少合同ID');
    await this.contractScope(contractId, projectId);
    const settlementMonth = String(data?.settlementMonth || '').trim();
    if (!settlementMonth) throw new BadRequestException('结算月份不能为空');
    assertYearMonth(settlementMonth, '结算月份');
    const material = finiteNumber(data?.materialAmount, '材料款金额');
    if (material === null || material <= 0) throw new BadRequestException('材料款金额必须为正数');
    const waived = data?.waived === true;
    const prevCumulative = finiteNumber(data?.prevCumulative, '期初开累');
    const remark = data?.remark === undefined || data?.remark === null || data?.remark === '' ? null : String(data.remark);
    const tranches = this.normalizeTranches(data?.tranches, data?.paymentRatio);

    const max = await this.prisma.overduePayable.aggregate({
      where: { contractId, settlementMonth },
      _max: { periodSeq: true },
    });
    let seq = max._max.periodSeq || 0;
    const created = [];
    for (const t of tranches) {
      seq += 1;
      created.push(
        await this.prisma.overduePayable.create({
          data: {
            contractId,
            settlementMonth,
            periodSeq: seq,
            materialAmount: round(material * t.ratio, 2),
            paymentRatio: t.ratio,
            payableDate: t.payableDate,
            waived,
            prevCumulative,
            remark,
            isSettlementPeriod: true,
          },
        }),
      );
    }
    await this.recalcOverdue(contractId);
    await this.settlement.syncLedgerByContract(contractId);
    return created;
  }

  async updateOverdue(id: string, data: any, projectId?: string) {
    const old = await this.prisma.overduePayable.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('应付款项不存在');
    await this.contractScope(old.contractId, projectId);
    assertVersion(old, data);
    const payload = pickFields(data, PAYABLE_FIELDS, { label: '应付款项' });
    for (const k of ['materialAmount', 'paymentRatio', 'prevCumulative']) {
      if (payload[k] !== undefined) payload[k] = finiteNumber(payload[k], k);
    }
    if (payload.paymentRatio !== undefined && payload.paymentRatio !== null) {
      const r = Number(payload.paymentRatio);
      if (!Number.isFinite(r) || r <= 0 || r > 1) throw new BadRequestException('付款比例必须在 0-100% 之间');
    }
    if (payload.settlementMonth !== undefined && payload.settlementMonth !== null) {
      assertYearMonth(payload.settlementMonth, '结算月份');
    }
    if (payload.payableDate !== undefined) {
      const d = payload.payableDate ? new Date(payload.payableDate) : null;
      if (payload.payableDate && (!d || isNaN(d.getTime()))) throw new BadRequestException('应付款日期不是有效日期');
      payload.payableDate = d;
    }
    delete payload.version;
    await versionedUpdate(this.prisma.overduePayable, id, old.version, payload);
    await this.recalcOverdue(old.contractId);
    // 改了结算月份时新月份的台账「逾期利息」列也要重算；
    // syncLedgerByContract 按合同遍历全部月份并清后挂，单次调用已覆盖新旧月份。
    await this.settlement.syncLedgerByContract(old.contractId);
    return this.prisma.overduePayable.findUnique({ where: { id } });
  }

  async removeOverdue(id: string, projectId?: string) {
    const old = await this.prisma.overduePayable.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('应付款项不存在');
    await this.contractScope(old.contractId, projectId);
    await this.prisma.overduePayable.delete({ where: { id } });
    await this.recalcOverdue(old.contractId);
    await this.settlement.syncLedgerByContract(old.contractId);
    return true;
  }

  /**
   * 保存前预览（编辑器用）：把**草稿期次**并进该合同已有数据一起跑引擎，
   * 只回传草稿各期的派生值。与保存后的口径完全一致（同一个 `recalculatePayables`），
   * 前端不必自己复刻算法，也就不会出现"预览一个数、存完另一个数"。
   */
  async previewOverdue(body: any, projectId?: string) {
    const contractId = String(body?.contractId || '').trim();
    if (!contractId) throw new BadRequestException('缺少合同ID');
    const params = await this.contractParams(contractId, projectId);
    const drafts: any[] = Array.isArray(body?.drafts) ? body.drafts : [];
    if (!drafts.length) return { contract: params, rows: [] };
    const { payables: saved, payments } = await this.loadOverdueTables(contractId);
    const draftIds = new Set(drafts.map((d) => d?.id).filter(Boolean) as string[]);
    // 草稿替换同 id 的库内行，其余库内行保留：跨期分配必须看到**完整的**应付款项列表才准
    const merged: OverduePayableInput[] = [
      ...saved.filter((p) => !p.id || !draftIds.has(p.id)),
      ...drafts.map((d) => ({
        settlementMonth: String(d?.settlementMonth || '').trim(),
        periodSeq: Number(d?.periodSeq) || 999,
        materialAmount: finiteNumber(d?.materialAmount, '材料款金额'),
        paymentRatio: d?.paymentRatio === null || d?.paymentRatio === undefined ? 1 : Number(d.paymentRatio),
        payableDate: d?.payableDate ? new Date(d.payableDate) : null,
        waived: d?.waived === true,
      })),
    ];
    const { derived } = recalculatePayables(merged, payments, {
      monthlyRate: params.monthlyRate,
      graceDays: params.graceDays,
      asOfDate: new Date(),
      interestCapRatio: params.interestCapRatio,
    });
    const offset = merged.length - drafts.length;
    return {
      contract: params,
      rows: drafts.map((d, i) => {
        const r = derived.get(offset + i) ?? EMPTY_PAYABLE_DERIVED;
        return {
          periodSeq: Number(d?.periodSeq) || i + 1,
          materialAmount: finiteNumber(d?.materialAmount, '材料款金额'),
          paymentRatio: d?.paymentRatio ?? 1,
          payableAmount: r.payableAmount,
          overdueStartDate: r.overdueStartDate,
          interestAmount: r.interestAmount,
          overdueDays: r.overdueDays,
          overdueInterest: r.overdueInterest,
          paidAmount: r.paidAmount,
          remaining: r.remaining,
        };
      }),
      stats: buildOverdueStats(
        summarizeOverdue(
          merged as any[],
          (row, idx) => (row.waived ? 0 : derived.get(idx)?.overdueInterest || 0),
          {
            totalPayment:
              round(
                Array.from(derived.values()).reduce((a, d) => a + (d.paidAmount || 0), 0),
                2,
              ) || 0,
          },
        ),
        params.interestCapRatio,
      ),
    };
  }

  // ---------- 付款流水（子） CRUD ----------

  /**
   * 某合同的付款流水（含每笔钱抵到了哪几期、每段算了多少利息）。
   *
   * 分配结果由引擎现算：付款流水是**合同级**的，一笔付款可能横跨多期，
   * 前端要能回答"这笔钱抵了哪些应付款、各段多少天"，否则对账时只能看到总数。
   */
  async listOverduePayments(contractId: string, projectId?: string) {
    if (!contractId) throw new BadRequestException('缺少合同ID');
    const params = await this.contractParams(contractId, projectId);
    const { payables, payments, paymentRows } = await this.loadOverdueTables(contractId);
    const { derived } = recalculatePayables(payables, payments, {
      monthlyRate: params.monthlyRate,
      graceDays: params.graceDays,
      asOfDate: new Date(),
      interestCapRatio: params.interestCapRatio,
    });
    const allocByPayment = new Map<string, any[]>();
    derived.forEach((d, idx) => {
      const p = payables[idx];
      for (const c of d.chunks) {
        if (!c.paymentId) continue;
        const list = allocByPayment.get(c.paymentId) || [];
        list.push({
          payableId: p?.id ?? null,
          settlementMonth: p?.settlementMonth ?? null,
          periodSeq: p?.periodSeq ?? null,
          amount: c.amount,
          overdueDays: c.overdueDays,
          interest: c.interest,
        });
        allocByPayment.set(c.paymentId, list);
      }
    });
    return {
      contract: params,
      list: paymentRows.map((r: any) => ({ ...r, allocations: allocByPayment.get(r.id) || [] })),
    };
  }

  async createOverduePayment(data: any, projectId?: string) {
    const contractId = String(data?.contractId || '').trim();
    if (!contractId) throw new BadRequestException('缺少合同ID');
    await this.contractScope(contractId, projectId);
    const amount = finiteNumber(data?.paymentAmount, '付款金额');
    if (amount === null || amount <= 0) throw new BadRequestException('付款金额必须为正数');
    const date = data?.paymentDate ? new Date(data.paymentDate) : null;
    if (!date || isNaN(date.getTime())) throw new BadRequestException('付款日期不是有效日期');
    const remark = data?.remark ? String(data.remark) : null;
    const created = await this.prisma.overduePayment.create({
      data: { contractId, paymentDate: date, paymentAmount: amount, remark },
    });
    await this.recalcOverdue(contractId);
    await this.settlement.syncLedgerByContract(contractId);
    return created;
  }

  async updateOverduePayment(id: string, data: any, projectId?: string) {
    const old = await this.prisma.overduePayment.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('付款记录不存在');
    await this.contractScope(old.contractId, projectId);
    assertVersion(old, data);
    const payload = pickFields(data, PAYMENT_FIELDS, { label: '付款记录' });
    if (payload.paymentAmount !== undefined) {
      const amount = finiteNumber(payload.paymentAmount, '付款金额');
      if (amount === null || amount <= 0) throw new BadRequestException('付款金额必须为正数');
      payload.paymentAmount = amount;
    }
    if (payload.paymentDate !== undefined) {
      const d = payload.paymentDate ? new Date(payload.paymentDate) : null;
      if (!d || isNaN(d.getTime())) throw new BadRequestException('付款日期不是有效日期');
      payload.paymentDate = d;
    }
    delete payload.version;
    await this.prisma.overduePayment.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
    await this.recalcOverdue(old.contractId);
    await this.settlement.syncLedgerByContract(old.contractId);
    return this.prisma.overduePayment.findUnique({ where: { id } });
  }

  async removeOverduePayment(id: string, projectId?: string) {
    const old = await this.prisma.overduePayment.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('付款记录不存在');
    await this.contractScope(old.contractId, projectId);
    await this.prisma.overduePayment.delete({ where: { id } });
    await this.recalcOverdue(old.contractId);
    await this.settlement.syncLedgerByContract(old.contractId);
    return true;
  }

  /** 逾期利息计算表导出（含标题、统计区、签字区，格式与 Excel 模板一致） */
  async exportOverdue(contractId?: string, query: any = {}, projectId?: string) {
    // 计算表的统计区/签字区/上限比例都是**合同级**口径（表头还写着该合同的付款条件），
    // 跨合同导出一张表没有业务意义，这里明确要求先选合同，而不是静默导出一份混着多合同的表。
    if (!contractId) throw new BadRequestException('导出逾期利息计算表需要先选择合同');
    const { contract, list, stats } = await this.listOverdue(contractId, query, projectId);
    // strict 判空：listOverdue 在合同不存在时返回 contract=null（有 list 的兜底分支）
    if (!contract) throw new NotFoundException('合同不存在');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('逾期利息计算表');
    this.styled.writeLogoHeader(ws, { title: '逾期利息计算表', lastCol: 14 });
    // 付款条件文案取付款模式定义里的说明（与合同页/资金参数同一份）
    const modeLabel = PAYMENT_MODES[contract.paymentMode as string]?.label || contract.paymentMode || '';
    ws.getCell(3, 1).value = `供应商：${contract.supplierName}　　付款条件：${modeLabel}`;
    ws.getCell(3, 2).value = '';
    const headers = [
      '结算月份', '期次', '材料款金额', '付款比例', '应付款金额', '应付款日期', '逾期起始日期',
      '已付金额', '未付余额', '计息金额', '逾期天数', '延期月利率', '逾期利息（含税）', '备注',
    ];
    ws.getRow(4).values = headers;
    ws.getRow(4).font = { bold: true };
    list.forEach((r: any, i: number) => {
      ws.getRow(5 + i).values = [
        r.settlementMonth, num(r.periodSeq), num(r.materialAmount),
        r.paymentRatio === null || r.paymentRatio === undefined ? '' : `${round((num(r.paymentRatio) || 0) * 100, 2)}%`,
        num(r.payableAmount), fmt(r.payableDate), fmt(r.overdueStartDate),
        num(r.paidAmount), num(r.remaining), num(r.interestAmount),
        r.waived ? '减免' : num(r.overdueDays), num(r.monthlyRate),
        r.waived ? 0 : num(r.overdueInterest), r.remark || '',
      ];
    });
    let rowIdx = 5 + list.length;
    const statRows: (string | number | null)[][] = [
      ['合计', '', stats.totalMaterial, '', '', '', '', stats.totalPayment, '', '', '', '', stats.currentCumulative, ''],
      [`合同约定逾期利息上限比例：${(stats.capRatio * 100).toFixed(2)}%`, `上限金额：${stats.capAmount}`, '', '', '', '', '', '', '', '', '', '', `本期开累逾期利息占比：${stats.interestRatio}%`, ''],
      [`上期开累逾期利息：${stats.prevCumulative}`, `本月结算逾期利息：${stats.currentSettlement}`, '', '', '', '', '', '', '', '', '', '', '', ''],
      ['经办人：', '', '物资经理：', '', '商务经理：', '', '项目经理：', '', '', '', '', '', '', ''],
    ];
    for (const sr of statRows) {
      rowIdx += 1;
      ws.getRow(rowIdx).values = sr;
      ws.getRow(rowIdx).font = { bold: sr[0] === '合计' || String(sr[0]).startsWith('合同约定') };
    }
    ws.columns = [
      { width: 11 }, { width: 6 }, { width: 13 }, { width: 9 }, { width: 13 }, { width: 13 }, { width: 13 },
      { width: 12 }, { width: 12 }, { width: 12 }, { width: 9 }, { width: 11 }, { width: 15 }, { width: 20 },
    ];
    const buf = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buf), filename: `逾期利息计算表-${contract.contractCode}.xlsx` };
  }
}

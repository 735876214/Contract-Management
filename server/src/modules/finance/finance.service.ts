import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { num } from '../../common/calc/numeric';
import { canonicalMonthKey } from '../../common/calc/aggregate';
import { compareMonthKey } from '../../common/calc/time';
import { assertVersion, assertYearMonth, versionedUpdate } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { ExcelService } from '../../common/services/excel.service';
import { StyledExcelService } from '../../common/services/styled-excel.service';
import { SettlementService } from '../settlement';
import { ContractService, updateContractFundingParams } from '../contract';
import { paymentModeViolation } from '../../common/utils/pay-ratio';
import { SysParamService } from '../../common/services/sys-param.service';
import {
  recalculate,
  recomputeOverdueRows,
  round,
  modeTranches,
  payableDateOf,
  OverdueRowInput,
} from './overdue-calculator';
import { summarizeOverdue, interestOf, buildOverdueStats } from '../../common/utils/overdue-summary';
import { mergeOverdueRowsByMonth } from './overdue-merge';

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
const OVERDUE_FIELDS = [
  'contractId', 'settlementMonth', 'materialAmount', 'paymentRatio', 'payableDate',
  'paymentDate', 'paymentAmount', 'waived', 'prevCumulative', 'remark',
  'isSettlementPeriod', 'periodSeq',
];

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

  /** 按付款模式为某结算月份生成应付款行（3382 生成 2 行：80% + 20%） */
  async generateOverdueRows(contractId: string, settlementMonth: string, materialAmount: number, projectId?: string) {
    const params = await this.contractParams(contractId, projectId);
    const tranches = modeTranches(params.paymentMode);
    if (!tranches) throw new BadRequestException('自定义付款模式请手动录入应付款行');
    // 负值/NaN 会生成引擎不认的行（materialAmount<=0 不计息、NaN 直接写库失败变 500），入口先拦
    const material = Number(materialAmount);
    if (!Number.isFinite(material) || material <= 0) throw new BadRequestException('材料款金额必须为正数');
    assertYearMonth(settlementMonth, '结算月份');
    const exist = await this.prisma.overdueInterest.count({ where: { contractId, settlementMonth, materialAmount: { gt: 0 } } });
    if (exist > 0) throw new BadRequestException(`${settlementMonth} 已存在材料款行，请直接编辑或先删除`);
    const maxSeq = await this.prisma.overdueInterest.aggregate({ where: { contractId, settlementMonth }, _max: { periodSeq: true } });
    let seq = (maxSeq._max.periodSeq || 0);
    const created = [];
    for (const t of tranches.tranches) {
      seq += 1;
      const payableDate = payableDateOf(settlementMonth, t.plusMonths, t.day);
      created.push(
        await this.prisma.overdueInterest.create({
          data: {
            contractId,
            settlementMonth,
            materialAmount: round(material * t.ratio, 2),
            paymentRatio: t.ratio,
            payableDate,
            isSettlementPeriod: true,
            periodSeq: seq,
          },
        }),
      );
    }
    await this.recalcOverdue(contractId);
    return created;
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
    if (!contract) throw new NotFoundException('合同不存在');
    if (projectId && contract.projectId !== projectId) throw new NotFoundException('合同不存在');
    return contract;
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

  // ==================== 逾期利息台账 ====================

  /** 重算并持久化整个合同的逾期利息台账（任何增删改后调用） */
  private async recalcOverdue(contractId: string, asOfDate: Date = new Date()) {
    const params = await this.contractParams(contractId);
    const rows = await this.prisma.overdueInterest.findMany({
      where: { contractId },
      orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
    });
    const input: OverdueRowInput[] = rows.map((r: any) => ({
      id: r.id,
      settlementMonth: r.settlementMonth,
      materialAmount: num(r.materialAmount),
      paymentRatio: num(r.paymentRatio),
      payableDate: r.payableDate,
      paymentDate: r.paymentDate,
      paymentAmount: num(r.paymentAmount),
      waived: r.waived,
      prevCumulative: num(r.prevCumulative),
      remark: r.remark,
      isSettlementPeriod: r.isSettlementPeriod,
      periodSeq: r.periodSeq,
    }));
    // 基准日只在 service 边界取一次并显式注入规则层；同一个请求内的重算/统计不依赖多个「今天」。
    // 派生列仍然会在读取时停留在上次重算日（见 listOverdue 注释），本次先统一口径，不改写入时机。
    const { derived, stats } = recalculate(input, {
      monthlyRate: params.monthlyRate,
      graceDays: params.graceDays,
      asOfDate,
      interestCapRatio: params.interestCapRatio,
    });
    // 持久化派生字段（顺序与查询一致）
    const ordered = await this.prisma.overdueInterest.findMany({
      where: { contractId },
      orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    for (let i = 0; i < ordered.length; i++) {
      const d = derived.get(i);
      /**
       * 引擎判定该行不再逾期 / 不再有应付（例如付款被撤销、比例改回 0）时 `derived` 没有这一行。
       * 此时必须**清空**历史派生值：旧实现 `if (!d) continue` + `?? undefined` 会把上次算出的
       * 逾期天数/利息留在库里，而 `listOverdue()` 的汇总读的是存储列，于是"行已不逾期、利息还在"，
       * 台账逾期利息虚高。显式写 null 才是"这次没有值"。
       */
      await this.prisma.overdueInterest.update({
        where: { id: ordered[i].id },
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
    return stats;
  }

  /**
   * 逾期利息台账列表（页面与导出共用）。
   *
   * `contractId` **可选**：传了就是「某个合同的逾期利息计算表」（导出、签字区、上限比例都是
   * 合同级的，语义不变）；不传则按项目返回**全部合同**的行——页面与结算台账一样，打开即看全量。
   * 跨合同时**每个合同用自己的月利率/宽限期/上限比例重算**（共用一套参数会算错利息），
   * `stats` 上限金额取各行「材料款 × 本合同中比例」之和，展示的 `capRatio` 是对应的加权比例。
   *
   * 读时重算：派生列（overdueDays / overdueInterest 等）不再读库内上次写入的快照，
   * 而是按本次查询的 asOfDate 走**同一个 recalculate 引擎**现算一遍再展示，彻底消除
   * "过了几天没再编辑，未付完的利息却停在旧日期"的陈旧值问题；库内列退化为写入快照。
   *
   * 关键顺序：
   * 1. **先全量取行再重算**——付款分配按逾期起始日跨月进行，若先按 settlementMonth
   *    过滤再做引擎重算，会漏掉跨月分配片段导致利息错误；故筛选只能发生在重算之后。
   * 2. 重算结果按 settlementMonth 过滤后汇总——保持"筛选视图只汇总被筛出的行"既有语义，
   *    但读的是刚算出的派生值（interestOf 从重算后的行取），不再是库内旧值。
   * 3. asOfDate 由 service 边界取一次并注入；单测可显式传入固定日期复现任意时点口径。
   */
  /**
   * 逾期台账展示合并：同一「合同 + 结算月」的多条记录（材料款主行 + 付款行/计息承载行）
   * 合并成一条展示行。统计/合计仍按未合并行计算，这里只影响列表与分页。
   */
  private mergeRows<T extends Record<string, any>>(rows: T[]): T[] {
    return mergeOverdueRowsByMonth(rows);
  }

  async listOverdue(contractId?: string, query: any = {}, projectId?: string, asOfDate?: Date) {
    const asOf = asOfDate instanceof Date && !isNaN(asOfDate.getTime()) ? asOfDate : new Date();
    const monthFilter = canonicalMonthKey(String(query.settlementMonth ?? '').trim());
    const pick = <T extends { settlementMonth?: string | null }>(rows: T[]): T[] =>
      monthFilter ? rows.filter((r) => canonicalMonthKey(r.settlementMonth) === monthFilter) : rows;

    if (contractId) {
      const params = await this.contractParams(contractId, projectId);
      // 全量取行（不在此处按 settlementMonth 过滤，理由见方法注释第 1 点）
      const rows = await this.prisma.overdueInterest.findMany({
        where: { contractId },
        orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
      });
      // 读时重算：基准日缺省取当前时刻（边界取一次），显式注入时用于单测/定时刷新等稳定口径
      const { rows: fresh } = recomputeOverdueRows(rows.map((r: any) => this.toOverdueInput(r)), {
        monthlyRate: params.monthlyRate,
        graceDays: params.graceDays,
        asOfDate: asOf,
        interestCapRatio: params.interestCapRatio,
      });
      // 筛选发生在重算之后：只汇总被筛出的行，但读的是重算后的派生值
      const scoped = pick(fresh as any[]);
      // 统计仍按未合并行汇总（金额口径不受展示合并影响）
      const summary = summarizeOverdue(scoped, (r) => interestOf(r));
      // 展示/分页按「合同 + 结算月」合并成一行
      const displayRows = this.mergeRows(
        scoped.map((r: any) => ({
          ...r,
          supplierName: params.supplierName,
          contractCode: params.contractCode,
          contractName: params.contractName,
        })),
      );
      return {
        contract: params,
        list: pageSlice(displayRows, query),
        total: displayRows.length,
        stats: buildOverdueStats(summary, params.interestCapRatio),
      };
    }

    if (!projectId) throw new BadRequestException('缺少合同ID或项目上下文');
    return this.listOverdueByProject(projectId, query, asOf, pick);
  }

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
   * 跨合同视图：本项目全部合同的逾期利息行，按合同分组各用自己的参数重算后合并。
   * 与单合同路径共用同一套重算引擎与汇总口径（`recomputeOverdueRows` / `summarizeOverdue`），
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
    const byId = new Map<string, any>(contracts.map((c) => [c.id, c]));
    const raw = await this.prisma.overdueInterest.findMany({
      where: { contractId: { in: contracts.map((c) => c.id) } },
      orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }, { createdAt: 'asc' }],
    });
    const groups = new Map<string, any[]>();
    for (const r of raw) {
      const list = groups.get(r.contractId) || [];
      list.push(r);
      groups.set(r.contractId, list);
    }
    const merged: any[] = [];
    let capAmountSum = 0;
    for (const [cid, rowsOfContract] of groups) {
      const c = byId.get(cid);
      if (!c) continue; // 合同被删/跨项目残留行：不展示，避免把越权数据带出
      const interestCapRatio = num(c.interestCapRatio) ?? defaults.cap;
      const { rows: fresh } = recomputeOverdueRows(rowsOfContract.map((r: any) => this.toOverdueInput(r)), {
        monthlyRate: num(c.monthlyRate) ?? defaults.rate,
        graceDays: c.graceDays ?? defaults.grace,
        asOfDate: asOf,
        interestCapRatio,
      });
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
    // 分组合并后按「结算月 → 期次」重排：汇总的「上期开累」取当前结算月首行，顺序不能乱
    merged.sort(
      (a, b) =>
        compareMonthKey(canonicalMonthKey(a.settlementMonth), canonicalMonthKey(b.settlementMonth)) ||
        (Number(a.periodSeq) || 0) - (Number(b.periodSeq) || 0),
    );
    const summary = summarizeOverdue(merged, (r) => interestOf(r));
    // 上限比例各合同可能不同 → 展示加权比例（Σ材料款×本合同中比例 ÷ Σ材料款）；
    // 于是 `buildOverdueStats` 用 材料款合计 × 加权比例 得到的上限金额 = 各合同上限之和。
    const weightedRatio = summary.totalMaterial ? capAmountSum / summary.totalMaterial : 0;
    // 展示/分页按「合同 + 结算月」合并成一行（统计仍用未合并的 merged）
    const displayRows = this.mergeRows(merged);
    return {
      contract: null,
      list: pageSlice(displayRows, query),
      total: displayRows.length,
      stats: buildOverdueStats(summary, weightedRatio),
    };
  }

  /** Prisma 行 → 计息引擎入参（Decimal 归一为 number；单合同/跨合同两条路径共用） */
  private toOverdueInput(r: any): OverdueRowInput {
    return {
      ...r,
      materialAmount: num(r.materialAmount),
      paymentRatio: num(r.paymentRatio),
      payableDate: r.payableDate,
      paymentDate: r.paymentDate,
      paymentAmount: num(r.paymentAmount),
      prevCumulative: num(r.prevCumulative),
      payableAmount: num(r.payableAmount),
      interestAmount: num(r.interestAmount),
      overdueDays: r.overdueDays,
      overdueInterest: num(r.overdueInterest),
      monthlyRate: num(r.monthlyRate),
    } as OverdueRowInput;
  }

  private async validateOverdue(data: any, keep?: any) {
    const contractId = data.contractId || keep?.contractId;
    if (!contractId) throw new BadRequestException('缺少合同ID');
    if (!keep && !String(data.settlementMonth || '').trim()) throw new BadRequestException('结算月份不能为空');
  }

  /**
   * 逾期利息行的数值/月份归一：非法数字 400（别让 Prisma 抛 500），
   * 结算月份必须是 YYYY-MM —— 台账「逾期利息」列按该字符串精确归集，写错就永远不命中。
   */
  private normalizeOverdueNumbers(payload: any) {
    const labels: Record<string, string> = {
      materialAmount: '材料款金额',
      paymentRatio: '付款比例',
      paymentAmount: '付款金额',
      prevCumulative: '期初开累',
    };
    for (const k of Object.keys(labels)) {
      if (payload[k] !== undefined) payload[k] = finiteNumber(payload[k], labels[k]);
    }
    if (payload.settlementMonth !== undefined && payload.settlementMonth !== null && payload.settlementMonth !== '') {
      assertYearMonth(payload.settlementMonth, '结算月份');
    }
  }

  async createOverdue(data: any, projectId?: string) {
    await this.validateOverdue(data);
    await this.contractScope(data?.contractId, projectId);
    const payload = pickFields(data, OVERDUE_FIELDS.filter((f) => f !== 'contractId'), { label: '逾期利息' });
    this.normalizeOverdueNumbers(payload);
    const contractId = data.contractId;
    const max = await this.prisma.overdueInterest.aggregate({ where: { contractId, settlementMonth: payload.settlementMonth }, _max: { periodSeq: true } });
    payload.periodSeq = (max._max.periodSeq || 0) + 1;
    payload.contractId = contractId;
    // 前端传 YYYY-MM-DD 字符串，Prisma 需要完整 DateTime
    for (const k of ['payableDate', 'paymentDate']) {
      if (payload[k] !== undefined) {
        const d = payload[k] ? new Date(payload[k]) : null;
        payload[k] = d && !isNaN(d.getTime()) ? d : null;
      }
    }
    const created = await this.prisma.overdueInterest.create({ data: payload });
    await this.recalcOverdue(contractId);
    await this.settlement.syncLedgerByContract(contractId);
    return created;
  }

  async updateOverdue(id: string, data: any, projectId?: string) {
    const old = await this.prisma.overdueInterest.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('逾期利息记录不存在');
    await this.contractScope(data?.contractId || old.contractId, projectId);
    assertVersion(old, data);
    await this.validateOverdue(data, old);
    const payload = pickFields(data, OVERDUE_FIELDS.filter((f) => f !== 'contractId'), { label: '逾期利息' });
    this.normalizeOverdueNumbers(payload);
    // 前端传 YYYY-MM-DD 字符串，Prisma 需要完整 DateTime
    for (const k of ['payableDate', 'paymentDate']) {
      if (payload[k] !== undefined) {
        const d = payload[k] ? new Date(payload[k]) : null;
        payload[k] = d && !isNaN(d.getTime()) ? d : null;
      }
    }
    delete payload.version;
    await versionedUpdate(this.prisma.overdueInterest, id, old.version, payload);
    await this.recalcOverdue(old.contractId);
    // 改了结算月份时新月份的台账「逾期利息」列也要重算；
    // syncLedgerByContract 按合同遍历全部月份并清后挂，单次调用已覆盖新旧月份。
    await this.settlement.syncLedgerByContract(old.contractId);
    return this.prisma.overdueInterest.findUnique({ where: { id } });
  }

  async removeOverdue(id: string, projectId?: string) {
    const old = await this.prisma.overdueInterest.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('逾期利息记录不存在');
    await this.contractScope(old.contractId, projectId);
    await this.prisma.overdueInterest.delete({ where: { id } });
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
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('逾期利息计算表');
    this.styled.writeLogoHeader(ws, { title: '逾期利息计算表', lastCol: 11 });
    ws.getCell(3, 1).value = `供应商：${contract.supplierName}　　付款条件：${contract.paymentMode === '3382' ? contract.mode3382Description : contract.mode100Description}`;
    ws.getCell(3, 2).value = '';
    const headers = ['结算月份', '材料款金额', '应付款日期', '逾期起始日期', '付款日期', '付款金额', '计息金额', '逾期天数', '延期月利率', '逾期利息（含税）', '备注'];
    ws.getRow(4).values = headers;
    ws.getRow(4).font = { bold: true };
    list.forEach((r: any, i: number) => {
      ws.getRow(5 + i).values = [
        r.settlementMonth, num(r.materialAmount), fmt(r.payableDate), fmt(r.overdueStartDate), fmt(r.paymentDate),
        num(r.paymentAmount), num(r.interestAmount), r.waived ? '减免' : num(r.overdueDays),
        num(r.monthlyRate), r.waived ? 0 : num(r.overdueInterest), r.remark || '',
      ];
    });
    let rowIdx = 5 + list.length;
    const statRows: (string | number | null)[][] = [
      ['合计', stats.totalMaterial, '', '', '', stats.totalPayment, '', '', '', stats.currentCumulative, ''],
      [`合同约定逾期利息上限比例：${(stats.capRatio * 100).toFixed(2)}%`, `上限金额：${stats.capAmount}`, '', '', '', '', '', '', '', `本期开累逾期利息占比：${stats.interestRatio}%`, ''],
      [`上期开累逾期利息：${stats.prevCumulative}`, `本月结算逾期利息：${stats.currentSettlement}`, '', '', '', '', '', '', '', '', ''],
      ['经办人：', '', '物资经理：', '', '商务经理：', '', '项目经理：', '', '', '', ''],
    ];
    for (const sr of statRows) {
      rowIdx += 1;
      ws.getRow(rowIdx).values = sr;
      ws.getRow(rowIdx).font = { bold: sr[0] === '合计' || String(sr[0]).startsWith('合同约定') };
    }
    ws.columns = [{ width: 11 }, { width: 13 }, { width: 12 }, { width: 13 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 11 }, { width: 15 }, { width: 20 }];
    const buf = await wb.xlsx.writeBuffer();
    return { buffer: Buffer.from(buf), filename: `逾期利息计算表-${contract.contractCode}.xlsx` };
  }
}

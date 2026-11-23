import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { num } from '../../common/calc/numeric';
import { localDayKey } from '../../common/calc/time';
import { groupSumByMonth, monthSequence } from '../../common/calc/index.ts';
import { resolveChainAmounts } from '../../common/utils/contract-chain';
import { evaluateAmountAlert, evaluatePaymentRatioAlert } from '../../common/utils/amount-alert';
import { paidPaymentWhere, countedInvoiceWhere, INVOICE_STATUS } from '../../constants/statuses';
import { sumSettlementAmount } from '../../common/utils/group-sum';
import { FINAL_SETTLEMENT_STATUS } from '../../constants/statuses';
import { CONTRACT_EXECUTION_STATUS, CONTRACT_STATUS, MILESTONE_STATUS, SETTLEMENT_STATUS } from '../../constants/statuses';
import { notDraft } from '../../common/utils/contract-chain';
import { TODO_CATEGORIES, type TodoGroup, type TodoLevel } from '../../constants/todoCategories';

/** 草稿超时阈值（与前端 OverdueDraftReminder / 合同起草页同一口径：新增后 2 小时内未完成） */
const OVERDUE_HOURS = 2;

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaClient) {}

  /**
   * 工作台总览：整项目 KPI。
   *
   * 走 **SQL 聚合**（P1-4）：此前是 5 条 `findMany` 把合同/台账/付款/发票/结算的整项目明细行取回内存再
   * reduce —— 只为了得到 7 个数字。明细行涨到十万级时，首屏就会把内存和带宽吃满，而聚合结果并不需要
   * 任何一行明细。`_sum` / `count` 的口径与原来的 `sumBy(rows, field)` 完全一致（NULL 计 0，两位小数）。
   */
  async overview(projectId: string, _user: any) {
    const [contractAgg, executingCount, ledgerSum, paymentSum, invoiceSum, settlementCount] =
      await Promise.all([
        this.prisma.contract.aggregate({
          where: { projectId },
          _count: { _all: true },
          _sum: { amount: true },
        }),
        this.prisma.contract.count({
          where: { projectId, execStatus: CONTRACT_EXECUTION_STATUS.EXECUTING },
        }),
        this.prisma.settlementLedger.aggregate({
          where: { projectId },
          _sum: { monthSettleAmount: true },
        }),
        // 只统计**构成实际出资**的付款（排除付款失败/已退款）——与防超付闸门、合同台账同一份清单，
        // 否则工作台的「累计付款额」会大于台账的同一口径数字（业务口径 2026-10-16）
        this.prisma.paymentRecord.aggregate({
          where: { projectId, ...paidPaymentWhere() },
          _sum: { amount: true },
        }),
        // 作废/红冲发票不计入「累计开票额」（业务口径 2026-11-12；空状态历史票仍计入）
        this.prisma.invoice.aggregate({
          where: { projectId, ...countedInvoiceWhere() },
          _sum: { amountWithTax: true },
        }),
        this.prisma.settlement.count({ where: { projectId } }),
      ]);
    /** 金额列统一「NULL → 0，两位小数」，与原先 `Number(sumBy(...).toFixed(2))` 同口径 */
    const money = (v: unknown) => Number((num(v) || 0).toFixed(2));
    return {
      contractCount: contractAgg._count._all,
      contractAmount: money(contractAgg._sum.amount),
      settleAmount: money(ledgerSum._sum.monthSettleAmount),
      paidAmount: money(paymentSum._sum.amount),
      invoiceAmount: money(invoiceSum._sum.amountWithTax),
      settlementCount,
      executingCount,
    };
  }

  /**
   * 近 12 个月收付款与结算趋势；`now` 由上层注入，规则层不读系统时钟。
   *
   * 按月聚合走 **SQL groupBy**（P1-4）：`settleMonth` / `payMonth` 本身就是 `YYYY-MM` 字符串，
   * 直接按它分组，每月只回一行；再把分组的月份键交给 `groupSumByMonth` 归一
   * （它仍然负责 `2026-9`/`2026年9月` 这类自由文本的容错与两位小数收敛，口径不搬到 SQL 里）。
   */
  async trend(projectId: string, now: Date = new Date()) {
    const [settleGroups, payGroups] = await Promise.all([
      this.prisma.settlementLedger.groupBy({
        by: ['settleMonth'],
        where: { projectId },
        _sum: { monthSettleAmount: true },
      }),
      // 只统计**构成实际出资**的付款（排除付款失败/已退款）——与防超付闸门、合同台账同一份清单，
      // 否则工作台的「累计付款额」会大于台账的同一口径数字（业务口径 2026-10-16）
      this.prisma.paymentRecord.groupBy({
        by: ['payMonth'],
        where: { projectId, ...paidPaymentWhere() },
        _sum: { amount: true },
      }),
    ]);
    const months = monthSequence(now, 12);
    const settleMap = groupSumByMonth(settleGroups, {
      monthOf: (g: any) => g.settleMonth,
      amountOf: (g: any) => g._sum?.monthSettleAmount,
    });
    const payMap = groupSumByMonth(payGroups, {
      monthOf: (g: any) => g.payMonth,
      amountOf: (g: any) => g._sum?.amount,
    });
    return months.map((m) => ({
      month: m,
      settleAmount: settleMap[m] || 0,
      paidAmount: payMap[m] || 0,
    }));
  }

  async contractType(projectId: string) {
    const contracts = await this.prisma.contract.groupBy({ by: ['typeCode'], where: { projectId }, _count: { _all: true }, _sum: { amount: true } });
    return contracts.map((c: any) => ({
      typeCode: c.typeCode,
      count: c._count._all,
      amount: Number((num(c._sum.amount) || 0).toFixed(2)),
    }));
  }

  async invoiceStats(projectId: string) {
    const [byType, byStatus] = await Promise.all([
      // 按类型汇总只统计有效发票（作废/红冲不计入金额与张数）；状态分布仍保留全部状态
      this.prisma.invoice.groupBy({ by: ['typeCode'], where: { projectId, ...countedInvoiceWhere() }, _count: { _all: true }, _sum: { amountWithTax: true } }),
      this.prisma.invoice.groupBy({ by: ['statusCode'], where: { projectId }, _count: { _all: true } }),
    ]);
    return {
      byType: byType.map((i: any) => ({ typeCode: i.typeCode, count: i._count._all, amount: Number((num(i._sum.amountWithTax) || 0).toFixed(2)) })),
      byStatus: byStatus.map((i: any) => ({ statusCode: i.statusCode, count: i._count._all })),
    };
  }

  /** 提醒：发票待查验 + 合同金额红/黄预警 */
  async reminders(projectId: string, _user: any) {
    const [pendingInvoices, amountAlerts, paymentRatioAlerts] = await Promise.all([
      this.prisma.invoice.findMany({ where: { projectId, statusCode: INVOICE_STATUS.WAIT_VERIFY }, take: 10 }),
      this.amountAlerts(projectId),
      this.paymentRatioAlerts(projectId),
    ]);
    return { pendingInvoices, ...amountAlerts, ...paymentRatioAlerts };
  }

  /**
   * 我的待办（业务口径 2026-10-16：为每个模块都预留一个待办位置 —— 0 条的分类也返回，
   * 前端的分类 Tab 常驻；需求 3：能给编辑器页签就给 `target.editor`，否则落到模块列表）。
   *
   * 分类注册表在 `constants/todoCategories.ts`（前后端镜像，由 dashboardTodo.spec.mts 锁死）；
   * 无权限的分类**整体不下发**（前端也不渲染其 Tab）。
   */
  async todos(projectId: string, user: any) {
    const permissions = new Set<string>(user?.permissions || []);
    const isSuperAdmin = !!user?.isSuperAdmin;
    const allowed = (p: string) => isSuperAdmin || permissions.has(p);

    const builders: Record<string, () => Promise<TodoGroup>> = {
      CONTRACT_DRAFT: () => this.todoContractDraft(projectId),
      CONTRACT_SIGN: () => this.todoContractSign(projectId),
      SETTLEMENT_DRAFT: () => this.todoSettlementDraft(projectId),
      FINAL_SETTLEMENT: () => this.todoFinalSettlement(projectId),
      PAYMENT_PROCEDURE: () => this.todoPaymentProcedure(projectId),
      INVOICE_VERIFY: () => this.todoInvoiceVerify(projectId),
      OVERDUE_INTEREST: () => this.todoOverdueInterest(projectId),
      PROCUREMENT_TODO: () => this.todoProcurement(projectId),
      OVERDUE_MILESTONE: () => this.todoOverdueMilestone(projectId),
    };

    const groups = await Promise.all(
      TODO_CATEGORIES.filter((c) => allowed(c.permission)).map(async (c) => {
        const group = await builders[c.key]();
        return { ...group, key: c.key, label: c.label };
      }),
    );
    return {
      generatedAt: new Date().toISOString(),
      total: groups.reduce((s, g) => s + g.count, 0),
      groups,
    };
  }

  /** 合同起草：草稿中且超时的合同（需求 2.1.3：新增后 2 小时内未完成） */
  private async todoContractDraft(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('CONTRACT_DRAFT');
    const since = new Date(Date.now() - OVERDUE_HOURS * 3600_000);
    const [rows, count] = await Promise.all([
      this.prisma.contract.findMany({
        where: { projectId, status: CONTRACT_STATUS.DRAFT, createdAt: { lt: since } },
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: { id: true, code: true, name: true, createdAt: true },
      }),
      this.prisma.contract.count({ where: { projectId, status: CONTRACT_STATUS.DRAFT, createdAt: { lt: since } } }),
    ]);
    return {
      key: 'CONTRACT_DRAFT',
      label: '',
      count,
      items: rows.map((c) => ({
        key: `contract:${c.id}:overdue`,
        title: c.name || '未命名合同',
        code: c.code || '',
        level: 'RED' as TodoLevel,
        hint: `创建于 ${localDayKey(c.createdAt)} ${c.createdAt.toTimeString().slice(0, 5)}，已超时`,
        target: { path: '/contract/draft', editor: c.id },
      })),
    };
  }

  /** 履约节点逾期（四域扩展按需项 2026-10-18）：未完成且计划日期已过的节点，按合同聚合 */
  private async todoOverdueMilestone(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('OVERDUE_MILESTONE');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const where = {
      projectId,
      planDate: { lt: today },
      statusCode: { notIn: [MILESTONE_STATUS.DONE, MILESTONE_STATUS.SKIPPED] },
      // 归档合同不出现在待办：过滤放进 where，保证 count 与 items 口径一致
      // （此前只对 items 后置过滤，count 会把已归档合同的节点也算进去）。
      contract: { archivedAt: null },
    };
    const [rows, count] = await Promise.all([
      this.prisma.contractFulfillment.findMany({
        where,
        orderBy: { planDate: 'asc' },
        take: limit,
        select: {
          id: true,
          name: true,
          planDate: true,
          contract: { select: { id: true, code: true, name: true, archivedAt: true } },
        },
      }),
      this.prisma.contractFulfillment.count({ where }),
    ]);
    return {
      key: 'OVERDUE_MILESTONE',
      label: '',
      count,
      items: rows
        .map((m) => ({
          key: `milestone:${m.id}:overdue`,
          title: `${m.contract.name || m.contract.code} · ${m.name}`,
          code: m.contract.code || '',
          level: 'RED' as TodoLevel,
          hint: `计划日期 ${localDayKey(m.planDate) || '未定'}，已逾期`,
          target: { path: '/contract/query', editor: m.contract.id },
        })),
    };
  }

  /** 合同待签章 */
  private async todoContractSign(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('CONTRACT_SIGN');
    const where = { projectId, status: CONTRACT_STATUS.APPROVING, archivedAt: null };
    const [rows, count] = await Promise.all([
      this.prisma.contract.findMany({
        where, orderBy: { createdAt: 'asc' }, take: limit,
        select: { id: true, code: true, name: true },
      }),
      this.prisma.contract.count({ where }),
    ]);
    return {
      key: 'CONTRACT_SIGN', label: '', count,
      items: rows.map((c) => ({
        key: `contract:${c.id}:sign`,
        title: c.name || '未命名合同',
        code: c.code || '',
        level: 'AMBER' as TodoLevel,
        target: { path: '/contract/query', editor: c.id },
      })),
    };
  }

  /** 结算单待提交（草稿） */
  private async todoSettlementDraft(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('SETTLEMENT_DRAFT');
    const where = { projectId, statusCode: SETTLEMENT_STATUS.DRAFT };
    const [rows, count] = await Promise.all([
      this.prisma.settlement.findMany({
        where, orderBy: { createdAt: 'asc' }, take: limit,
        select: { id: true, code: true, amount: true, contract: { select: { name: true } } },
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return {
      key: 'SETTLEMENT_DRAFT', label: '', count,
      items: rows.map((s) => ({
        key: `settlement:${s.id}:draft`,
        title: s.contract?.name || '结算单',
        code: s.code || '',
        level: 'AMBER' as TodoLevel,
        target: { path: '/settlement/order', editor: s.id },
      })),
    };
  }

  /** 总结算单待办理（未「已结算」） */
  private async todoFinalSettlement(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('FINAL_SETTLEMENT');
    // 总结算单只有 PENDING_ATTACHMENT / SETTLED 两个状态，DONE_SETTLED 是**合同执行状态**的值，
    // 写在这里永远匹配不到 → 已上传附件的单据永久滞留在工作台待办（第 5 轮审计）。
    const where = { projectId, statusCode: { not: FINAL_SETTLEMENT_STATUS.SETTLED } };
    const [rows, count] = await Promise.all([
      this.prisma.finalSettlement.findMany({
        where, orderBy: { createdAt: 'asc' }, take: limit,
        select: { id: true, code: true, statusCode: true, contract: { select: { name: true } } },
      }),
      this.prisma.finalSettlement.count({ where }),
    ]);
    return {
      key: 'FINAL_SETTLEMENT', label: '', count,
      items: rows.map((f) => ({
        key: `final-settlement:${f.id}`,
        title: f.contract?.name || '总结算单',
        code: f.code || '',
        level: 'AMBER' as TodoLevel,
        target: { path: '/settlement/final-settlement', editor: f.id },
      })),
    };
  }

  /** 付款手续待编制：口径 = 已有付款手续单据但尚未付款（payDate 为空）的，提示去处理 */
  private async todoPaymentProcedure(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('PAYMENT_PROCEDURE');
    const where = { projectId, payDate: null };
    const [rows, count] = await Promise.all([
      this.prisma.paymentProcedure.findMany({
        where, orderBy: { createdAt: 'asc' }, take: limit,
        select: { id: true, code: true, contract: { select: { name: true } } },
      }),
      this.prisma.paymentProcedure.count({ where }),
    ]);
    return {
      key: 'PAYMENT_PROCEDURE', label: '', count,
      items: rows.map((p) => ({
        key: `payment-procedure:${p.id}`,
        title: p.contract?.name || '付款手续',
        code: p.code || '',
        level: 'INFO' as TodoLevel,
        target: { path: '/settlement/payment-procedure', editor: p.id },
      })),
    };
  }

  /** 待查验发票 */
  private async todoInvoiceVerify(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('INVOICE_VERIFY');
    const where = { projectId, statusCode: INVOICE_STATUS.WAIT_VERIFY };
    const [rows, count] = await Promise.all([
      this.prisma.invoice.findMany({
        where, orderBy: { createdAt: 'asc' }, take: limit,
        select: { id: true, invoiceNo: true, issuer: true, amountWithTax: true },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    return {
      key: 'INVOICE_VERIFY', label: '', count,
      items: rows.map((i) => ({
        key: `invoice:${i.id}:verify`,
        title: i.issuer || '发票',
        code: i.invoiceNo || '',
        level: 'AMBER' as TodoLevel,
        target: { path: '/invoice', editor: i.id },
      })),
    };
  }

  /** 逾期利息待对账（已产生逾期利息的应付款项） */
  private async todoOverdueInterest(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('OVERDUE_INTEREST');
    // finance 模块按 contractId 归属（CLAUDE.md 铁律 3 的例外），故先取本项目合同再查其逾期行。
    // **不要加 take 上限**：合同 id 只是过滤条件（select 单列，开销很小），
    // 截断会让超出部分合同的逾期行静默从待办与计数里消失。
    const contracts = await this.prisma.contract.findMany({
      where: { projectId, archivedAt: null }, select: { id: true },
    });
    const contractIds = contracts.map((c) => c.id);
    if (!contractIds.length) return { key: 'OVERDUE_INTEREST', label: '', count: 0, items: [] };
    // 主子表改造后应付款项已经没有 paymentAmount 列，付清与否由引擎算出的
    // remaining/overdueInterest 表达：这里只挑「真的计了逾期利息且未减免」的期数，
    // 与列表页统计卡同口径（overdueInterest 由 recalcOverdue 持久化，null 即未计息）。
    const where = {
      contractId: { in: contractIds },
      waived: false,
      overdueInterest: { gt: 0 },
    };
    const [rows, count] = await Promise.all([
      this.prisma.overduePayable.findMany({
        where, orderBy: [{ settlementMonth: 'asc' }, { periodSeq: 'asc' }], take: limit,
        select: { id: true, contractId: true, settlementMonth: true, periodSeq: true, payableAmount: true, overdueInterest: true },
      }),
      this.prisma.overduePayable.count({ where }),
    ]);
    return {
      key: 'OVERDUE_INTEREST', label: '', count,
      items: rows.map((r) => ({
        key: `overdue:${r.id}`,
        title: `${r.settlementMonth || ''} 第 ${r.periodSeq || 1} 期逾期利息待对账`.trim(),
        code: '',
        level: 'AMBER' as TodoLevel,
        hint: `应付款 ${Number(r.payableAmount)} · 逾期利息 ${Number(r.overdueInterest)}`,
        target: { path: '/settlement/overdue' },
      })),
    };
  }

  /** 采购待编制（各阶段未填写/编辑中的采购任务） */
  private async todoProcurement(projectId: string): Promise<TodoGroup> {
    const limit = this.todoLimit('PROCUREMENT_TODO');
    const where = { projectId, status: { in: ['NOT_STARTED', 'LIST_EDITING'] } };
    const [rows, count] = await Promise.all([
      this.prisma.procurementTask.findMany({
        where, orderBy: { createdAt: 'asc' }, take: limit,
        select: { id: true, taskNo: true, content: true, status: true },
      }),
      this.prisma.procurementTask.count({ where }),
    ]);
    return {
      key: 'PROCUREMENT_TODO', label: '', count,
      items: rows.map((t) => ({
        key: `procurement:${t.id}`,
        title: t.content || '采购任务',
        code: t.taskNo,
        level: 'INFO' as TodoLevel,
        target: { path: '/procurement/initiate', editor: t.id },
      })),
    };
  }

  private todoLimit(key: string): number {
    return TODO_CATEGORIES.find((c) => c.key === key)?.limit ?? 8;
  }

  /**
   * 合同金额预警（业务口径 2026-10-15 澄清，阈值见 `common/utils/amount-alert.ts`）：
   * - 🔴 当前结算额 > 合同当前金额 × 110% 或 补充协议累计 > 主合同 × 130%
   * - 🟡 当前结算额 > 合同当前金额 × 80% 或 补充协议累计 > 主合同 × 110%
   *
   * 「合同当前金额」= 主合同 + Σ 补充协议带符号增量（与防超结上限同一实现）。
   * 只做**展示**：不拦截任何单据，也不改 `*_over_amount_policy` 的策略。
   *
   * 口径细节：按**链根**逐条算——合同链只能在内存里沿 `parentContractId` 解析（取的是窄列），
   * 而「结算额」本身是纯分组求和，已改由 SQL 按 contractId 聚合（P1-4），两边都不做 N+1。
   * 结算额排除草稿（与闸门一致）。主合同金额未填（金额未知）时该项无法判定 → 不报（宁漏勿误）。
   */
  private async amountAlerts(projectId: string) {
    const [contracts, settledByContract] = await Promise.all([
      // 合同行**必须**全量取回：金额预警要按合同链（主合同 + Σ 补充协议 changeAmount）逐条算，
      // 而链结构只能靠 parentContractId 在内存里解析。这里取的已是窄列（6 列），不再是明细表。
      this.prisma.contract.findMany({
        where: { projectId, archivedAt: null },
        select: { id: true, parentContractId: true, amount: true, changeAmount: true, code: true, name: true },
      }),
      // 结算额按合同聚合走 SQL（P1-4）：原来把整项目结算单明细取回内存按 contractId 求和。
      // 口径 = `actualAmount ?? amount`，由 `sumSettlementAmount` 在 SQL 侧精确复刻。
      sumSettlementAmount(this.prisma, 'contractId', { projectId, ...notDraft }),
    ]);

    const alerts: {
      contractId: string;
      code: string;
      name: string;
      level: string;
      reasons: string[];
      settledRatioPct: number | null;
      supplementRatioPct: number | null;
      currentAmount: number | null;
      settledTotal: number;
    }[] = [];

    // 只对链根出预警：补充协议单独出现没有意义（它的"当前金额"就是主合同的）
    for (const c of contracts.filter((x) => !x.parentContractId)) {
      const chain = resolveChainAmounts(contracts as any, c.id);
      const settledTotal = chain.chainIds.reduce((s, id) => s + (settledByContract.get(id) ?? 0), 0);
      const r = evaluateAmountAlert({
        mainAmount: chain.mainAmount,
        supplementTotal: chain.supplementTotal,
        currentAmount: chain.currentAmount,
        settledTotal,
      });
      if (!r.level) continue;
      alerts.push({
        contractId: c.id,
        code: c.code,
        name: c.name,
        level: r.level,
        reasons: r.reasons,
        settledRatioPct: r.settledRatioPct,
        supplementRatioPct: r.supplementRatioPct,
        currentAmount: chain.currentAmount,
        settledTotal: Number(settledTotal.toFixed(2)),
      });
    }

    // 红在前；同级按结算比例从高到低（比例未知的排最后）
    const rank = (a: (typeof alerts)[number]) => (a.level === 'RED' ? 0 : 1);
    alerts.sort(
      (a, b) => rank(a) - rank(b) || (b.settledRatioPct ?? -1) - (a.settledRatioPct ?? -1),
    );

    return {
      /** 预警明细（前端可只展示前 N 条，`total` 用于说明"还有多少条"） */
      amountAlerts: alerts.slice(0, 20),
      amountAlertTotal: alerts.length,
    };
  }

  /**
   * **付款超比例预警**（业务口径 2026-10-16）：开累付款 > 开累结算 × **当前生效比例**。
   *
   * 与 `amountAlerts`（结算是否超合同额）是**两个信号**，前端分列展示：
   * 一个问"结算超没超合同"，一个问"钱是不是付多了/付早了"。
   *
   * 口径与闸门/台账**共用同一实现**，不要就地拼：
   * - 开累结算 `chainSettledTotal` 的分子口径 = 结算单 `actualAmount`、排除草稿（SQL 按合同聚合后再按链累加）；
   * - 开累付款排除失败/退款（`paidPaymentWhere()`，空状态算有效付款）—— 与防超付闸门、合同台账同一份口径；
   * - 生效比例取 `ContractExt.currentPayRatio`（**派生列**，见 `contract.service.syncPayRatio`）。
   *
   * 只做**展示**：不拦截任何单据，也不改 `payment.over_amount_policy` 的策略。
   */
  private async paymentRatioAlerts(projectId: string) {
    const [contracts, settledByContract, paidGroups] = await Promise.all([
      this.prisma.contract.findMany({
        where: { projectId },
        select: { id: true, parentContractId: true, code: true, name: true },
      }),
      // 开累结算/开累付款按合同聚合走 SQL（P1-4）：口径见下方注释，不再取明细行
      sumSettlementAmount(this.prisma, 'contractId', { projectId, ...notDraft }),
      this.prisma.paymentRecord.groupBy({
        by: ['contractId'],
        where: { projectId, ...paidPaymentWhere() },
        _sum: { amount: true },
      }),
    ]);
    // 付款比例派生列只取本项目合同：原先无 where 全表读，合同数越多本接口越慢，
    // 也违反「查询必须自带 projectId」。父合同不在本项目时缺少派生列 → 该链按无比例跳过。
    const exts = contracts.length
      ? await this.prisma.contractExt.findMany({
          where: { contractId: { in: contracts.map((c) => c.id) } },
          select: { contractId: true, currentPayRatio: true },
        })
      : [];

    const paidByContract = new Map<string, number>(
      paidGroups
        .filter((g: any) => g.contractId)
        .map((g: any) => [String(g.contractId), num(g._sum?.amount) ?? 0]),
    );
    const ratioByContract = new Map(exts.map((e: any) => [e.contractId, e.currentPayRatio]));

    const alerts: {
      contractId: string;
      code: string;
      name: string;
      payRatio: number;
      settledTotal: number;
      paidTotal: number;
      limit: number;
      paidRatioPct: number | null;
      reason: string;
    }[] = [];

    // 只对链根出预警（补充协议单独看没有意义，与金额预警同一取舍）
    for (const c of contracts.filter((x: any) => !x.parentContractId)) {
      const chain = resolveChainAmounts(contracts as any, c.id);
      const settledTotal = chain.chainIds.reduce((s, id) => s + (settledByContract.get(id) ?? 0), 0);
      const paidTotal = chain.chainIds.reduce((s, id) => s + (paidByContract.get(id) ?? 0), 0);
      const ratio = ratioByContract.get(c.id);
      const r = evaluatePaymentRatioAlert({
        settledTotal,
        paidTotal,
        payRatio: ratio == null ? null : Number(ratio),
      });
      if (!r.exceeded) continue;
      alerts.push({
        contractId: c.id,
        code: c.code,
        name: c.name,
        payRatio: Number(ratio),
        settledTotal: Number(settledTotal.toFixed(2)),
        paidTotal: Number(paidTotal.toFixed(2)),
        limit: r.limit as number,
        paidRatioPct: r.paidRatioPct,
        reason: r.reason as string,
      });
    }

    // 超出幅度大的排前面（付款额 - 上限），便于先处理最严重的
    alerts.sort((a, b) => b.paidTotal - b.limit - (a.paidTotal - a.limit));

    return {
      paymentRatioAlerts: alerts.slice(0, 20),
      paymentRatioAlertTotal: alerts.length,
    };
  }
}

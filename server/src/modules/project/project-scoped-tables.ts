/**
 * **项目级业务表清单**（删除项目前的「有数据就拦住」清点范围）。
 *
 * 背景（2026-11-19 数据流转审计 P2）：`Project` 下的业务表外键几乎全是 `onDelete: Cascade`，
 * 删项目时由数据库静默连坐清空，操作日志里只留项目一行 —— 所以**任何**一张项目级表有数据
 * 都必须先拦住。此前这里只手工数了 15 类，漏掉履约节点、分包领用汇总、检查报告、
 * 采购过程文件、AI 分析报告等 14 张表，等于「有招标/评标数据的项目」仍可被无声删掉。
 *
 * 维护口径：与 `prisma/schema.prisma` 里 `@relation(fields: [projectId], references: [id], onDelete: Cascade)`
 * 的模型**必须一一对应**。这条一致性由 `server/test/projectDeleteScope.spec.mts` 机器锁定
 * （解析 schema 比对），加表后忘了登记会直接红。
 *
 * 不含 `ProjectMember`：它不是业务数据，删项目时自己 `deleteMany` 清掉（见 `ProjectService.remove`）。
 * 不含 `ProcurementTemplate.projectId` 为空的全局模板（查询按 `projectId` 过滤，自动只数项目内模板）。
 */
export interface ProjectScopedTable {
  /** Prisma 委托名（`prisma.<model>.count()`） */
  model: string;
  /** 中文标签（400 提示里逐项列出条数） */
  label: string;
}

export const PROJECT_SCOPED_TABLES: readonly ProjectScopedTable[] = [
  { model: 'contract', label: '合同' },
  { model: 'contractFulfillment', label: '合同履约节点' },
  { model: 'dailyReport', label: '总日报' },
  { model: 'settlement', label: '结算单' },
  { model: 'settlementLedger', label: '结算台账' },
  { model: 'invoice', label: '发票' },
  { model: 'paymentRecord', label: '付款记录' },
  { model: 'paymentProcedure', label: '付款手续' },
  { model: 'finalSettlement', label: '总结算单' },
  { model: 'receiptOrder', label: '收领单' },
  { model: 'assetLedger', label: '资产台账' },
  { model: 'repaymentAgreement', label: '还款协议' },
  { model: 'laborAuthLedger', label: '分包授权台账' },
  { model: 'laborReceivingDoc', label: '分包领用单据' },
  { model: 'laborReceivingSummary', label: '分包领用汇总' },
  { model: 'monthlyProfitLoss', label: '月度盈亏分析' },
  { model: 'inspectionReport', label: '检查报告' },
  { model: 'procurementTemplate', label: '项目级采购模板' },
  { model: 'procurementTask', label: '采购任务' },
  { model: 'procurementTotalItem', label: '采购总量明细' },
  { model: 'procurementNotice', label: '采购公告' },
  { model: 'procurementDocument', label: '采购过程文件' },
  { model: 'procurementPriceCompare', label: '价格对比表' },
  { model: 'procurementResultReport', label: '成交报告' },
  { model: 'procurementBidder', label: '投标单位' },
  { model: 'procurementEvaluation', label: '评标记录' },
  { model: 'frameworkExplanation', label: '框架说明' },
  { model: 'preMeetingMinutes', label: '会前会议纪要' },
  { model: 'aiAnalyticsReport', label: 'AI 经营分析报告' },
];

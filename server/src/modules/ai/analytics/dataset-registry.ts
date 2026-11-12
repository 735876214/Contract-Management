/**
 * AI 经营数据助手 · **数据集注册表（单一事实源）**。
 *
 * 模型 prompt、权限过滤、前端下拉、报告章节、Excel 列都读这一份定义；
 * 新增数据集必须同时登记：key / 中文名 / 说明 / 期间字段 / 读取权限 / 报告章节 / 实现进度。
 *
 * 门控（2026-11-12 评审确认）：
 * - `implemented: false` 的条目**不**出现在 `GET /datasets` 与意图 prompt 里，
 *   避免用户选到永远为空的数据集；
 * - 默认选中的 4 个必须是已实现条目；
 * - Phase 5 出口要求全部条目转为 `true`。
 *
 * 零依赖：只 import 类型，可被 `.mts` 单测直接加载。
 */

import type { AiReportSectionId } from './analytics.types.ts';

export interface AiDatasetDef {
  /** 注册表 key（`<域>.<对象>`），模型与前端只认它 */
  key: string;
  label: string;
  /** 一句话说明（给前端提示与 prompt 用） */
  desc: string;
  /** 读取该数据集所需的权限码（复用既有 `*:view`，不新增权限码） */
  permission: string;
  /** 期间归属字段（业务日期）；`null` = 累计/主数据，不做区间过滤 */
  periodField: string | null;
  reportSection: AiReportSectionId;
  /** 实现进度：false = 已登记、未实现，用户不可见 */
  implemented: boolean;
  defaultSelected?: boolean;
}

/**
 * 27 个业务单据域。前 18 个是 v1 覆盖范围（`implemented: true`，采集实现随 Phase 2–4 落地）；
 * 后 9 个是新纳入的域（`implemented: false`，Phase 5 转为 true 后对用户可见）。
 */
export const AI_DATASETS: readonly AiDatasetDef[] = [
  {
    key: 'project.base',
    label: '项目概况',
    desc: '项目基本信息与合同额等概况字段',
    permission: 'project:view',
    periodField: null,
    reportSection: 'projects',
    implemented: true,
  },
  {
    key: 'contract.summary',
    label: '合同汇总',
    desc: '按合同链口径汇总签约额与合同数量',
    permission: 'contract:view',
    periodField: 'signDate',
    reportSection: 'contracts',
    implemented: true,
    defaultSelected: true,
  },
  {
    key: 'contract.detail',
    label: '合同清单',
    desc: '逐份合同的编号、名称、供应商、金额与执行状态',
    permission: 'contract:view',
    periodField: 'signDate',
    reportSection: 'contracts',
    implemented: true,
  },
  {
    key: 'settlement.summary',
    label: '结算汇总',
    desc: '排除草稿的结算金额与结算单数量',
    permission: 'settlement:view',
    periodField: 'settleDate',
    reportSection: 'settlements',
    implemented: true,
    defaultSelected: true,
  },
  {
    key: 'settlement.detail',
    label: '结算单清单',
    desc: '逐张结算单的账期、金额与状态',
    permission: 'settlement:view',
    periodField: 'settleDate',
    reportSection: 'settlements',
    implemented: true,
  },
  {
    key: 'settlement.ledger',
    label: '结算台账',
    desc: '台账行与结算单 1:1 的开累金额、比例与欠款',
    permission: 'settlement:view',
    periodField: 'settleMonth',
    reportSection: 'settlements',
    implemented: true,
  },
  {
    key: 'payment.records',
    label: '付款记录',
    desc: '已完成付款记录（排除失败/退款）',
    permission: 'payment:view',
    periodField: 'payDate',
    reportSection: 'settlements',
    implemented: true,
    defaultSelected: true,
  },
  {
    key: 'invoice.records',
    label: '发票记录',
    desc: '有效发票（排除作废/红冲）的含税金额与张数',
    permission: 'invoice:view',
    periodField: 'invoiceDate',
    reportSection: 'settlements',
    implemented: true,
    defaultSelected: true,
  },
  {
    key: 'contract.fulfillment',
    label: '履约进度',
    desc: '合同链的已收/已结/已付比例与逾期节点',
    permission: 'contract:view',
    periodField: 'asOf',
    reportSection: 'fulfillment',
    implemented: true,
  },
  {
    key: 'cost.profit_loss',
    label: '月度盈亏',
    desc: '月度盈亏快照与六项降本创效金额',
    permission: 'cost:view',
    periodField: 'period',
    reportSection: 'cost',
    implemented: true,
  },
  {
    key: 'cost.labor_receiving',
    label: '分包领用汇总',
    desc: '分包单位 × 结算期 × 材料的领用与节超',
    permission: 'cost:view',
    periodField: 'period',
    reportSection: 'cost',
    implemented: true,
  },
  {
    key: 'procurement.task',
    label: '采购任务',
    desc: '采购任务与工作流阶段状态',
    permission: 'contract:view',
    periodField: 'createdAt',
    reportSection: 'procurement',
    implemented: true,
  },
  {
    key: 'procurement.result',
    label: '成交/报价',
    desc: '投标单位、两轮报价与定标结果',
    permission: 'contract:view',
    periodField: 'createdAt',
    reportSection: 'procurement',
    implemented: true,
  },
  {
    key: 'daily.report',
    label: '总日报',
    desc: '总日报行与现场确认状态',
    permission: 'daily:view',
    periodField: 'entryDate',
    reportSection: 'daily',
    implemented: true,
  },
  {
    key: 'receipt.order',
    label: '收领单',
    desc: '到货验收与实收数量',
    permission: 'receipt:view',
    periodField: 'orderDate',
    reportSection: 'daily',
    implemented: true,
  },
  {
    key: 'finance.cost',
    label: '保理/逾期利息',
    desc: '保理费用与逾期利息台账',
    permission: 'finance:view',
    periodField: 'financingDate',
    reportSection: 'funds',
    implemented: true,
  },
  {
    key: 'asset.flow',
    label: '资产进出场',
    desc: '物资进场、出场与费用汇总',
    permission: 'asset:view',
    periodField: 'date',
    reportSection: 'assets',
    implemented: true,
  },
  {
    key: 'supplier.concentration',
    label: '供应商集中度',
    desc: '按签约额计算的供应商份额与集中风险',
    permission: 'contract:view',
    periodField: null,
    reportSection: 'supplier',
    implemented: true,
  },
  {
    key: 'repayment.agreement',
    label: '还款协议',
    desc: '还款协议约定金额、已付与逾期未付',
    permission: 'repayment:view',
    periodField: 'signDate',
    reportSection: 'funds',
    implemented: false,
  },
  {
    key: 'final_settlement.summary',
    label: '工作总结算',
    desc: '总结算单与月度金额快照（附件上传完成即已结算）',
    permission: 'settlement:view',
    periodField: null,
    reportSection: 'settlements',
    implemented: false,
  },
  {
    key: 'payment_procedure.records',
    label: '付款手续',
    desc: '付款手续单与开累结算/付款快照',
    permission: 'payment:view',
    periodField: 'createdAt',
    reportSection: 'settlements',
    implemented: false,
  },
  {
    key: 'contract.change_log',
    label: '合同变更日志',
    desc: '合同字段级变更与补充协议增量',
    permission: 'contract:view',
    periodField: 'createdAt',
    reportSection: 'contracts',
    implemented: false,
  },
  {
    key: 'material.base',
    label: '物资主数据',
    desc: '物资基础库（名称/规格/分类/单位）',
    permission: 'material:view',
    periodField: null,
    reportSection: 'materials',
    implemented: false,
  },
  {
    key: 'material.contract',
    label: '合同物资清单',
    desc: '合同物资行的数量、单价与标准成本',
    permission: 'material:view',
    periodField: null,
    reportSection: 'materials',
    implemented: false,
  },
  {
    key: 'labor.auth',
    label: '分包授权台账',
    desc: '分包商档案与材料员授权委托书',
    permission: 'labor:view',
    periodField: null,
    reportSection: 'labor',
    implemented: false,
  },
  {
    key: 'labor.receiving_doc',
    label: '分包领用单据',
    desc: '分包领用单据头与汇总行（单据维度）',
    permission: 'labor:view',
    periodField: 'period',
    reportSection: 'labor',
    implemented: false,
  },
  {
    key: 'procurement.documents',
    label: '采购过程文件',
    desc: '采购公告/文件/价格对比/采前会/框架说明/考察报告/评标',
    permission: 'contract:view',
    periodField: 'createdAt',
    reportSection: 'procurement',
    implemented: false,
  },
];

/** 最多同时选择的数据集数量（prompt 与查询预算） */
export const MAX_DATASETS = 8;

/** 默认选中：合同汇总、结算汇总、付款、发票 */
export const DEFAULT_DATASET_KEYS: readonly string[] = AI_DATASETS.filter((d) => d.defaultSelected).map((d) => d.key);

const BY_KEY = new Map(AI_DATASETS.map((d) => [d.key, d]));

export function datasetByKey(key: string): AiDatasetDef | null {
  return BY_KEY.get(String(key ?? '')) ?? null;
}

/** 已实现的 key 集合（`GET /datasets` 与意图 prompt 只暴露这些） */
export const IMPLEMENTED_DATASET_KEYS: ReadonlySet<string> = new Set(
  AI_DATASETS.filter((d) => d.implemented).map((d) => d.key),
);

export interface DatasetVisibility {
  visible: AiDatasetDef[];
  /** 已实现但当前用户无权限的数据集（前端提示"无权限"用，不静默消失） */
  denied: AiDatasetDef[];
}

/**
 * 按权限过滤（单一实现）：只有**已实现**的条目参与可见性判断。
 * `can(code)` 与 `ai.service.ts` 的 `filterFieldsByPermission` 同一约定（超管恒 true）。
 */
export function filterDatasets(can: (code: string) => boolean): DatasetVisibility {
  const visible: AiDatasetDef[] = [];
  const denied: AiDatasetDef[] = [];
  for (const d of AI_DATASETS) {
    if (!d.implemented) continue;
    if (can(d.permission)) visible.push(d);
    else denied.push(d);
  }
  return { visible, denied };
}

/** 截断到上限（规则解析与用户显式选择共用） */
export function limitDatasets(keys: readonly string[], max = MAX_DATASETS): { keys: string[]; truncated: number } {
  const unique = [...new Set(keys.map((k) => String(k ?? '').trim()).filter(Boolean))];
  return { keys: unique.slice(0, max), truncated: Math.max(0, unique.length - max) };
}

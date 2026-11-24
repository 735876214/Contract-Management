import type { Dateish, ListParams, Paged } from './common.ts';

/**
 * 合同台账域的响应/请求类型。
 *
 * ## 真理源（改这里之前先改那边，否则 int spec 会红）
 *
 * - 行字段：`server/src/modules/ledger/ledger.service.ts` 的 `findAll()` 返回对象
 *   （literal 里 33 个键 + `deriveLedgerAmounts()` 展开的 6 个 + 若干局部变量速写）；
 * - 派生金额：`server/src/modules/ledger/ledger-derived.ts#deriveLedgerAmounts`（`@metric: ledger-derived-amounts`）；
 * - 列定义：`server/src/modules/ledger/ledger-columns.ts#LEDGER_COLUMNS`（宽是**像素**，后端已换算）；
 * - 请求参数：`findAll()` 里 `query.*` 实际读取的键（**不是**页面上筛选项的 label）。
 *
 * ⚠️ 2026-11-24 实测教训：页面 `extraFilters` 的 key 曾写成 `code/type/executionStatus/category`，
 * 而服务端认的是 `contractCode/typeCode/execStatus/supplierCategory` → **四个筛选器静默失效**
 * （发 `code=DEMO` 仍返回全部 2 条，发 `contractCode=DEMO` 才返回 1 条）。
 * 所以请求参数名也被 `api-shape-ledger.int.spec.ts` 双侧锁住。
 */

/** 三态（**空 ≠ 0**）：金额未填是 `null`，不是 0。 */
export type LedgerRow = {
  id: string;
  /** 行号（本页序号，1 起；跨页不连续） */
  index: number;
  contractCode: string;
  /** 归档时间（ISO 串）；未归档 → `null`。归档是**单向终态**，行内编辑/删除据此禁用 */
  archivedAt: Dateish;
  /** 财务一体化合同编号（方案外字段，未填时后端整个键都不下发 → 可选） */
  financeCode?: string | null;
  supplierName: string | null;
  /** 供应材料名（「、」连接，来自合同物资清单；只用于展示与筛选关键词） */
  materialNames: string;
  procurementSource: string;
  isDirectPurchase: string;
  contractName: string;
  bidName?: string | null;
  /** 合同执行情况（字典名） */
  execStatus: string;
  supplierCategory: string;
  legalPerson: string | null;
  authPerson: string | null;
  contactName: string | null;
  contactPhone: string | null;
  /**
   * 本行合同额（= 主合同自身金额，补充协议行是它自己的自由值）。
   * **未填 → `null`**（不是 0）；汇总「合同额」不要用它逐行相加，用 `chainRootId` 去重。
   */
  amount: number | null;
  /** 合同当前金额（链口径 = 主合同 + Σ 补充协议 `changeAmount`）；同链各行相同 */
  currentAmount: number | null;
  /** 税率（百分数口径：13 = 13%）；未填 → `null` */
  taxRate: number | null;
  /** 同上，导出列键（与全站单轨字段名一致） */
  taxRatePct: number | null;
  /** 合同约定付款比例（**小数**：0.65 = 65%）；未填 → `null` */
  currentPayRatio: number | null;
  paymentMethod: string;
  isSupplement: string;
  /** 链根 id：汇总「合同额」时按链只计一次的依据 */
  chainRootId: string;
  supplementType: string;
  bidStartDate: Dateish;
  bidWinDate: Dateish;
  signDate: Dateish;
  disclosureDate: Dateish;
  /** 首次进场（该合同下日报最早进场日） */
  firstEntryDate: Dateish;
  /** 合规性问题（`LEDGER_COMPLIANCE` 取值：无问题 / 未招标进场 / …）；内存派生列，库里没有 */
  compliance: string;
  complaint?: string | null;
  /** 开累结算额（结算台账「本月结算额」之和） */
  cumSettleAmount: number;
  /** 审定结算额（结算单 `actualAmount ?? amount` 之和，排除草稿） */
  auditedSettleAmount: number;
  /** 开累**税前**结算额（**发票派生**，2026-11-18 口径）；无票 0、有票算不出 `null` */
  cumSettleBeforeTax: number | null;
  /** 进项税额（同上前提） */
  cumInputTax: number | null;
  /** 开累开票额 */
  cumInvoiceAmount: number;
  /** 开累付款额 */
  cumPaidAmount: number;
  /** 应付 = 审定结算额 × 付款比例；比例未填 → `null` */
  payableAmount: number | null;
  /** 应付未付 = 应付 − 已付；比例未填 → `null` */
  unpaidAmount: number | null;
  /** 100% 欠款 = 审定结算额（无总结算书时退回开累结算额）− 已付 */
  debt100: number | null;
  /** 已结算占合同额（**百分数**：83.33 = 83.33%）；合同额未填 → `null` */
  settleRatio: number | null;
  /** 已付款占结算额（**百分数**）；无结算 → `null` */
  paidRatio: number | null;
  /** 合同额是否已填（显式 0 算已填；空串/空白不算） */
  amountFilled: boolean;
  /** 审减额 = 送审 − 审定 */
  settleReduceAmount: number;
  /** 每年结算额（年份 → 金额），按年份升序 */
  yearSettle: Record<string, number>;
  /** 每年付款额（年份 → 金额） */
  yearPaid: Record<string, number>;
};

/** 台账列表行**可能出现**的全部键（后端 literal 里的键，含值为 `undefined` 因而 JSON 里不下发的）。 */
export const LEDGER_ROW_KEYS = [
  'id',
  'index',
  'contractCode',
  'archivedAt',
  'financeCode',
  'supplierName',
  'materialNames',
  'procurementSource',
  'isDirectPurchase',
  'contractName',
  'bidName',
  'execStatus',
  'supplierCategory',
  'legalPerson',
  'authPerson',
  'contactName',
  'contactPhone',
  'amount',
  'currentAmount',
  'taxRate',
  'taxRatePct',
  'currentPayRatio',
  'paymentMethod',
  'isSupplement',
  'chainRootId',
  'supplementType',
  'bidStartDate',
  'bidWinDate',
  'signDate',
  'disclosureDate',
  'firstEntryDate',
  'compliance',
  'complaint',
  'cumSettleAmount',
  'auditedSettleAmount',
  'cumSettleBeforeTax',
  'cumInputTax',
  'cumInvoiceAmount',
  'cumPaidAmount',
  'payableAmount',
  'unpaidAmount',
  'debt100',
  'settleRatio',
  'paidRatio',
  'amountFilled',
  'settleReduceAmount',
  'yearSettle',
  'yearPaid',
] as const;

/**
 * 允许在 JSON 里**缺席**的键：值来自可空关联（`ext` / 供应商扩展）且没有兜底，
 * 后端取到 `undefined` 时 `JSON.stringify` 会整键丢弃。
 */
export const LEDGER_ROW_OPTIONAL_KEYS = ['financeCode', 'bidName', 'complaint'] as const;

/**
 * `GET /ledger/contracts` 实际认的查询参数名。
 *
 * ⚠️ 这里的键必须与服务端 `findAll()` 里 `query.*` 读取的键**逐字相同**；
 * 页面的 `extraFilters` 只允许用这个集合里的 key（`api-shape-ledger.int.spec.ts` 会比对）。
 */
export const LEDGER_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'keyword',
  'contractCode',
  'supplierId',
  'typeCode',
  'execStatus',
  'supplierCategory',
  'compliance',
] as const;

/** 台账列表查询参数（key 见 `LEDGER_LIST_PARAM_KEYS`）。 */
export interface LedgerListParams extends ListParams {
  /** 合同编号（模糊） */
  contractCode?: string;
  supplierId?: string;
  /** 合同类型（typeCode，不是字典名） */
  typeCode?: string;
  /** 合同执行情况（code，字典名请自行映射） */
  execStatus?: string;
  /** 分供方类别（存在 ContractExt 上） */
  supplierCategory?: string;
  /** 合规性问题（内存派生列，服务端两阶段筛选） */
  compliance?: string;
}

/** 台账动态列定义（`GET /ledger/columns` 与列表响应里的 `columns`）。 */
export interface LedgerColumn {
  key: string;
  title: string;
  /** **像素**宽（后端已把 Excel 字符宽统一换算，勿再乘系数） */
  width: number;
  /** 用户列设置里的可见性（未设置过 → 后端给默认值） */
  visible: boolean;
}

/** 台账列表响应：分页 + 动态列（列表接口顺带把列定义带回来）。 */
export type LedgerListResponse = Paged<LedgerRow> & { columns: LedgerColumn[] };

/**
 * 顶部统计卡（`GET /ledger/summary`，**不走**列表接口，增删改后要单独重取）。
 * 金额合计口径与列表一致：合同额按**链**只计一次（`chainRootId` 去重）。
 */
export interface LedgerSummary {
  /** 合同**行数**（含补充协议行） */
  contractCount: number;
  /** 未填合同额的**链**数（合计里按 0 参与，故要显式说出来） */
  amountMissingCount: number;
  /** 合同额合计（按链只计一次） */
  contractAmount: number;
  settleAmount: number;
  invoiceAmount: number;
  paidAmount: number;
  payableAmount: number;
  debt100: number;
  /** 合规问题（`compliance !== '无问题'`）的行数 */
  complianceIssues: number;
}

/** 列可见性配置（`PUT /ledger/columns` 的请求体）：列 key → 是否显示。 */
export type LedgerColumnsConfig = Record<string, boolean>;

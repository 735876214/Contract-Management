import type { Dateish, Decimalish, Paged, Versioned } from './common.ts';

/**
 * 结算域（结算单 `/settlements` + 结算台账 `/settlements/ledger`）的响应/请求类型。
 *
 * ## 真理源
 * - 结算单行：`server/src/modules/settlement/settlement.service.ts#findAll` —— Prisma `Settlement` 行
 *   + `contract { id, code, name, supplierId, supplier { id, name } }`；
 * - 结算单详情：同文件 `findOne` —— `contract` 是**整行 Contract**，另带 `items`（含 `materialBase`）；
 * - 结算台账行：`server/src/modules/settlement/settlement-ledger.service.ts#findLedger` —— Prisma
 *   `SettlementLedger` 行 + `contract { id, code, name, supplier { id, name } }`。
 *
 * ## 两条口径提醒
 * 1. **金额是 Prisma `Decimal` 原样下发 → JSON 里是 string**（这两个列表都没过 `num()`）。
 * 2. 结算台账的「本月结算额 / 开票额 / 保理贴息 / 逾期利息…」里有一部分是**服务端自动算并回写**的
 *    （`computeLedgerAutoFields`），前端直传会被覆盖或拒绝——写接口的 payload 只声明可手填的那些。
 */

/** 结算单行里的合同摘要（列表 `include` 的选择集）。 */
export interface SettlementContractBrief {
  id: string;
  code: string;
  name: string;
  supplierId: string | null;
  supplier: { id: string; name: string } | null;
}

/**
 * 结算单行（`GET /settlements`）。
 * 字段 = `Settlement` 模型 14 个标量 + `contract`。
 */
export interface SettlementRow {
  id: string;
  projectId: string;
  /** 关联合同；**可为空**（无合同结算单，走「仅费用」场景） */
  contractId: string | null;
  code: string | null;
  /** 结算类型（字典 `settlement_type` 的 code） */
  typeCode: string | null;
  /** 结算金额（送审） */
  amount: Decimalish | null;
  /** 扣款金额 */
  deductAmount: Decimalish | null;
  /** 实际（审定）结算额；口径上以它优先于 `amount`（`actual ?? amount`） */
  actualAmount: Decimalish | null;
  settleDate: Dateish;
  /** 结算状态（字典 `settlement_status` 的 code；`DRAFT` 不参与台账/看板累计） */
  statusCode: string | null;
  remark: string | null;
  createdAt: string;
  /** 乐观锁版本号（更新/驳回时必须回传） */
  version: number;
  updatedAt: string;
  contract: SettlementContractBrief | null;
}

export const SETTLEMENT_ROW_KEYS = [
  'id',
  'projectId',
  'contractId',
  'code',
  'typeCode',
  'amount',
  'deductAmount',
  'actualAmount',
  'settleDate',
  'statusCode',
  'remark',
  'createdAt',
  'version',
  'updatedAt',
  'contract',
] as const;

export const SETTLEMENT_ROW_OPTIONAL_KEYS = [] as const;

/** `GET /settlements` 认的查询参数。 */
export const SETTLEMENT_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'contractId',
  'typeCode',
  'statusCode',
  'keyword',
] as const;

export interface SettlementListParams {
  page?: number;
  pageSize?: number;
  contractId?: string;
  typeCode?: string;
  statusCode?: string;
  /** 关键词搜 `code` 与合同名 */
  keyword?: string;
}

/** 结算单明细行（`findOne` 的 `items`；一行 = 本单对某清单物资的结算量）。 */
export interface SettlementItemRow {
  id: string;
  settlementId: string;
  materialBaseId: string;
  /** 结算数量（4 位小数） */
  qty: Decimalish | null;
  /** 税前单价（4 位小数） */
  priceBeforeTax: Decimalish | null;
  /** 税率（百分数口径：13.00 = 13%） */
  taxRatePct: Decimalish | null;
  /** 综合单价 = 税前 × (1 + 税率/100)，**服务端算** */
  priceWithTax: Decimalish | null;
  /** 该行结算金额 = 数量 × 综合单价，**服务端算**；Σ 明细回填 `actualAmount` 由 service 决定 */
  totalWithTax: Decimalish | null;
  remark: string | null;
  sortOrder: number;
  createdAt: string;
  version: number;
  materialBase: { id: string; name: string; spec: string | null; unit: string | null };
}

/**
 * 结算单详情（`GET /settlements/:id`）。
 *
 * ⚠️ 详情的 `contract` 是**整行 Contract**（50+ 字段），本期不逐个声明——需要字段时按
 * `api/types/contract.ts`（PR-D2）补齐；在那之前用 `Record<string, unknown>` 访问并显式断言。
 */
export interface SettlementDetail extends Omit<SettlementRow, 'contract'> {
  contract: (Record<string, unknown> & { id: string; code: string; name: string }) | null;
  items: SettlementItemRow[];
}

/** 新建/更新结算单（服务端写入白名单；`code` 由后端生成或校验唯一）。 */
export interface SettlementCreatePayload {
  contractId?: string | null;
  code?: string | null;
  typeCode?: string | null;
  amount?: Decimalish | null;
  deductAmount?: Decimalish | null;
  actualAmount?: Decimalish | null;
  settleDate?: Dateish;
  statusCode?: string | null;
  remark?: string | null;
}
export type SettlementUpdatePayload = Partial<SettlementCreatePayload> & Versioned;

/**
 * 结算台账行（`GET /settlements/ledger`）。
 *
 * `settlementId` 可为空是**有意**的：当月无结算单但有资金费用/逾期利息时，台账行照样生成
 * （`monthSettleAmount = 0`），删掉结算单后行会保留成「仅费用行」（`onDelete: SetNull`）。
 */
export interface SettlementLedgerRow {
  id: string;
  projectId: string;
  contractId: string | null;
  /** 对应结算单（一结算单一行；同合同同月不允许第二张） */
  settlementId: string | null;
  /** `YYYY-MM` */
  settleMonth: string | null;
  monthSettleAmount: Decimalish | null;
  monthInvoiceAmount: Decimalish | null;
  settleCount: number | null;
  yearSettleAmount: Decimalish | null;
  cumPurchaseAmount: Decimalish | null;
  startSettleAmount: Decimalish | null;
  monthActualPurchase: Decimalish | null;
  /** 保理贴息（写入走专用入口，普通更新一律 400） */
  factoringDiscount: Decimalish | null;
  /** 逾期利息（同上） */
  overdueInterest: Decimalish | null;
  yearSettleIncome: Decimalish | null;
  cumSettleIncome: Decimalish | null;
  /** 是否挂账（字典 `yes_no`） */
  isOnAccount: string | null;
  remark: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
  contract: { id: string; code: string; name: string; supplier: { id: string; name: string } | null } | null;
}

export const SETTLEMENT_LEDGER_ROW_KEYS = [
  'id',
  'projectId',
  'contractId',
  'settlementId',
  'settleMonth',
  'monthSettleAmount',
  'monthInvoiceAmount',
  'settleCount',
  'yearSettleAmount',
  'cumPurchaseAmount',
  'startSettleAmount',
  'monthActualPurchase',
  'factoringDiscount',
  'overdueInterest',
  'yearSettleIncome',
  'cumSettleIncome',
  'isOnAccount',
  'remark',
  'createdAt',
  'version',
  'updatedAt',
  'contract',
] as const;

export const SETTLEMENT_LEDGER_ROW_OPTIONAL_KEYS = [] as const;

/** `GET /settlements/ledger` 认的查询参数。 */
export const SETTLEMENT_LEDGER_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'contractId',
  'settleMonth',
  'isOnAccount',
] as const;

export interface SettlementLedgerListParams {
  page?: number;
  pageSize?: number;
  contractId?: string;
  /** `YYYY-MM` */
  settleMonth?: string;
  isOnAccount?: string;
}

/** 结算台账可手填字段（自动算的那些由服务端回写，不要在前端写）。 */
export interface SettlementLedgerWritePayload {
  contractId?: string | null;
  settleMonth?: string | null;
  monthSettleAmount?: Decimalish | null;
  monthInvoiceAmount?: Decimalish | null;
  settleCount?: number | null;
  yearSettleAmount?: Decimalish | null;
  cumPurchaseAmount?: Decimalish | null;
  startSettleAmount?: Decimalish | null;
  monthActualPurchase?: Decimalish | null;
  isOnAccount?: string | null;
  remark?: string | null;
  version?: number;
}

export type SettlementListResponse = Paged<SettlementRow>;
export type SettlementLedgerListResponse = Paged<SettlementLedgerRow>;

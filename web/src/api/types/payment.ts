import type { Dateish, Decimalish, Paged, Versioned } from './common.ts';

/**
 * 付款域（付款台账 `/payments/*` + 付款手续 `/payment-procedures`）的响应/请求类型。
 *
 * ## 真理源
 * - 付款记录行：`server/src/modules/payment/payment.service.ts#findRecords` ——
 *   **直接返回 Prisma 行**（`include: contractInclude`），所以字段就是 `PaymentRecord` 模型
 *   加上 `contract { id, code, name, supplier { id, name, bankName, bankAccount } }`。
 * - 付款手续行：`server/src/modules/payment-procedure/payment-procedure.service.ts#findAll` ——
 *   同样是 Prisma 行 + `supplier { id, name }` + `contract { id, code, name }`。
 *
 * ## ⚠️ 金额是 Prisma Decimal **原样下发 → string**
 * 这两个列表都没有过 `num()`，所以 `amount` / `settleCumAmount` 等**运行时是字符串**
 * （与台账不同，台账过 `num()` 给 number）。前端必须 `Number(v)` 后再算，展示走 `utils/money.ts`。
 */

/** 付款记录里的合同摘要（`contractInclude` 的选择集，不只是 id/code）。 */
export interface PaymentContractBrief {
  id: string;
  code: string;
  name: string;
  /** 供应商摘要：开户行/账号是为「付款执行」准备的，别在本项目外泄（后端已按项目校验挂接） */
  supplier: { id: string; name: string; bankName: string | null; bankAccount: string | null } | null;
}

/**
 * 付款记录行（`GET /payments/records`）。
 * 字段清单 = `PaymentRecord` 模型 13 个标量 + `contract`。
 */
export interface PaymentRecordRow {
  id: string;
  projectId: string;
  /** 关联合同；未挂合同 → `null`（此时 `contract` 也为 `null`） */
  contractId: string | null;
  /** 付款月份 `YYYY-MM`（**字符串精确匹配**用于台账/看板月度统计，空串会让这笔钱在所有月度里消失） */
  payMonth: string | null;
  /** 本月付款额（Decimal → **string**） */
  amount: Decimalish | null;
  /** 付款方式（字典 code） */
  methodCode: string | null;
  /** 付款日期（ISO 串） */
  payDate: Dateish;
  /** 银行回单地址 */
  receiptUrl: string | null;
  /** 付款状态（字典 code） */
  statusCode: string | null;
  remark: string | null;
  createdAt: string;
  /** 乐观锁版本号（更新时必须回传，否则 409） */
  version: number;
  updatedAt: string;
  contract: PaymentContractBrief | null;
}

/** 付款记录行可能出现**的全部**键（Prisma 行不会漏键，故无 optional 项）。 */
export const PAYMENT_RECORD_ROW_KEYS = [
  'id',
  'projectId',
  'contractId',
  'payMonth',
  'amount',
  'methodCode',
  'payDate',
  'receiptUrl',
  'statusCode',
  'remark',
  'createdAt',
  'version',
  'updatedAt',
  'contract',
] as const;

/** 允许在 JSON 里缺席的键（Prisma 标量列一律返回，故当前没有）。 */
export const PAYMENT_RECORD_OPTIONAL_KEYS = [] as const;

/**
 * `GET /payments/records` 认的查询参数。
 * ⚠️ **不支持 `keyword`**（服务端只按合同/月份/状态过滤），页面别加关键词筛选。
 */
export const PAYMENT_RECORD_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'contractId',
  'payMonth',
  'statusCode',
] as const;

export interface PaymentRecordListParams {
  page?: number;
  pageSize?: number;
  contractId?: string;
  /** `YYYY-MM` */
  payMonth?: string;
  statusCode?: string;
}

/** 新建付款记录（服务端写入白名单 `RECORD_FIELDS`）。 */
export interface PaymentRecordCreatePayload {
  contractId?: string | null;
  /** `YYYY-MM`；**必填**（服务端 `assertYearMonth` 会拒空串/格式错） */
  payMonth: string;
  amount: Decimalish | null;
  methodCode?: string | null;
  payDate?: Dateish;
  receiptUrl?: string | null;
  statusCode?: string | null;
  remark?: string | null;
}

/** 更新付款记录（白名单不含 `projectId`：归属只能由 create 决定）。 */
export type PaymentRecordUpdatePayload = Partial<Omit<PaymentRecordCreatePayload, 'payMonth'>> & {
  payMonth?: string;
} & Versioned;

/**
 * 付款手续行（`GET /payment-procedures`）。
 *
 * 「开累结算 / 开累付款 / 未付款」是**保存时的快照**（服务端按合同链口径算好落库），
 * 事后补录付款不会改写已出单据——换合同才会按新合同重取（口径见 product-decisions）。
 */
export interface PaymentProcedureRow {
  id: string;
  projectId: string;
  supplierId: string | null;
  contractId: string | null;
  /** 单据编号 `FK-<合同号>-<YYYYMMDD>`（项目内唯一） */
  code: string | null;
  /** 开累结算金额快照（Decimal → **string**） */
  settleCumAmount: Decimalish | null;
  /** 开累付款金额快照 */
  paidCumAmount: Decimalish | null;
  /** 未付款 = 开累结算 − 开累付款（可为负，服务端不抹平） */
  unpaidAmount: Decimalish | null;
  payDate: Dateish;
  statusCode: string | null;
  remark: string | null;
  createdBy: string | null;
  createdAt: string;
  version: number;
  updatedAt: string;
  supplier: { id: string; name: string } | null;
  contract: { id: string; code: string; name: string } | null;
}

/** 付款手续行可能出现**的全部**键。 */
export const PAYMENT_PROCEDURE_ROW_KEYS = [
  'id',
  'projectId',
  'supplierId',
  'contractId',
  'code',
  'settleCumAmount',
  'paidCumAmount',
  'unpaidAmount',
  'payDate',
  'statusCode',
  'remark',
  'createdBy',
  'createdAt',
  'version',
  'updatedAt',
  'supplier',
  'contract',
] as const;

export const PAYMENT_PROCEDURE_OPTIONAL_KEYS = [] as const;

/** `GET /payment-procedures` 认的查询参数（含日期区间与关键词）。 */
export const PAYMENT_PROCEDURE_LIST_PARAM_KEYS = [
  'page',
  'pageSize',
  'contractId',
  'supplierId',
  'statusCode',
  'keyword',
  'startDate',
  'endDate',
] as const;

export interface PaymentProcedureListParams {
  page?: number;
  pageSize?: number;
  contractId?: string;
  supplierId?: string;
  statusCode?: string;
  keyword?: string;
  /** `YYYY-MM-DD`（服务端走本地日原语，**不是** UTC） */
  startDate?: string;
  endDate?: string;
}

/** 新建/更新付款手续：服务端按合同重取三个「开累」快照，前端直传会被忽略。 */
export interface PaymentProcedureWritePayload {
  contractId?: string | null;
  supplierId?: string | null;
  payDate?: Dateish;
  statusCode?: string | null;
  remark?: string | null;
  version?: number;
}

/** 付款记录列表响应。 */
export type PaymentRecordListResponse = Paged<PaymentRecordRow>;
/** 付款手续列表响应。 */
export type PaymentProcedureListResponse = Paged<PaymentProcedureRow>;

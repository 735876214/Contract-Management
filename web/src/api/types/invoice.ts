import type { Dateish } from './common.ts';

/**
 * 发票域（`invoiceApi`）。真理源：`server/src/modules/invoice/invoice.service.ts`。
 *
 * ⚠️ 列表/详情/增改/查验/作废/红冲返回**原始 `Invoice`**（+ 关联）→
 * `amountBeforeTax` / `taxRatePct` / `amountWithTax` 是 Prisma Decimal **字符串**（三态 null）。
 */

/** 发票行（raw `Invoice` + 关联摘要）。金额 Decimal → string。 */
export interface InvoiceRow {
  id: string;
  projectId: string;
  contractId: string | null;
  settlementId: string | null;
  goodsCategory: string;
  settlePeriod: string;
  invoiceCode: string;
  invoiceNo: string;
  typeCode: string;
  invoiceDate: Dateish;
  issuer: string;
  receiver: string;
  /** Decimal → string */
  amountBeforeTax: string | null;
  taxRatePct: string | null;
  amountWithTax: string | null;
  receiveDate: Dateish;
  reviewStatus: string;
  responsiblePerson: string;
  financeTransferStatus: string;
  imageUrl: string | null;
  statusCode: string;
  redOfInvoiceId: string | null;
  remark: string;
  createdAt: string;
  version: number;
  updatedAt: string;
  contract?: {
    id: string;
    code: string;
    name: string;
    supplierId: string | null;
    supplier?: { id: string; name: string } | null;
    [extra: string]: unknown;
  } | null;
  settlement?: { id: string; code: string; settleDate: string | null } | null;
  redOf?: { id: string; invoiceNo: string; statusCode?: string } | null;
  redInvoices?: Array<{ id: string; invoiceNo: string; statusCode?: string }>;
  [extra: string]: unknown;
}

/** 发票行**可能的全部键**（列表/详情并集）。 */
export const INVOICE_ROW_KEYS = [
  'id', 'projectId', 'contractId', 'settlementId', 'goodsCategory', 'settlePeriod', 'invoiceCode', 'invoiceNo',
  'typeCode', 'invoiceDate', 'issuer', 'receiver', 'amountBeforeTax', 'taxRatePct', 'amountWithTax', 'receiveDate',
  'reviewStatus', 'responsiblePerson', 'financeTransferStatus', 'imageUrl', 'statusCode', 'redOfInvoiceId', 'remark',
  'createdAt', 'version', 'updatedAt', 'contract', 'settlement', 'redOf', 'redInvoices',
] as const;

/** `GET /invoices` 列表查询参数。 */
export interface InvoiceListParams {
  page?: number;
  pageSize?: number;
  contractId?: string;
  typeCode?: string;
  statusCode?: string;
  reviewStatus?: string;
  goodsCategory?: string;
  invoiceNo?: string;
  keyword?: string;
  /** 只回有效票（排除终态）；服务端按真值判断，故收 number（如 1）也合法 */
  excludeTerminal?: boolean | number;
}

/** `GET /invoices` 列表响应。 */
export interface InvoiceListResponse {
  list: InvoiceRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** `GET /invoices/check-no`。 */
export interface InvoiceCheckNo {
  exists: boolean;
}

/** `POST /invoices/batch` 结果。 */
export interface InvoiceBatchCreateResult {
  created: number;
  errors: string[];
}

/** `POST /invoices/recognize` 一项。 */
export type InvoiceRecognizeItem =
  | { filename: string; ok: true; data: Record<string, unknown> }
  | { filename: string; ok: false; error: string };

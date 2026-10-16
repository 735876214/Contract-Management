/**
 * **单据模板变量**（付款单）—— 零依赖纯函数，前后端镜像的一份在
 * `web/src/constants/docVariables.ts`，由 `docVariables.spec.mts` 锁住两边**变量名逐条一致**。
 *
 * 与另外两套变量体系（采购模板 / 合同模板）**互不相通**：那两套由各自的 service 替换，
 * 同名变量在两处的取值来源不同（见 docs/06）。单据模板是第三套，取值只看单据本身。
 *
 * ⚠️ **金额类变量名必须带单位后缀**（`(元)`）：同名不同单位视为缺陷（仓库既有约定）。
 * ⚠️ 未取到值时**保留占位符原文**（由 `renderTemplate()` 决定），不替换成空串 ——
 *    静默清空会让打印出来的单据看不出哪里没取到数。
 * ⚠️ 必须保持零依赖（不得有任何 `import`）：由 `.mts` spec 直接引用。
 */

export interface DocVarDef {
  /** 占位符名（模板里写 `{{名}}`） */
  name: string;
  /** 面板里的说明 */
  desc: string;
}

/** 付款单变量（本期唯一接了生成路径的一类） */
export const PAYMENT_DOC_VARIABLES: DocVarDef[] = [
  { name: '单据编号', desc: '付款手续编号' },
  { name: '供应商名称', desc: '取自合同关联的供应商' },
  { name: '合同编号', desc: '' },
  { name: '合同名称', desc: '' },
  { name: '开累结算金额(元)', desc: '单据上快照的开累结算金额' },
  { name: '开累付款金额(元)', desc: '单据上快照的开累付款金额' },
  { name: '未付款金额(元)', desc: '开累结算 − 开累付款（可能为负）' },
  { name: '付款时间', desc: '留空则原样保留占位符' },
  { name: '项目名称', desc: '' },
  { name: '项目简称', desc: '' },
  { name: '项目编码', desc: '' },
  { name: '备注', desc: '' },
  { name: '打印日期', desc: '生成单据的当天日期' },
];

/** 金额 → `1,234.56`（两位小数；空值 → 空串，让调用方决定是否保留占位符） */
export function formatDocMoney(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 日期 → `YYYY-MM-DD`（本地口径；空值 → 空串） */
export function formatDocDate(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const d = v instanceof Date ? v : new Date(v as any);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface PaymentDocValuesInput {
  procedure: {
    code?: string | null;
    settleCumAmount?: unknown;
    paidCumAmount?: unknown;
    unpaidAmount?: unknown;
    payDate?: unknown;
    remark?: string | null;
  };
  contract?: { code?: string | null; name?: string | null } | null;
  supplier?: { name?: string | null } | null;
  project?: { name?: string | null; nameAbbr?: string | null; code?: string | null } | null;
  /** 生成时间（默认今天）；显式传入便于测试与"补打"时指定 */
  now?: Date;
}

/**
 * 构造付款单的变量取值表。
 * `打印日期` 用**生成当天**而不是付款日期：单据上要留下"这是哪天打出来的"。
 */
export function buildPaymentDocValues(input: PaymentDocValuesInput): Record<string, string> {
  const p = input.procedure || {};
  return {
    单据编号: String(p.code ?? ''),
    供应商名称: String(input.supplier?.name ?? ''),
    合同编号: String(input.contract?.code ?? ''),
    合同名称: String(input.contract?.name ?? ''),
    '开累结算金额(元)': formatDocMoney(p.settleCumAmount),
    '开累付款金额(元)': formatDocMoney(p.paidCumAmount),
    '未付款金额(元)': formatDocMoney(p.unpaidAmount),
    付款时间: formatDocDate(p.payDate),
    项目名称: String(input.project?.name ?? ''),
    项目简称: String(input.project?.nameAbbr ?? ''),
    项目编码: String(input.project?.code ?? ''),
    备注: String(p.remark ?? ''),
    打印日期: formatDocDate(input.now ?? new Date()),
  };
}

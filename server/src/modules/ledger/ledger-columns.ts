/**
 * 合同台账列定义与列宽换算（**零运行时依赖**，供 ledger.service 与单测共用）。
 *
 * 抽出的原因：`LEDGER_COLUMNS[].width` 是 Excel 字符宽（8~30），而前端 antd 表格需要**像素**；
 * 早期直接把字符值当像素传给 antd，导致 42 列表头全被挤成竖排文字（台账在桌面端也破版）。
 * 单位换算必须在一处完成，并由单测锁定（`server/test/ledgerColumns.spec.mts`）。
 */

const EXCEL_CHAR_TO_PX = 8;
const MIN_COLUMN_PX = 100;

/**
 * Excel 字符宽 → 前端表格像素宽。
 * 按约 8px/字符估算并设 100px 下限：中文字段名（如「财务一体化合同编号」）宽度不足 100px 时
 * 会被浏览器压成**竖排文字**，这正是早期台账（42 列）在桌面端也破版的根因。
 */
export function ledgerColumnWidthPx(width?: number): number {
  const chars = Number(width) || 16;
  return Math.max(MIN_COLUMN_PX, Math.round(chars * EXCEL_CHAR_TO_PX));
}

/**
 * 合同台账列定义（顺序固定，可配置显示/隐藏）。
 *
 * ⚠️ `width` 的单位是 **Excel 字符宽（8~30）**，不是像素。前端表格需要像素宽，
 * 转换统一在 `columns()` 一处完成（`ledgerColumnWidthPx`）——
 * 早期直接把 8~30 当作像素传给 antd，导致 42 列表头全被挤成竖排文字（台账在桌面上也破版）。
 * 注：下方导出用的列表列定义（`{ header, key, width: 110~240 }`）是**另一份**定义，与此无关。
 */
export const LEDGER_COLUMNS: { key: string; title: string; width?: number; defaultHidden?: boolean }[] = [
  { key: 'index', title: '序号', width: 8 },
  { key: 'contractCode', title: '合同编号', width: 20 },
  { key: 'financeCode', title: '财务一体化合同编号', width: 22 },
  { key: 'supplierName', title: '供应单位', width: 28 },
  { key: 'materialNames', title: '供应材料', width: 24 },
  { key: 'procurementSource', title: '采购来源', width: 14 },
  { key: 'isDirectPurchase', title: '是否厂家直采', width: 14 },
  { key: 'contractName', title: '合同名称', width: 30 },
  { key: 'bidName', title: '招标名称', width: 24 },
  { key: 'execStatus', title: '合同执行情况', width: 14 },
  { key: 'supplierCategory', title: '分供方类别', width: 14 },
  { key: 'legalPerson', title: '法人', width: 12 },
  { key: 'authPerson', title: '授权人', width: 12 },
  { key: 'contactName', title: '联系人', width: 12 },
  { key: 'contactPhone', title: '联系人电话', width: 14 },
  { key: 'amount', title: '合同额', width: 16 },
  // 业务口径（2026-10-15）：合同当前金额 = 主合同 + Σ 补充协议增量；
  // 「已结算金额占合同比例」「100% 欠款」的分母都是它 —— 单列一列，否则读者看不到分母
  { key: 'currentAmount', title: '合同当前金额', width: 18 },
  { key: 'taxRate', title: '税率', width: 10 },
  { key: 'currentPayRatio', title: '当前合同付款比例', width: 16 },
  { key: 'paymentMethod', title: '合同约定付款方式', width: 16 },
  { key: 'isSupplement', title: '是否补充协议', width: 14 },
  { key: 'supplementType', title: '补充协议类型', width: 16 },
  { key: 'bidStartDate', title: '开始招标时间', width: 14 },
  { key: 'bidWinDate', title: '定标时间', width: 14 },
  { key: 'signDate', title: '合同签订时间', width: 14 },
  { key: 'disclosureDate', title: '合同交底时间', width: 14 },
  { key: 'firstEntryDate', title: '首次进场时间', width: 14 },
  { key: 'compliance', title: '合规性问题', width: 18 },
  { key: 'complaint', title: '投诉情况', width: 18 },
  { key: 'cumSettleAmount', title: '开累结算金额', width: 16 },
  { key: 'auditedSettleAmount', title: '审定结算额', width: 16 },
  { key: 'cumSettleBeforeTax', title: '开累税前结算金额', width: 18 },
  { key: 'cumInputTax', title: '开累进项税额', width: 16 },
  { key: 'cumInvoiceAmount', title: '开累发票金额', width: 16 },
  { key: 'cumPaidAmount', title: '开累付款金额', width: 16 },
  { key: 'payableAmount', title: '应付款金额', width: 16 },
  { key: 'unpaidAmount', title: '应付未付金额', width: 16 },
  { key: 'debt100', title: '100%欠款', width: 16 },
  { key: 'settleRatio', title: '已结算金额占合同比例', width: 18 },
  { key: 'paidRatio', title: '已付款金额占结算比例', width: 18 },
  { key: 'settleReduceAmount', title: '总结算审减额', width: 16 },
  { key: 'yearSettle', title: '每年结算金额', width: 20, defaultHidden: true },
  { key: 'yearPaid', title: '每年付款金额', width: 20, defaultHidden: true },
];

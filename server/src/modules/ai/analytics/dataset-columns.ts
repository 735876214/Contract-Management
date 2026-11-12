/**
 * AI 数据集 → **Excel 列定义（中文表头）**。
 *
 * 单一事实源：采集器的工作表列、工作簿 sheet 列、行级填充的可选列都读这一份。
 * key 与 `dataset-registry.ts` 一致；未实现的域给空数组（等 Phase 5 一起补）。
 *
 * ⚠️ 列名是**业务口径**（如「链金额合计」表示合同链），与采集器的行字段必须逐字一致。
 */

export const DATASET_COLUMNS: Record<string, readonly string[]> = {
  'project.base': ['项目', '简称', '项目经理', '开始日期', '结束日期'],
  'contract.summary': ['项目', '本期新签合同', '本期新签金额', '链金额合计', '执行中合同'],
  'contract.detail': ['项目', '合同编号', '合同名称', '供应商', '签约日期', '链当前金额', '执行状态'],
  'settlement.summary': ['项目', '结算单数', '结算金额'],
  'settlement.detail': ['项目', '合同编号', '单据编号', '结算日期', '结算金额', '状态'],
  'settlement.ledger': ['项目', '合同编号', '结算月份', '本月结算额', '本月开票额', '保理贴息', '逾期利息'],
  'payment.records': ['项目', '合同编号', '付款日', '付款月份', '金额', '状态'],
  'invoice.records': ['项目', '合同编号', '开票日期', '含税金额', '状态'],
  'contract.fulfillment': [
    '项目',
    '合同当前金额',
    '已收数量',
    '已结算',
    '已付款',
    '已开票',
    '已收比例(%)',
    '已结比例(%)',
    '已付占比(%)',
    '开票比例(%)',
  ],
  'cost.profit_loss': ['项目', '结算期', '六项降本创效', '劳务计价累计扣款', '明细行数'],
  'cost.labor_receiving': ['项目', '单据编号', '分包商', '结算期', '状态', '明细数'],
  'procurement.task': ['项目', '采购编号', '类型', '状态'],
  'procurement.result': ['项目', '采购编号', '投标单位', '状态', '最终确认价'],
  'daily.report': ['项目', '日报条数', '结算量合计', '含税金额合计'],
  'receipt.order': ['项目', '收领单号', '日期', '供应单位', '状态', '明细数'],
  'finance.cost': ['类型', '项目', '合同编号', '期间', '金额'],
  'asset.flow': ['项目', '进场数量', '进场金额', '出场数量', '出场金额', '费用金额', '未知来源'],
  'supplier.concentration': ['供应商', '合同链数', '签约额', '占比(%)'],
  // Phase 5 之前未实现的域
  'repayment.agreement': [],
  'final_settlement.summary': [],
  'payment_procedure.records': [],
  'contract.change_log': [],
  'material.base': [],
  'material.contract': [],
  'labor.auth': [],
  'labor.receiving_doc': [],
  'procurement.documents': [],
};

export function datasetColumnsOf(key: string): readonly string[] {
  return DATASET_COLUMNS[String(key ?? '')] ?? [];
}

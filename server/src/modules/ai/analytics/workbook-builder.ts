/**
 * AI 经营数据助手 · **多 sheet 工作簿模型（纯函数）**。
 *
 * 事实包 → sheet 模型（列/行/说明）；真正的 xlsx 写出在 analytics.service（ExcelJS 不是纯函数）。
 * 约束（计划 §2.4 B）：
 * - sheet 名净化到 Excel 限制（≤31 字符、去掉 `[]:*?/\\`、重名加序号）；
 * - 单数据集最多 5000 行（采集器已截断，这里只带 `truncated` 标记）；
 * - 数据一律写字符串/数值，**不生成公式**（防注入）。
 */

import type { AiAnalyticsFacts } from './analytics.types.ts';
import { AI_TOTAL_LABELS } from './dataset-facts.ts';

export interface AnalyticsSheetModel {
  name: string;
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  /** 截断提示（写在首行下方或 sheet 末尾，由写出层决定） */
  note?: string;
}

/** Excel sheet 名净化：非法字符替换、去空白、31 字符上限、同簿重名加序号 */
export function sanitizeSheetName(raw: string, used: Set<string> = new Set()): string {
  const base = String(raw ?? '')
    .replace(/[\[\]:*?/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31) || 'Sheet';
  let name = base;
  let i = 2;
  while (used.has(name)) {
    const suffix = ` (${i})`;
    name = base.slice(0, 31 - suffix.length) + suffix;
    i += 1;
  }
  used.add(name);
  return name;
}

/** 事实包 → 工作簿 sheet 模型（总览 / 项目对照 / 各数据集 / 风险与提示） */
export function buildAnalyticsWorkbookModel(facts: AiAnalyticsFacts): AnalyticsSheetModel[] {
  const used = new Set<string>();
  const sheets: AnalyticsSheetModel[] = [];

  const overview: Array<Record<string, string | number | null>> = [];
  for (const [key, label] of AI_TOTAL_LABELS) {
    const now = Number(facts.totals[key]);
    if (facts.compareTotals) {
      const prev = Number(facts.compareTotals[key]);
      overview.push({
        指标: label,
        本期: now,
        对比期: prev,
        变化: prev === 0 ? (now === 0 ? '0%' : '—') : `${(((now - prev) / prev) * 100).toFixed(2)}%`,
      });
    } else {
      overview.push({ 指标: label, 本期: now });
    }
  }
  sheets.push({
    name: sanitizeSheetName('经营总览', used),
    columns: facts.compareTotals ? ['指标', '本期', '对比期', '变化'] : ['指标', '本期'],
    rows: overview,
    note: `范围：${facts.scope.label}；期间：${facts.period.label}；口径：业务发生日归期、合同链金额、发票排除作废/红冲。`,
  });

  sheets.push({
    name: sanitizeSheetName('项目对照', used),
    columns: ['项目编码', '项目名称', '新签合同数', '签约额', '结算额', '付款额', '开票额', '应付未付', '已结未开票', '日报条数', '采购任务数'],
    rows: [...facts.byProject]
      .sort((a, b) => b.signedYuan - a.signedYuan)
      .map((p) => ({
        项目编码: p.code,
        项目名称: p.name,
        新签合同数: p.contractCount,
        签约额: p.signedYuan,
        结算额: p.settledYuan,
        付款额: p.paidYuan,
        开票额: p.invoicedYuan,
        应付未付: p.unpaidYuan,
        已结未开票: p.uninvoicedYuan,
        日报条数: p.dailyReports,
        采购任务数: p.procurementTasks,
      })),
  });

  const maxRows = 5000;
  for (const d of facts.datasets) {
    sheets.push({
      name: sanitizeSheetName(d.label, used),
      columns: d.columns,
      rows: d.rows.slice(0, maxRows),
      note: d.truncated || d.totalRows > Math.min(d.rows.length, maxRows)
        ? `共 ${d.totalRows} 行，本表只含前 ${Math.min(d.rows.length, maxRows)} 行。`
        : undefined,
    });
  }

  const riskRows: Array<Record<string, string | number | null>> = [
    ...facts.risks.map((r) => ({ 类型: r.level === 'RED' ? '高风险' : r.level === 'YELLOW' ? '中风险' : '提示', 内容: r.text })),
    ...facts.warnings.map((w) => ({ 类型: '数据提醒', 内容: w })),
  ];
  sheets.push({
    name: sanitizeSheetName('风险与提示', used),
    columns: ['类型', '内容'],
    rows: riskRows,
    note: riskRows.length ? undefined : '程序未发现可判定的异常，但仍需关注数据完整性。',
  });

  return sheets;
}

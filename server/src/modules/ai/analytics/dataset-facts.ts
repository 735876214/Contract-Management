/**
 * AI 经营数据助手 · **确定性事实包与报告（纯函数）**。
 *
 * 程序算数、程序排版；Phase 2 不调模型（`source = 'template'`）。
 * 口径：
 * - 金额为元（两位小数），数量保留原始精度；
 * - 期间按**业务发生日**归期（合同 `signDate`、结算 `settleDate`、付款 `payDate`、发票 `invoiceDate`、日报 `entryDate`）；
 * - 合同金额按**合同链**（主合同 `amount` + Σ 补充协议 `changeAmount`）；发票排除作废/红冲；
 * - 未填金额是**未知**，不兜成 0 参与比例（空值跳过，单列数据缺口）。
 */

import { round2 } from '../../../common/utils/money.ts';
import { auditNumbers, numbersInText } from '../report-facts.ts';
import {
  AI_DATASETS,
  datasetByKey,
} from './dataset-registry.ts';
import {
  AI_SECTION_TITLES,
  type AiAnalyticsDatasetFact,
  type AiAnalyticsFacts,
  type AiAnalyticsProjectFact,
  type AiAnalyticsTotals,
  type AiCollectedDataset,
  type AiCompareMode,
  type AiDetailLevel,
  type AiFocus,
  type AiReportKind,
  type AiReportSectionId,
  type AiScopeMode,
} from './analytics.types.ts';

export interface AnalyticsFactsInput {
  scopeLabel: string;
  scopeMode: AiScopeMode;
  projects: Array<{ id: string; code: string; name: string }>;
  period: { from: string | null; to: string; label: string; preset: string };
  compareMode: AiCompareMode;
  comparePeriod: { from: string | null; to: string; label: string; mode: 'mom' | 'yoy' } | null;
  totals: AiAnalyticsTotals;
  compareTotals: AiAnalyticsTotals | null;
  byProject: AiAnalyticsProjectFact[];
  datasets: AiCollectedDataset[];
  warnings: string[];
  asOf: string;
  generatedAt: string;
}

/** 指标中文名（表格、工作簿与事实包共用） */
export const AI_TOTAL_LABELS: Array<[keyof AiAnalyticsTotals, string]> = [
  ['projectCount', '项目数'],
  ['contractCount', '新签合同数'],
  ['signedYuan', '新签合同金额'],
  ['settledYuan', '结算金额'],
  ['paidYuan', '付款金额'],
  ['invoicedYuan', '开票金额'],
  ['unpaidYuan', '应付未付'],
  ['uninvoicedYuan', '已结未开票'],
  ['dailyReports', '日报条数'],
  ['procurementTasks', '采购任务数'],
];

const REPORT_KIND_LABEL: Record<AiReportKind, string> = {
  monthly: '月度经营简报',
  project: '项目履约简报',
  brief: '领导简报',
  custom: '经营数据报告',
  comparison: '对比简报',
};

/** 风险规则：全部由程序判定，模型只许转述（Phase 3） */
export function buildAnalyticsRisks(
  totals: AiAnalyticsTotals,
  compareTotals: AiAnalyticsTotals | null,
  compareMode: AiCompareMode,
  compareLabel: string | null,
): AiAnalyticsFacts['risks'] {
  const risks: AiAnalyticsFacts['risks'] = [];
  if (totals.settledYuan > 0 && totals.paidYuan > totals.settledYuan) {
    risks.push({
      code: 'OVERPAID',
      level: 'RED',
      text: `付款超过结算 ${fmtYuan(totals.paidYuan - totals.settledYuan)} 元（付款 ${fmtYuan(totals.paidYuan)} > 结算 ${fmtYuan(totals.settledYuan)}）`,
    });
  }
  if (totals.settledYuan > 0) {
    const gap = round2(((totals.settledYuan - totals.invoicedYuan) / totals.settledYuan) * 100);
    if (gap >= 20) {
      risks.push({
        code: 'INVOICE_GAP',
        level: 'YELLOW',
        text: `开票落后于结算 ${gap} 个百分点（已结算 ${fmtYuan(totals.settledYuan)} 元，已开票 ${fmtYuan(totals.invoicedYuan)} 元）`,
      });
    }
  }
  if (totals.dailyReports === 0) {
    risks.push({ code: 'NO_DAILY', level: 'INFO', text: '所选期间没有总日报记录，履约进度缺少数据支撑' });
  }
  if (totals.contractCount === 0 && totals.settledYuan === 0 && totals.paidYuan === 0) {
    risks.push({ code: 'NO_DATA', level: 'INFO', text: '所选范围没有合同、结算或付款数据，报告只能说明数据缺口' });
  }
  if (compareTotals && compareMode !== 'none') {
    const modeName = compareMode === 'yoy' ? '同比' : '环比';
    const drops: Array<[keyof AiAnalyticsTotals, string]> = [
      ['signedYuan', '新签合同金额'],
      ['settledYuan', '结算金额'],
      ['paidYuan', '付款金额'],
    ];
    for (const [key, name] of drops) {
      const now = Number(totals[key]);
      const prev = Number(compareTotals[key]);
      if (prev > 0 && now >= 0) {
        const pct = round2(((now - prev) / prev) * 100);
        if (pct <= -50) {
          risks.push({
            code: 'COMPARE_DROP',
            level: 'YELLOW',
            text: `${name}${modeName}下降 ${Math.abs(pct)}%（${compareLabel ?? '对比期'} ${fmtYuan(prev)} → 本期 ${fmtYuan(now)}），需关注是否出现停滞`,
          });
        }
      }
    }
  }
  return risks;
}

/** 事实包构建（纯函数）：补注册表元信息、数据缺口提醒与风险 */
export function buildAnalyticsFacts(input: AnalyticsFactsInput): AiAnalyticsFacts {
  const warnings = [...input.warnings];
  const datasets: AiAnalyticsDatasetFact[] = [];
  for (const key of AI_DATASETS.map((d) => d.key)) {
    const collected = input.datasets.find((d) => d.key === key);
    if (!collected) continue;
    const def = datasetByKey(key);
    if (!def) continue;
    const fact: AiAnalyticsDatasetFact = {
      ...collected,
      label: def.label,
      section: def.reportSection,
      empty: collected.rows.length === 0,
    };
    datasets.push(fact);
    if (fact.empty) warnings.push(`数据集「${def.label}」在所选范围没有数据`);
  }

  return {
    version: 1,
    generatedAt: input.generatedAt,
    asOf: input.asOf,
    scope: {
      mode: input.scopeMode,
      label: input.scopeLabel,
      projects: input.projects,
      projectCount: input.projects.length,
    },
    period: input.period,
    compareMode: input.compareMode,
    comparePeriod: input.comparePeriod,
    totals: input.totals,
    compareTotals: input.compareTotals,
    byProject: input.byProject,
    datasets,
    risks: buildAnalyticsRisks(
      input.totals,
      input.compareTotals,
      input.compareMode,
      input.comparePeriod?.label ?? null,
    ),
    warnings: dedupe(warnings),
  };
}

const fmtYuan = (n: number): string =>
  Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (v: number | null): string => (v === null ? '—' : `${v}%`);

const deltaText = (now: number, prev: number | null): string => {
  if (prev === null) return '—';
  if (prev === 0) return now === 0 ? '0%' : '—';
  const pct = round2(((now - prev) / prev) * 100);
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}%`;
};

const TABLE_ROWS_IN_REPORT = 20;
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

const renderTable = (columns: string[], rows: Array<Record<string, string | number | null>>): string[] => {
  const out: string[] = [];
  out.push(`| ${columns.join(' | ')} |`);
  out.push(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    out.push(`| ${columns.map((c) => formatCell(row[c])).join(' | ')} |`);
  }
  return out;
};

const formatCell = (v: string | number | null): string => (v === null || v === undefined ? '' : String(v));

/** 确定性 Markdown 报告：范围/口径说明 + 总览 + 项目对照 + 各数据集小节 + 风险 */
export interface ReportNarrativeOptions {
  /** 章节 ID → 模型撰写的段落（已过对账；服务端只接受注册表里的章节 ID） */
  narratives?: Record<string, string>;
  /** 模型建议（3~6 条），显示在报告最后一节 */
  advice?: string[];
  /** 章节显示顺序（按报告类型；未列出的按注册表顺序排在后面） */
  sectionOrder?: AiReportSectionId[];
  /** 明细程度：summary 只出各数据集摘要（不铺表格）；detail 表格放宽到 50 行；both/缺省 20 行 */
  detail?: AiDetailLevel;
  /** 关注点：显示在报告头部，并让对应风险排在前面 */
  focus?: AiFocus[];
}

/** 报告类型 → 章节顺序（brief 更像给领导的一页纸；project 把履约提前） */
const REPORT_KIND_ORDER: Record<AiReportKind, AiReportSectionId[]> = {
  monthly: ['overview', 'contracts', 'settlements', 'funds', 'cost', 'daily', 'risks', 'advice'],
  brief: ['overview', 'contracts', 'settlements', 'funds', 'supplier', 'risks', 'advice'],
  project: ['overview', 'fulfillment', 'contracts', 'daily', 'assets', 'risks', 'advice'],
  comparison: ['overview', 'contracts', 'settlements', 'funds', 'supplier', 'risks', 'advice'],
  custom: ['overview', 'projects', 'contracts', 'fulfillment', 'settlements', 'funds', 'cost', 'labor', 'procurement', 'daily', 'assets', 'materials', 'supplier', 'risks', 'advice'],
};

/** 意图 → 报告展示选项（reportKind 决定章节顺序；detail/focus 影响表格与风险排序） */
export function reportPresentation(intent: {
  reportKind: AiReportKind;
  detail: AiDetailLevel;
  focus: AiFocus[];
}): ReportNarrativeOptions {
  return {
    sectionOrder: REPORT_KIND_ORDER[intent.reportKind] ?? REPORT_KIND_ORDER.custom,
    detail: intent.detail,
    focus: intent.focus,
  };
}

const FOCUS_LABELS: Record<AiFocus, string> = {
  payment_risk: '付款风险',
  invoice_gap: '开票缺口',
  cost_overrun: '成本超支',
  schedule: '进度与履约',
  supplier_concentration: '供应商集中度',
  procurement: '采购执行',
  asset: '资产进出场',
};

/** 风险码 → 关注点（用于按 focus 把相关风险排前面） */
const RISK_FOCUS: Record<string, AiFocus> = {
  OVERPAID: 'payment_risk',
  INVOICE_GAP: 'invoice_gap',
  COMPARE_DROP: 'payment_risk',
  NO_DAILY: 'schedule',
};

export function analyticsFactsToMarkdown(facts: AiAnalyticsFacts, options: ReportNarrativeOptions = {}): string {
  const lines: string[] = [];
  lines.push(`# ${facts.scope.label} · ${facts.period.label}`);
  lines.push('');
  lines.push(
    `> 口径：按业务发生日归期（合同签订日 / 结算日 / 付款日 / 开票日 / 进场日）；合同金额按合同链（主合同 + Σ 补充协议增量）；发票排除作废与红冲；未填金额视为未知，不按 0 参与比例。`,
  );
  const cmp = facts.comparePeriod
    ? `${facts.compareMode === 'yoy' ? '同比' : '环比'}（${facts.comparePeriod.label}）`
    : '未启用';
  lines.push(`> 对比：${cmp}`);
  if (options.focus?.length) {
    lines.push(`> 关注点：${options.focus.map((f) => FOCUS_LABELS[f] ?? f).join('、')}`);
  }
  lines.push('');

  // 一、总览
  lines.push('## 一、经营总览');
  lines.push('');
  lines.push(facts.compareTotals ? '| 指标 | 本期 | 对比期 | 变化 |' : '| 指标 | 本期 |');
  lines.push(facts.compareTotals ? '| --- | --- | --- | --- |' : '| --- | --- |');
  for (const [key, label] of AI_TOTAL_LABELS) {
    const now = Number(facts.totals[key]);
    if (facts.compareTotals) {
      const prev = Number(facts.compareTotals[key]);
      lines.push(`| ${label} | ${fmtCell(key, now)} | ${fmtCell(key, prev)} | ${deltaText(now, prev)} |`);
    } else {
      lines.push(`| ${label} | ${fmtCell(key, now)} |`);
    }
  }
  lines.push('');

  // 模型撰写的「经营总览」段落（可选；确定性表格仍是主体）
  if (options.narratives?.overview) {
    lines.push(options.narratives.overview);
    lines.push('');
  }

  // 二、项目对照（按签约额取前 20；多出的项目汇总为「其余 N 个项目合计」，避免截断后数字对不上）
  const allProjects = [...facts.byProject].sort((a, b) => b.signedYuan - a.signedYuan);
  const projects = allProjects.slice(0, TABLE_ROWS_IN_REPORT);
  lines.push('## 二、项目对照');
  lines.push('');
  if (!projects.length) {
    lines.push('- 无项目数据');
  } else {
    lines.push('| 项目 | 新签合同 | 签约额 | 结算额 | 付款额 | 开票额 | 已结未开票 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const p of projects) {
      lines.push(
        `| ${p.code} ${p.name} | ${p.contractCount} | ${fmtYuan(p.signedYuan)} | ${fmtYuan(p.settledYuan)} | ${fmtYuan(p.paidYuan)} | ${fmtYuan(p.invoicedYuan)} | ${fmtYuan(p.uninvoicedYuan)} |`,
      );
    }
    const rest = allProjects.slice(TABLE_ROWS_IN_REPORT);
    if (rest.length) {
      const sum = (pick: (p: AiAnalyticsProjectFact) => number): number =>
        round2(rest.reduce((s, p) => s + pick(p), 0));
      lines.push(
        `| 其余 ${rest.length} 个项目合计 | ${rest.reduce((s, p) => s + p.contractCount, 0)} | ${fmtYuan(sum((p) => p.signedYuan))} | ${fmtYuan(sum((p) => p.settledYuan))} | ${fmtYuan(sum((p) => p.paidYuan))} | ${fmtYuan(sum((p) => p.invoicedYuan))} | ${fmtYuan(sum((p) => p.uninvoicedYuan))} |`,
      );
    }
  }
  lines.push('');

  // 三、按注册表顺序分组的数据集小节
  const sections = new Map<string, AiAnalyticsDatasetFact[]>();
  for (const d of facts.datasets) {
    const list = sections.get(d.section) ?? [];
    list.push(d);
    sections.set(d.section, list);
  }
  const order = options.sectionOrder ?? [];
  const rank = (id: string): number => {
    const i = order.indexOf(id as AiReportSectionId);
    return i >= 0 ? i : order.length + [...sections.keys()].indexOf(id);
  };
  const orderedSections = [...sections.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
  let sectionNo = 2;
  for (const [section, list] of orderedSections) {
    lines.push(`## ${CN_NUM[sectionNo] ?? String(sectionNo + 1)}、${AI_SECTION_TITLES[section]}`);
    lines.push('');
    for (const d of list) {
      lines.push(`### ${d.label}`);
      lines.push('');
      lines.push(`- ${d.summary}`);
      // 明细程度：summary 不铺表格；detail 放宽到 50 行；both/缺省 20 行
      if (d.rows.length && options.detail !== 'summary') {
        const maxRows = options.detail === 'detail' ? 50 : TABLE_ROWS_IN_REPORT;
        const shown = d.rows.slice(0, maxRows);
        lines.push('');
        lines.push(...renderTable(d.columns, shown));
        if (d.truncated || d.totalRows > shown.length) {
          lines.push('');
          lines.push(`> 共 ${d.totalRows} 行，报告显示前 ${shown.length} 行（完整数据见导出的表格）。`);
        }
      } else if (!d.rows.length) {
        lines.push('- 未取到数据（数据缺口，不是 0）');
      }
      lines.push('');
    }
    if (options.narratives?.[section]) {
      lines.push(options.narratives[section]);
      lines.push('');
    }
    sectionNo += 1;
  }

  // 风险与提示
  lines.push(`## ${CN_NUM[sectionNo] ?? String(sectionNo + 1)}、风险与提示`);
  lines.push('');
  if (!facts.risks.length && !facts.warnings.length) {
    lines.push('- 程序未发现可判定的异常，但仍需关注数据完整性（未填金额、未开票、未验收等不体现在本报告）');
  } else {
    const focusSet = new Set(options.focus ?? []);
    const score = (r: AiAnalyticsFacts['risks'][number]): number => (focusSet.has(RISK_FOCUS[r.code]) ? 1 : 0);
    for (const r of [...facts.risks].sort((a, b) => score(b) - score(a))) {
      const tag = r.level === 'RED' ? '【高】' : r.level === 'YELLOW' ? '【中】' : '【提示】';
      lines.push(`- ${tag}${r.text}`);
    }
    for (const w of facts.warnings) lines.push(`- ${w}`);
  }
  lines.push('');

  if (options.advice?.length) {
    sectionNo += 1;
    lines.push(`## ${CN_NUM[sectionNo] ?? String(sectionNo + 1)}、建议`);
    lines.push('');
    for (const a of options.advice) lines.push(`- ${a}`);
    lines.push('');
  }
  return lines.join('\n');
}

export interface NarratedReportResult {
  markdown: string;
  /** 对不上事实的数字（非空 = 模型叙述整段丢弃，改用确定性报告） */
  discarded: string[];
  accepted: boolean;
  warnings: string[];
}

/** 段落只允许纯文本：模型若写标题/表格/引用块，逐行剥掉（prompt 已禁止，这里是硬保险） */
const sanitizeNarrativeText = (raw: string): string =>
  String(raw ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#{1,6}\s|\||>|```)/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 组合「程序表格 + 模型段落」并做数字对账（Phase 3）。
 *
 * 对账不通过 → **整份模型叙述丢弃**、输出确定性报告，并返回 `discarded` 供前端展示；
 * 模型叙述只追加在对应章节里，表格与汇总仍由程序生成，模型无法改写数字。
 */
export function buildNarratedReport(
  facts: AiAnalyticsFacts,
  raw: unknown,
  extraText?: string | null,
  presentation: ReportNarrativeOptions = {},
): NarratedReportResult {
  const deterministic = (): string => analyticsFactsToMarkdown(facts, presentation);
  if (!raw || typeof raw !== 'object') {
    return { markdown: deterministic(), discarded: [], accepted: false, warnings: ['模型返回的叙述不是对象，已输出确定性报告'] };
  }
  const obj = raw as Record<string, any>;
  const known = new Set<string>(['overview', ...facts.datasets.map((d) => d.section)]);
  const narratives: Record<string, string> = {};
  if (obj.sections && typeof obj.sections === 'object') {
    for (const [id, text] of Object.entries(obj.sections)) {
      if (!known.has(id)) continue;
      const clean = sanitizeNarrativeText(String(text ?? '')).slice(0, 2000);
      if (clean) narratives[id] = clean;
    }
  }
  const advice = Array.isArray(obj.advice)
    ? obj.advice.map((a: unknown) => sanitizeNarrativeText(String(a ?? ''))).filter(Boolean).slice(0, 6)
    : [];
  const combined = [...Object.values(narratives), ...advice].join('\n');
  if (!combined.trim()) {
    return { markdown: deterministic(), discarded: [], accepted: false, warnings: ['模型没有返回可用的叙述，已输出确定性报告'] };
  }
  // 用户备注里的数字也放行（计划 §2.3：auditNumbers 含 notes 里的数字），
  // 否则模型复述「按 500 万元口径」会被误判编造并整段丢弃。
  const allowed = [...analyticsFactNumbers(facts), ...numbersInText(extraText)];
  const audit = auditNumbers(combined, allowed);
  if (audit.unknown.length) {
    return {
      markdown: deterministic(),
      discarded: audit.unknown,
      accepted: false,
      warnings: [
        `模型叙述包含无法对账的数字（${audit.unknown.slice(0, 5).join('、')}${audit.unknown.length > 5 ? ' 等' : ''}），已整段丢弃，改用确定性报告`,
      ],
    };
  }
  return {
    markdown: analyticsFactsToMarkdown(facts, { ...presentation, narratives, advice }),
    discarded: [],
    accepted: true,
    warnings: [],
  };
}

const fmtCell = (key: keyof AiAnalyticsTotals, v: number): string => {
  if (key.endsWith('Yuan')) return fmtYuan(v);
  return String(v);
};

/** 事实包里出现过的所有数字（供 Phase 3 的 `auditNumbers()` 对账） */
export function analyticsFactNumbers(facts: AiAnalyticsFacts): number[] {
  const out: number[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out.push(v);
      if (v < 0) out.push(Math.abs(v));
    }
  };
  for (const [, value] of Object.entries(facts.totals)) push(value);
  if (facts.compareTotals) for (const [, value] of Object.entries(facts.compareTotals)) push(value);
  for (const p of facts.byProject) {
    for (const [, value] of Object.entries(p)) push(value);
  }
  for (const d of facts.datasets) {
    push(d.totalRows);
    for (const row of d.rows) {
      for (const value of Object.values(row)) push(value);
    }
  }
  for (const r of facts.risks) {
    // 风险文案里的数字是程序推得的，必须放行（与 scmFacts 风险条同口径）
    for (const m of String(r.text).matchAll(/(-?\d[\d,]*(?:\.\d+)?)/g)) {
      const n = Number(m[1].replace(/,/g, ''));
      if (Number.isFinite(n)) out.push(n);
    }
  }
  return out;
}

/** 报告标题：范围 + 期间 + 类型（≤60 字，生成表单可改） */
export function analyticsTitle(
  kind: AiReportKind,
  scopeLabel: string,
  periodLabel: string,
): string {
  return `${scopeLabel} ${periodLabel} ${REPORT_KIND_LABEL[kind] ?? '经营数据报告'}`.slice(0, 60);
}

const dedupe = (list: string[]): string[] => [...new Set(list.map((s) => String(s ?? '').trim()).filter(Boolean))];

/**
 * 汇报材料的「事实包」与产出校验（**零依赖纯函数**，`.mts` 单测直接加载）。
 *
 * 设计底线：**数字只能来自系统数据**。
 * 模型写作能力足够，但它有个致命习惯——为了让句子更顺，顺手编一个「同比增长 15%」。
 * 汇报材料是给领导看的，一个编出来的数字比写得平淡严重得多。所以：
 * 1. `factsToMarkdown()` 把本轮可用的事实整理成清单给模型（它只需要引用，不需要计算）；
 * 2. `auditReport()` 在产出后把 Markdown 里出现的每个数量/金额逐个对账，
 *    对不上的一律列出来挂在页面上提示「以下数字未在系统数据中找到」；
 * 3. 环比/同比这类派生值也**由程序算好**放进清单（`deltas`），模型只许抄，不许自己算。
 */

export type ReportKind = 'monthly' | 'project' | 'brief';

export const REPORT_KINDS: Record<ReportKind, { label: string; hint: string }> = {
  monthly: { label: '月度经营汇报', hint: '按「经营概况—合同—结算与付款—风险与下阶段」组织' },
  project: { label: '项目履约汇报', hint: '按「项目概况—履约进展—收付情况—问题与措施」组织' },
  brief: { label: '领导汇报摘要', hint: '一页以内，先结论后数据，只保留最关键的 5~7 条' },
};

/** 一个统计区间内发生的量（当前期与对比期共用同一套字段） */
export interface ReportWindow {
  period: { from: string; to: string; label: string };
  contractsSigned: number;
  contractsSignedAmount: number;
  settlementCount: number;
  settlementAmount: number;
  paymentCount: number;
  paymentAmount: number;
  invoiceCount: number;
  invoiceAmount: number;
  dailyReports: number;
}

/**
 * 环比（上期 → 本期）。`pct` 为 null 表示上期为 0、无法计算——
 * 这时 prompt 里明确写成「上期为 0，不要写百分比」，避免模型自己编一个增长率。
 */
export interface ReportDelta {
  /** 本期数值 */
  now: number;
  /** 上期数值 */
  prev: number;
  /** 环比百分比（保留 2 位小数）；上期为 0 时为 null */
  pct: number | null;
}

export interface ReportFacts {
  project: {
    name: string;
    code: string;
    manager?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    /** 项目自营合同额（万元，系统字段单位就是万元） */
    selfContractAmount?: number | null;
  };
  /** 当前（本期）区间 */
  current: ReportWindow;
  /** 对比区间（紧邻本期之前的等长区间） */
  compare: ReportWindow;
  /** 项目级累计（不受区间限制） */
  totals: {
    contracts: number;
    executing: number;
    contractAmount: number;
    settlementAmount: number;
    paymentAmount: number;
    invoiceAmount: number;
    /** 应付未付 = 累计结算 − 累计付款（可为负） */
    unpaid: number;
  };
  /** 区间发生额的环比，键与清单里的口径一一对应 */
  deltas: {
    contractsSigned: ReportDelta;
    contractsSignedAmount: ReportDelta;
    settlementAmount: ReportDelta;
    paymentAmount: ReportDelta;
    invoiceAmount: ReportDelta;
    dailyReports: ReportDelta;
  };
  /** 程序识别出来的风险点（不是模型编的） */
  risks: string[];
}

const money = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-';
  return (Math.round(n * 100) / 100).toFixed(2);
};

const pctText = (d: ReportDelta): string =>
  d.pct === null ? `上期为 0，无法计算环比（本期 ${money(d.now)}）` : `${d.pct > 0 ? '+' : ''}${d.pct.toFixed(2)}%（上期 ${money(d.prev)} → 本期 ${money(d.now)}）`;

const countPctText = (d: ReportDelta): string =>
  d.pct === null ? `上期为 0（本期 ${d.now}）` : `${d.pct > 0 ? '+' : ''}${d.pct.toFixed(2)}%（上期 ${d.prev} → 本期 ${d.now}）`;

/** 给模型的事实清单：一条一个数，便于它原样引用 */
export function factsToMarkdown(f: ReportFacts): string {
  const c = f.current;
  const p = f.compare;
  const lines = [
    `【项目】${f.project.name}（编号 ${f.project.code}）`,
    f.project.manager ? `【项目经理】${f.project.manager}` : null,
    f.project.startDate || f.project.endDate
      ? `【计划工期】${f.project.startDate || '-'} ~ ${f.project.endDate || '-'}`
      : null,
    f.project.selfContractAmount !== null && f.project.selfContractAmount !== undefined
      ? `【自营合同额】${money(f.project.selfContractAmount)} 万元`
      : null,
    '',
    `【统计区间】${c.period.label}`,
    `【对比区间】${p.period.label}（紧邻本期之前的等长区间，只用于环比）`,
    '',
    '【项目累计（不受区间限制）】',
    `- 合同：${f.totals.contracts} 份，其中执行中 ${f.totals.executing} 份`,
    `- 累计合同金额：${money(f.totals.contractAmount)} 元`,
    `- 累计已结算：${money(f.totals.settlementAmount)} 元`,
    `- 累计已付款：${money(f.totals.paymentAmount)} 元`,
    `- 应付未付：${money(f.totals.unpaid)} 元`,
    `- 累计开票：${money(f.totals.invoiceAmount)} 元`,
    '',
    '【本期发生额】',
    `- 新签合同：${c.contractsSigned} 份，金额 ${money(c.contractsSignedAmount)} 元`,
    `- 结算单：${c.settlementCount} 份，金额 ${money(c.settlementAmount)} 元`,
    `- 付款：${c.paymentCount} 笔，金额 ${money(c.paymentAmount)} 元`,
    `- 开票：${c.invoiceCount} 张，金额 ${money(c.invoiceAmount)} 元`,
    `- 日报：${c.dailyReports} 条`,
    '',
    '【本期 vs 对比期（环比，数值由系统算好，只能引用）】',
    `- 新签金额：${pctText(f.deltas.contractsSignedAmount)}`,
    `- 新签份数：${countPctText(f.deltas.contractsSigned)}`,
    `- 结算金额：${pctText(f.deltas.settlementAmount)}`,
    `- 付款金额：${pctText(f.deltas.paymentAmount)}`,
    `- 开票金额：${pctText(f.deltas.invoiceAmount)}`,
    `- 日报条数：${countPctText(f.deltas.dailyReports)}`,
    '',
    '【系统识别出的风险点】',
    ...(f.risks.length ? f.risks.map((r) => `- ${r}`) : ['- 暂无系统识别的风险点']),
  ];
  return lines.filter((l) => l !== null).join('\n');
}

/** 事实包里的所有数字（金额、计数、环比百分比），供产出对账 */
export function factNumbers(f: ReportFacts): number[] {
  const out: number[] = [];
  const pushWindow = (w: ReportWindow) => {
    out.push(
      w.contractsSigned,
      w.contractsSignedAmount,
      w.settlementCount,
      w.settlementAmount,
      w.paymentCount,
      w.paymentAmount,
      w.invoiceCount,
      w.invoiceAmount,
      w.dailyReports,
    );
  };
  pushWindow(f.current);
  pushWindow(f.compare);
  const t = f.totals;
  out.push(t.contracts, t.executing, t.contractAmount, t.settlementAmount, t.paymentAmount, t.invoiceAmount, t.unpaid);
  for (const d of Object.values(f.deltas)) {
    out.push(d.now, d.prev);
    if (d.pct !== null) out.push(Math.abs(d.pct)); // 「增长 25%」与「下降 25%」都允许
  }
  if (f.project.selfContractAmount !== null && f.project.selfContractAmount !== undefined) {
    out.push(f.project.selfContractAmount);
    out.push(Math.round(f.project.selfContractAmount * 10000 * 100) / 100); // 万元 → 元
  }
  return out.filter((n) => Number.isFinite(n));
}

/** 计算环比；上期为 0 时 `pct` 为 null（不能除以 0，也不许模型猜） */
export function deltaOf(now: number, prev: number): ReportDelta {
  const n = Number.isFinite(now) ? now : 0;
  const p = Number.isFinite(prev) ? prev : 0;
  if (Math.abs(p) < 1e-9) return { now: n, prev: p, pct: null };
  return { now: n, prev: p, pct: Math.round(((n - p) / Math.abs(p)) * 10000) / 100 };
}

/** 后面接这些单位的数字不是「金额」，是日期/序号/量词，不参与对账 */
const UNIT_TAIL = /^\s*(年|月|日|号|%|％|份|笔|张|条|项|个|家|天|人|次|页|章|节|期|季度)/;

/** 把 Markdown 里的数量/金额扫出来对账，返回系统数据里对不上的那些 */
export function auditReport(markdown: string, facts: ReportFacts): { unknown: string[]; checked: number } {
  const allowed = factNumbers(facts);
  // 日期（2026-08-01）里的数字不是金额，先整段抹掉，否则 -08、-01 会被当成负数
  const text = String(markdown ?? '').replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/g, ' ');
  const unknown: string[] = [];
  let checked = 0;
  // 「12 万元」中间常有空格，单位要跟着吞掉
  const re = /(-?\d[\d,]*(?:\.\d+)?)\s*(万)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const tail = text.slice(re.lastIndex, re.lastIndex + 3);
    if (UNIT_TAIL.test(tail)) continue;
    const value = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    checked += 1;
    const factor = m[2] ? 10000 : 1;
    const scaled = value * factor;
    const hit = allowed.some((a) => Math.abs(a - scaled) < 0.011 || Math.abs(a * factor - value) < 0.011);
    const token = m[0].replace(/\s+/g, '');
    if (!hit && !unknown.includes(token)) unknown.push(token);
  }
  return { unknown: unknown.slice(0, 20), checked };
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * 极简 Markdown → HTML（只为导出 docx 用）：
 * 标题 / 无序列表 / 有序列表 / 粗体 / 段落 / 简单表格。
 * 不追求完整实现——模型被要求只用这几种语法，多出来的按段落处理不会丢字。
 */
export function markdownToHtml(md: string): string {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let table: string[][] | null = null;

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const closeTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push('<table border="1" cellspacing="0" cellpadding="4">');
    if (head) out.push(`<tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`);
    for (const r of rows) out.push(`<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
    out.push('</table>');
    table = null;
  };
  const inline = (s: string): string => escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\|.*\|$/.test(line.trim())) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      closeList();
      table = table ?? [];
      table.push(cells);
      continue;
    }
    closeTable();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  return `<html><body>${out.join('\n')}</body></html>`;
}

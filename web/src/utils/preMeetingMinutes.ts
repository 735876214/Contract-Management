/**
 * 采前会会议纪要 · 计算规则与文档构建（批次二 · 任务 3.2）
 *
 * 触发条件：仅「单项采购」类型，且预计采购金额 ≥ 100 万元时生成该模块。
 *
 * 采购成本分析表计算规则：
 * - 清单收入     = 收入单价 × 暂定数量
 * - 预计采购成本 = 控制价（预计采购单价）× 暂定数量
 * - 预计效益额   = 清单收入 − 预计采购成本
 * - 效益率       = 预计效益额 ÷ 清单收入
 * 格式：金额按万元表示、保留 2 位小数；效益率按百分比保留 2 位小数。
 * 表底汇总：清单收入、预计采购成本、预计效益额。
 *
 * 变量占位符：
 * {{采前会-采购清单}} {{采前会-采购成本分析表}} {{会议时间}} {{主持人}} {{参会人员}}
 * 以及 {{项目名称}} {{采购内容}} {{预计采购金额}} {{编写人}} {{审核人}}
 *      {{技术质量要求}} {{验收标准}} {{付款条件}}
 */

/** 采购清单行（序号由表格渲染，表头：序号|物资名称|规格型号|计量单位|暂定数量） */
export interface PurchaseItemRow {
  materialName?: string | null;
  spec?: string | null;
  unit?: string | null;
  qty?: number | null;
}

/** 采购成本分析表行：income / cost 均为「万元」 */
export interface CostAnalysisRow {
  materialName?: string | null;
  spec?: string | null;
  income?: number | null;
  cost?: number | null;
}

/** 询价单图片 */
export interface InquirySheet {
  fileName?: string | null;
  url?: string | null;
  size?: number | null;
}

export interface PreMeetingData {
  meetingTime?: string | Date | null;
  content?: string;
  host?: string;
  attendees?: string;
  writer?: string;
  reviewer?: string;
  purchaseItems?: PurchaseItemRow[];
  techQuality?: string;
  acceptance?: string;
  paymentTerms?: string;
  costRows?: CostAnalysisRow[];
  inquirySheets?: InquirySheet[];
}

export interface PreMeetingContext {
  projectName?: string;
  projectAbbr?: string;
  undertaker?: string;
  /** 采购内容（任务内容，作为默认值） */
  content?: string;
  /** 预计采购金额（万元） */
  estimatedAmountWan?: number | null;
}

/* ---------------- 数值与格式化 ---------------- */

/** 保留 2 位小数（消除浮点误差） */
export const round2 = (v: unknown): number =>
  Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

/** 万元金额格式：保留 2 位小数（千分位） */
export const fmtWan = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(Number(v))) return '';
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** 效益率格式：百分比保留 2 位小数 */
export const fmtRate = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(Number(v))) return '';
  return `${round2(v).toFixed(2)}%`;
};

/* ---------------- 采购成本分析表计算规则 ---------------- */

/** 清单收入（万元）= 收入单价（元）× 暂定数量 ÷ 10000 */
export const calcIncomeWan = (incomePrice: unknown, qty: unknown): number =>
  round2(((Number(incomePrice) || 0) * (Number(qty) || 0)) / 10000);

/** 预计采购成本（万元）= 控制价（元）× 暂定数量 ÷ 10000 */
export const calcCostWan = (planPrice: unknown, qty: unknown): number =>
  round2(((Number(planPrice) || 0) * (Number(qty) || 0)) / 10000);

/** 预计效益额（万元）= 清单收入 − 预计采购成本 */
export const calcBenefitWan = (income: unknown, cost: unknown): number =>
  round2((Number(income) || 0) - (Number(cost) || 0));

/** 效益率（%）= 预计效益额 ÷ 清单收入 × 100，保留 2 位小数（清单收入为 0 时按 0 处理） */
export const calcBenefitRate = (income: unknown, benefit: unknown): number => {
  const i = Number(income) || 0;
  if (i === 0) return 0;
  return round2(((Number(benefit) || 0) / i) * 100);
};

/** 单行派生值：清单收入 / 预计采购成本 / 预计效益额 / 效益率 */
export function deriveCostRow(row: CostAnalysisRow) {
  const income = round2(row?.income ?? 0);
  const cost = round2(row?.cost ?? 0);
  const benefit = calcBenefitWan(income, cost);
  return { income, cost, benefit, rate: calcBenefitRate(income, benefit) };
}

/** 表底汇总：清单收入、预计采购成本、预计效益额（效益率按合计口径计算） */
export function summarizeCost(rows: CostAnalysisRow[] = []) {
  const total = rows.reduce<{ income: number; cost: number; benefit: number }>(
    (acc, r) => {
      const d = deriveCostRow(r);
      acc.income = round2(acc.income + d.income);
      acc.cost = round2(acc.cost + d.cost);
      acc.benefit = round2(acc.benefit + d.benefit);
      return acc;
    },
    { income: 0, cost: 0, benefit: 0 },
  );
  return { ...total, rate: calcBenefitRate(total.income, total.benefit) };
}

/** 由「总采购清单」明细换算成本分析表的初始行（income/cost 单位：万元） */
export function costRowsFromTotalList(
  items: {
    materialName?: string | null;
    spec?: string | null;
    qty?: number | null;
    /** 收入单价（元） */
    incomePrice?: number | null;
    /** 控制价 / 预计采购单价（元） */
    planPrice?: number | null;
  }[] = [],
): CostAnalysisRow[] {
  return items.map((i) => ({
    materialName: i.materialName ?? '',
    spec: i.spec ?? '',
    income: calcIncomeWan(i.incomePrice, i.qty),
    cost: calcCostWan(i.planPrice, i.qty),
  }));
}

/* ---------------- HTML 构建（预览 / 导出 Word 共用） ---------------- */

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cell = (v: unknown): string => `<td>${v == null || v === '' ? '' : esc(v)}</td>`;

/** 采购清单表（序号|物资名称|规格型号|计量单位|暂定数量） */
export function buildPurchaseListTableHtml(rows: PurchaseItemRow[] = []): string {
  const body = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr>${cell(i + 1)}${cell(r.materialName)}${cell(r.spec)}${cell(r.unit)}${cell(
              r.qty == null ? '' : Number(r.qty),
            )}</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="text-align:center">（暂无数据）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>序号</th><th>物资名称</th><th>规格型号</th><th>计量单位</th><th>暂定数量</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** 采购成本分析表（含表底汇总：清单收入、预计采购成本、预计效益额） */
export function buildCostAnalysisTableHtml(rows: CostAnalysisRow[] = []): string {
  const body = rows.length
    ? rows
        .map((r, i) => {
          const d = deriveCostRow(r);
          return `<tr>${cell(i + 1)}${cell(r.materialName)}${cell(r.spec)}${cell(
            fmtWan(d.income),
          )}${cell(fmtWan(d.cost))}${cell(fmtWan(d.benefit))}${cell(fmtRate(d.rate))}</tr>`;
        })
        .join('')
    : '<tr><td colspan="7" style="text-align:center">（暂无数据）</td></tr>';
  const t = summarizeCost(rows);
  const foot =
    `<tr><td colspan="3" style="text-align:center;font-weight:bold">合计</td>` +
    `<td style="font-weight:bold">${esc(fmtWan(t.income))}</td>` +
    `<td style="font-weight:bold">${esc(fmtWan(t.cost))}</td>` +
    `<td style="font-weight:bold">${esc(fmtWan(t.benefit))}</td>` +
    `<td style="font-weight:bold">${esc(fmtRate(t.rate))}</td></tr>`;
  return (
    '<table><thead><tr>' +
    '<th>序号</th><th>物资名称</th><th>规格型号</th>' +
    '<th>清单收入（万元）</th><th>预计采购成本（万元）</th><th>预计效益额（万元）</th><th>效益率</th>' +
    `</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`
  );
}

/** 询价单（图片，支持多张） */
export function buildInquirySheetsHtml(images: InquirySheet[] = []): string {
  if (!images?.length) return '<p>（暂无询价单）</p>';
  return (
    '<div>' +
    images
      .map(
        (f, i) =>
          `<p>${esc(f?.fileName || `询价单${i + 1}`)}</p>` +
          (f?.url
            ? `<p><img src="${esc(absoluteUrl(f.url))}" style="max-width:100%;border:1px solid #000" /></p>`
            : ''),
      )
      .join('') +
    '</div>'
  );
}

/** 相对地址（/api/files/...）补全为绝对地址，便于 Word 打开时能取到图片 */
export function absoluteUrl(url?: string | null): string {
  const u = String(url ?? '');
  if (!u) return '';
  if (/^https?:\/\//i.test(u) || u.startsWith('data:')) return u;
  if (typeof window !== 'undefined' && u.startsWith('/')) return `${window.location.origin}${u}`;
  return u;
}

const fmtDate = (v: string | Date | null | undefined): string => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 富文本区：为空给占位，非空直接注入（内容来自富文本编辑器） */
const rich = (html?: string): string => {
  const t = String(html ?? '').trim();
  return t && t !== '<p><br></p>' ? t : '<p>（待填写）</p>';
};

/** 会议基本信息表 */
export function buildBasicInfoTableHtml(
  data: PreMeetingData,
  ctx: PreMeetingContext,
): string {
  const rows: [string, string][] = [
    ['项目名称', ctx.projectName ?? ''],
    ['会议时间', fmtDate(data.meetingTime)],
    ['采购内容', String(data.content ?? ctx.content ?? '')],
    ['主持人', String(data.host ?? '')],
    ['参会人员', String(data.attendees ?? '')],
    ['会议纪要编写人', String(data.writer ?? '')],
    ['审核人', String(data.reviewer ?? '')],
  ];
  return (
    '<table><tbody>' +
    rows.map(([k, v]) => `<tr><th style="width:28%">${esc(k)}</th>${cell(v)}</tr>`).join('') +
    '</tbody></table>'
  );
}

/** 变量取值表：普通变量替换为文本，表格/富文本变量替换为对应 HTML */
export function buildPreMeetingVariableValues(
  data: PreMeetingData,
  ctx: PreMeetingContext,
): Record<string, string> {
  return {
    项目名称: ctx.projectName ?? '',
    项目简称: ctx.projectAbbr ?? '',
    承接单位: ctx.undertaker ?? '',
    采购内容: String(data.content ?? ctx.content ?? ''),
    预计采购金额: ctx.estimatedAmountWan == null ? '' : fmtWan(ctx.estimatedAmountWan),
    会议时间: fmtDate(data.meetingTime),
    主持人: String(data.host ?? ''),
    参会人员: String(data.attendees ?? ''),
    编写人: String(data.writer ?? ''),
    审核人: String(data.reviewer ?? ''),
    技术质量要求: rich(data.techQuality),
    验收标准: rich(data.acceptance),
    付款条件: rich(data.paymentTerms),
    '采前会-采购清单': buildPurchaseListTableHtml(data.purchaseItems ?? []),
    '采前会-采购成本分析表': buildCostAnalysisTableHtml(data.costRows ?? []),
  };
}

/** 组装采前会会议纪要完整文档 HTML（各章节固定顺序） */
export function buildPreMeetingDocHtml(
  data: PreMeetingData,
  ctx: PreMeetingContext,
  title?: string,
): string {
  const docTitle =
    title ?? `${ctx.projectAbbr || ctx.projectName || ''}-${data.content || ctx.content || ''}-采前会会议纪要`;
  return [
    `<h1>${esc(docTitle)}</h1>`,
    '<h2>一、会议基本信息</h2>',
    buildBasicInfoTableHtml(data, ctx),
    '<h2>二、采购清单</h2>',
    buildPurchaseListTableHtml(data.purchaseItems ?? []),
    '<h2>三、技术质量要求</h2>',
    rich(data.techQuality),
    '<h2>四、验收标准</h2>',
    rich(data.acceptance),
    '<h2>五、付款条件</h2>',
    rich(data.paymentTerms),
    '<h2>六、采购成本分析表</h2>',
    buildCostAnalysisTableHtml(data.costRows ?? []),
    '<h2>七、询价单</h2>',
    buildInquirySheetsHtml(data.inquirySheets ?? []),
  ].join('\n');
}

/**
 * 采购价格对比表 · 计算规则与文档构建（批次二 · 任务 3.6）
 *
 * 适用范围：仅「单项采购」采购任务，入口条件为「成交报告已完成」；
 * 状态：编辑中 → 已完成（发布后）。
 *
 * 表格结构：
 * - 项目名称及编码（来源：项目管理 · 项目信息）
 * - 计价方式（固定价 / 浮动价）
 * - 采购效益分析说明（富文本）
 * - 明细表（18 列）：
 *   序号 | 采购名称 | 规格型号 | 单位 | 数量 |
 *   清单收入（不含税单价 / 不含税合价）| 标准成本（不含税单价 / 不含税合价）|
 *   控制价（不含税单价）| 信息价（不含税单价 / 不含税合价）| 成交价（不含税单价 / 不含税合价）|
 *   采购成本降低率 | 采购成交价下浮率 | 信息价下浮率 | 备注
 *
 * 数据来源：
 * - 采购名称 / 规格型号 / 单位 / 数量 / 清单收入单价 / 标准成本单价 / 控制价单价 / 信息价单价
 *   来自总采购清单（只读派生）
 * - 成交价不含税单价 / 备注 由用户录入
 *
 * 计算规则（第 4 条「采购成交价下浮率」需求未给出分母，经确认按信息价口径）：
 * 1. 利润额         = 清单收入 − 成交价
 * 2. 采购效益率     =（清单收入 − 成交价）÷ 清单收入
 * 3. 采购成本降低率 =（标准成本 − 成交价）÷ 标准成本
 * 4. 采购成交价下浮率 =（信息价 − 成交价）÷ 信息价
 * 5. 信息价下浮率   =（信息价 − 成交价）÷ 信息价
 *
 * 表底汇总：清单收入不含税总金额 / 标准成本不含税总金额 / 采购效益率 / 采购成本降低率
 *
 * 变量占位符：{{项目名称}} {{承接单位}} {{采购价格对比表-明细表}}（表格变量）
 */

/** 明细行（价格均为「不含税单价」，单位：元） */
export interface PriceCompareItemRow {
  materialBaseId?: string | null;
  /** 采购名称 */
  materialName?: string | null;
  /** 规格型号 */
  spec?: string | null;
  /** 单位 */
  unit?: string | null;
  /** 数量 */
  qty?: number | null;
  /** 清单收入 不含税单价 */
  incomePrice?: number | null;
  /** 标准成本 不含税单价 */
  stdCost?: number | null;
  /** 控制价 不含税单价（预计采购单价） */
  planPrice?: number | null;
  /** 信息价 不含税单价 */
  infoPrice?: number | null;
  /** 成交价 不含税单价（用户录入） */
  dealPrice?: number | null;
  /** 备注（用户录入） */
  remark?: string | null;
}

export interface PriceCompareData {
  /** 计价方式：FIXED 固定价 | FLOATING 浮动价 */
  pricingMethod?: string | null;
  /** 采购效益分析说明（富文本 HTML） */
  benefitAnalysis?: string | null;
  /** 明细表行 */
  items?: PriceCompareItemRow[] | null;
}

export interface PriceCompareContext {
  projectName?: string;
  /** 项目编码（来源：项目管理 · 项目信息） */
  projectCode?: string;
  projectAbbr?: string;
  undertaker?: string;
  /** 项目所在省市（来源：项目管理 · 项目信息） */
  provinceCity?: string;
  /** 工程地点（来源：项目管理 · 项目信息） */
  siteLocation?: string;
  /** 项目地址（来源：项目管理 · 项目信息） */
  projectAddress?: string;
  /** 采购内容 */
  content?: string;
}

/* ---------------- 计价方式 ---------------- */

export const PRICING_METHODS: { value: 'FIXED' | 'FLOATING'; label: string }[] = [
  { value: 'FIXED', label: '固定价' },
  { value: 'FLOATING', label: '浮动价' },
];

export const pricingMethodLabel = (v?: string | null): string =>
  PRICING_METHODS.find((m) => m.value === v)?.label ?? '';

/* ---------------- 数值与格式化 ---------------- */

/** 数值解析：非数值 / 空 → null */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 保留 2 位小数（消除浮点误差） */
export const round2 = (v: unknown): number =>
  Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

/** 金额格式：千分位 + 2 位小数；空值返回空串（0 也正常显示为 0.00） */
export const fmtAmount = (v: number | null | undefined): string => {
  const n = numOrNull(v);
  if (n == null) return '';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** 数量格式：整数原样、小数去掉多余的 0；空值返回空串 */
export const fmtQty = (v: number | null | undefined): string => {
  const n = numOrNull(v);
  return n == null ? '' : String(n);
};

/** 比率格式：百分比保留 2 位小数；空值返回空串 */
export const fmtRate = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(Number(v))) return '';
  return `${Number(v).toFixed(2)}%`;
};

/* ---------------- 计算规则 ---------------- */

/** 不含税合价 = 不含税单价 × 数量 */
export const calcAmount = (price: unknown, qty: unknown): number =>
  round2((Number(price) || 0) * (Number(qty) || 0));

/**
 * 比率（%）=（基准 − 成交价）÷ 基准 × 100，保留 2 位小数。
 * 基准或成交价缺失、基准为 0 时返回 null（表示暂无数据，避免误显示 100%）。
 */
export const calcRateNullable = (base: unknown, deal: unknown): number | null => {
  const b = numOrNull(base);
  const d = numOrNull(deal);
  if (b == null || b === 0 || d == null) return null;
  return round2(((b - d) / b) * 100);
};

/** 利润额 = 清单收入 − 成交价（同为合价口径）；成交价缺失时返回 null */
export const calcProfit = (income: unknown, deal: unknown): number | null => {
  const d = numOrNull(deal);
  if (d == null) return null;
  return round2((Number(income) || 0) - d);
};

/** 采购效益率（%）=（清单收入 − 成交价）÷ 清单收入 */
export const calcBenefitRate = (income: unknown, deal: unknown): number | null =>
  calcRateNullable(income, deal);

/** 采购成本降低率（%）=（标准成本 − 成交价）÷ 标准成本 */
export const calcCostReduceRate = (stdCost: unknown, deal: unknown): number | null =>
  calcRateNullable(stdCost, deal);

/** 信息价下浮率（%）=（信息价 − 成交价）÷ 信息价 */
export const calcInfoDiscountRate = (infoPrice: unknown, deal: unknown): number | null =>
  calcRateNullable(infoPrice, deal);

/**
 * 采购成交价下浮率（%）。
 * 需求未给出分母，经确认按信息价口径 =（信息价 − 成交价）÷ 信息价。
 */
export const calcDealDiscountRate = (infoPrice: unknown, deal: unknown): number | null =>
  calcRateNullable(infoPrice, deal);

/** 单行派生值（合价与三类率值；率值按「不含税单价」口径计算，未录入成交价时为 null） */
export function deriveRow(row: PriceCompareItemRow) {
  const incomeAmount = calcAmount(row?.incomePrice, row?.qty);
  const stdAmount = calcAmount(row?.stdCost, row?.qty);
  const infoAmount = calcAmount(row?.infoPrice, row?.qty);
  const dealAmount = calcAmount(row?.dealPrice, row?.qty);
  const hasDeal = numOrNull(row?.dealPrice) != null;
  return {
    incomeAmount,
    stdAmount,
    infoAmount,
    dealAmount,
    /** 利润额 = 清单收入合价 − 成交价合价 */
    profit: hasDeal ? calcProfit(incomeAmount, dealAmount) : null,
    costReduceRate: hasDeal ? calcCostReduceRate(row?.stdCost, row?.dealPrice) : null,
    dealDiscountRate: hasDeal ? calcDealDiscountRate(row?.infoPrice, row?.dealPrice) : null,
    infoDiscountRate: hasDeal ? calcInfoDiscountRate(row?.infoPrice, row?.dealPrice) : null,
  };
}

/** 表底汇总：清单收入总金额 / 标准成本总金额 / 采购效益率 / 采购成本降低率 */
export function summarizePriceCompare(rows: PriceCompareItemRow[] = []) {
  const total = rows.reduce(
    (acc, r) => {
      const d = deriveRow(r);
      acc.incomeAmount = round2(acc.incomeAmount + d.incomeAmount);
      acc.stdAmount = round2(acc.stdAmount + d.stdAmount);
      acc.infoAmount = round2(acc.infoAmount + d.infoAmount);
      acc.dealAmount = round2(acc.dealAmount + d.dealAmount);
      acc.profit = round2(acc.profit + (d.profit ?? 0));
      if (d.profit != null) acc.hasDeal = true;
      return acc;
    },
    { incomeAmount: 0, stdAmount: 0, infoAmount: 0, dealAmount: 0, profit: 0, hasDeal: false },
  );
  return {
    ...total,
    /** 采购效益率（合计口径）=（Σ清单收入 − Σ成交价）÷ Σ清单收入（未录入成交价时为 null） */
    benefitRate: total.hasDeal ? calcBenefitRate(total.incomeAmount, total.dealAmount) : null,
    /** 采购成本降低率（合计口径）=（Σ标准成本 − Σ成交价）÷ Σ标准成本（未录入成交价时为 null） */
    costReduceRate: total.hasDeal ? calcCostReduceRate(total.stdAmount, total.dealAmount) : null,
  };
}

/* ---------------- HTML 构建（预览 / 导出 Word 共用） ---------------- */

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cell = (v: unknown): string => `<td>${v == null || v === '' ? '' : esc(v)}</td>`;

/** 富文本区：为空给占位，非空直接注入（内容来自富文本编辑器） */
const rich = (html?: string | null): string => {
  const t = String(html ?? '').trim();
  return t && t !== '<p><br></p>' ? t : '<p>（待填写）</p>';
};

/**
 * 采购价格对比明细表（18 列 + 表底汇总）。
 * 控制价按需求仅列「不含税单价」（无合价列）。
 */
export function buildPriceCompareTableHtml(rows: PriceCompareItemRow[] = []): string {
  const body = rows.length
    ? rows
        .map((r, i) => {
          const d = deriveRow(r);
          return (
            `<tr>${cell(i + 1)}${cell(r.materialName)}${cell(r.spec)}${cell(r.unit)}${cell(
              fmtQty(r.qty),
            )}` +
            `${cell(fmtAmount(r.incomePrice))}${cell(fmtAmount(d.incomeAmount))}` +
            `${cell(fmtAmount(r.stdCost))}${cell(fmtAmount(d.stdAmount))}` +
            `${cell(fmtAmount(r.planPrice))}` +
            `${cell(fmtAmount(r.infoPrice))}${cell(fmtAmount(d.infoAmount))}` +
            `${cell(fmtAmount(r.dealPrice))}${cell(fmtAmount(d.dealAmount))}` +
            `${cell(fmtRate(d.costReduceRate))}${cell(fmtRate(d.dealDiscountRate))}${cell(
              fmtRate(d.infoDiscountRate),
            )}` +
            `${cell(r.remark)}</tr>`
          );
        })
        .join('')
    : '<tr><td colspan="18" style="text-align:center">（暂无数据，请先编制并发布总采购清单）</td></tr>';

  const t = summarizePriceCompare(rows);
  const footRows: [string, string][] = [
    ['清单收入不含税总金额（元）', fmtAmount(t.incomeAmount)],
    ['标准成本不含税总金额（元）', fmtAmount(t.stdAmount)],
    ['采购效益率', fmtRate(t.benefitRate)],
    ['采购成本降低率', fmtRate(t.costReduceRate)],
  ];
  const foot = footRows
    .map(
      ([k, v]) =>
        `<tr><td colspan="14" style="text-align:right;font-weight:bold">${esc(k)}</td>` +
        `<td colspan="4" style="font-weight:bold">${esc(v)}</td></tr>`,
    )
    .join('');

  return (
    '<table><thead><tr>' +
    '<th>序号</th><th>采购名称</th><th>规格型号</th><th>单位</th><th>数量</th>' +
    '<th>清单收入<br/>不含税单价</th><th>清单收入<br/>不含税合价</th>' +
    '<th>标准成本<br/>不含税单价</th><th>标准成本<br/>不含税合价</th>' +
    '<th>控制价<br/>不含税单价</th>' +
    '<th>信息价<br/>不含税单价</th><th>信息价<br/>不含税合价</th>' +
    '<th>成交价<br/>不含税单价</th><th>成交价<br/>不含税合价</th>' +
    '<th>采购成本降低率</th><th>采购成交价下浮率</th><th>信息价下浮率</th><th>备注</th>' +
    `</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`
  );
}

/** 项目基本情况表（项目名称及编码 / 计价方式 / 采购内容） */
export function buildPriceCompareInfoTableHtml(
  data: PriceCompareData,
  ctx: PriceCompareContext,
): string {
  const nameWithCode = [ctx.projectName ?? '', ctx.projectCode ? `（${ctx.projectCode}）` : '']
    .join('')
    .trim();
  const rows: [string, string][] = [
    ['项目名称及编码', nameWithCode],
    ['计价方式', pricingMethodLabel(data.pricingMethod)],
    ['采购内容', ctx.content ?? ''],
  ];
  return (
    '<table><tbody>' +
    rows.map(([k, v]) => `<tr><th style="width:28%">${esc(k)}</th>${cell(v)}</tr>`).join('') +
    '</tbody></table>'
  );
}

/** 变量取值表：普通变量替换为文本，表格变量替换为对应 HTML */
export function buildPriceCompareVariableValues(
  data: PriceCompareData,
  ctx: PriceCompareContext,
): Record<string, string> {
  return {
    项目名称: ctx.projectName ?? '',
    项目简称: ctx.projectAbbr ?? '',
    承接单位: ctx.undertaker ?? '',
    项目所在省市: ctx.provinceCity ?? '',
    工程地点: ctx.siteLocation ?? '',
    项目地址: ctx.projectAddress ?? '',
    采购内容: ctx.content ?? '',
    计价方式: pricingMethodLabel(data.pricingMethod),
    '采购价格对比表-明细表': buildPriceCompareTableHtml(data.items ?? []),
  };
}

/** 组装采购价格对比表完整文档 HTML（各章节固定顺序） */
export function buildPriceCompareDocHtml(
  data: PriceCompareData,
  ctx: PriceCompareContext,
  title?: string,
): string {
  const docTitle =
    title ?? `${ctx.projectAbbr || ctx.projectName || ''}-${ctx.content || ''}-采购价格对比表`;
  return [
    `<h1>${esc(docTitle)}</h1>`,
    '<h2>一、项目基本情况</h2>',
    buildPriceCompareInfoTableHtml(data, ctx),
    '<h2>二、采购效益分析说明</h2>',
    rich(data.benefitAnalysis),
    '<h2>三、采购价格对比明细表</h2>',
    buildPriceCompareTableHtml(data.items ?? []),
  ].join('\n');
}

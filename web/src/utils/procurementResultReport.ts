/**
 * 成交报告 · 文档构建与变量取值（批次二 · 任务 3.5）
 *
 * 适用范围：仅「单项采购」采购任务，入口条件为「采购文件已完成」；
 * 状态：编辑中 → 已完成（发布后）。
 *
 * 数据来源：
 * - 8 个编辑字段由用户手工填写
 * - 响应单位明细由「导入响应单位情况汇总表」写入（10 列）
 * - 「预计采购金额」来自总采购清单（Σ 控制价 × 暂定数量）
 *
 * 自动生成的四张表：
 * 1. 响应单位情况汇总表（序号 / 参与响应单位 / 响应保证金是否缴纳 / 响应文件密封是否完整 / 备注）
 * 2. 开启报价情况表（排名 / 参与响应单位 / 第一次报价不含税总额 / 预计采购金额 / 第一轮报价税金）
 *    —— 排序规则：按第一轮报价不含税总额由小到大
 * 3. 第二轮报价情况表（排名 / 参与响应单位 / 第二次报价不含税总额 / 预计采购金额 / 第二轮报价税金）
 *    —— 排序规则：筛选「通过第一轮报价=是」的单位，按第二轮报价不含税总额由小到大
 * 4. 拟推荐成交候选人表（序号 / 拟推荐成交候选人 / 最终确认不含税价格 / 备注）
 *    —— 交互：在第二轮报价表勾选后自动填入
 *
 * 变量占位符：
 * {{项目名称}} {{项目简称}} {{承接单位}} {{项目所在省市}} {{工程地点}} {{项目地址}}（项目基本信息）
 * {{采购内容}} {{预计采购金额}}
 * {{成交单位数量}} {{采购开启时间}} {{开启地点}} {{评审小组成员}}
 * {{审核通过响应单位数量}} {{参与响应单位数量}} {{弃权响应单位数量}} {{有效响应文件数量}}
 * {{成交报告-响应单位情况汇总表}} {{成交报告-开启报价情况表}}
 * {{成交报告-第二轮报价情况表}} {{成交报告-拟推荐成交候选人表}}（表格变量）
 */

/** 响应单位明细行（导入「响应单位情况汇总表」，10 列） */
export interface ResultSupplier {
  /** 序号（导入表列，可空，展示时按行序重排） */
  seq?: number | null;
  /** 参与响应单位名称 */
  name?: string | null;
  /** 响应保证金是否缴纳（是 / 否） */
  depositPaid?: string | null;
  /** 响应文件密封是否完整（是 / 否） */
  sealed?: string | null;
  /** 是否通过第一轮报价（是 / 否） */
  passedFirst?: string | null;
  /** 第一轮报价不含税总额（元） */
  firstPreTaxTotal?: number | null;
  /** 第一轮报价税金（元） */
  firstTax?: number | null;
  /** 第二轮报价不含税总额（元） */
  secondPreTaxTotal?: number | null;
  /** 第二轮报价税金（元） */
  secondTax?: number | null;
  /** 备注 */
  remark?: string | null;
}

/** 拟推荐成交候选人（第二轮报价表勾选生成） */
export interface ResultCandidate {
  /** 候选人在响应单位明细中的下标（0 起），用于回显勾选状态 */
  supplierIndex?: number | null;
  /** 拟推荐成交候选人 */
  name: string;
  /** 最终确认不含税价格（元） */
  finalPreTaxPrice?: number | null;
  /** 备注 */
  remark?: string | null;
}

export interface ResultReportData {
  /** 成交单位数量 */
  unitCount?: number | null;
  /** 采购开启时间（日期） */
  openTime?: string | Date | null;
  /** 开启地点 */
  openPlace?: string | null;
  /** 评审小组成员 */
  reviewMembers?: string | null;
  /** 审核通过响应单位数量 */
  approvedCount?: number | null;
  /** 参与响应单位数量 */
  participantCount?: number | null;
  /** 弃权响应单位数量 */
  abstainCount?: number | null;
  /** 有效响应文件数量 */
  validFileCount?: number | null;
  /** 响应单位明细（导入） */
  suppliers?: ResultSupplier[] | null;
  /** 拟推荐成交候选人（勾选） */
  candidates?: ResultCandidate[] | null;
}

export interface ResultReportContext {
  projectName?: string;
  projectAbbr?: string;
  undertaker?: string;
  /** 项目所在省市（来源：项目管理 · 项目信息） */
  provinceCity?: string;
  /** 工程地点（来源：项目管理 · 项目信息） */
  siteLocation?: string;
  /** 项目地址（来源：项目管理 · 项目信息） */
  projectAddress?: string;
  /** 采购内容（默认取采购任务内容 / 采购公告内容） */
  content?: string;
  /** 预计采购金额（元，来自总采购清单） */
  estimatedAmount?: number | null;
}

/* ---------------- 基础格式化 ---------------- */

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cell = (v: unknown): string => {
  if (v == null || v === '' || typeof v === 'object') return '';
  return `<td>${esc(v)}</td>`;
};

const fmtDate = (v: string | Date | null | undefined): string => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 金额格式化（千分位 + 2 位小数）；空值返回空串 */
export const fmtAmount = (v: number | null | undefined): string => {
  const n = numOrNull(v);
  if (n == null) return '';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** 数量格式化（整数；空值返回空串） */
export const fmtCount = (v: number | null | undefined): string => {
  const n = numOrNull(v);
  return n == null ? '' : String(n);
};

/** 数值解析：非数值 / 空 → null */
export function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 「是」判定：兼容 是 / Y / YES / TRUE / 1 等写法 */
export const isYes = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toUpperCase();
  return s === '是' || s === 'Y' || s === 'YES' || s === 'TRUE' || s === '1';
};

/* ---------------- 排序规则 ---------------- */

/** 升序比较；空值排最后（两者均为空时保持原顺序） */
const ascNullLast = (a: number | null | undefined, b: number | null | undefined): number => {
  const av = numOrNull(a);
  const bv = numOrNull(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return av - bv;
};

/** 带原下标与排名的行 */
export interface RankedSupplier {
  /** 原下标（0 起，用于回显勾选状态） */
  index: number;
  /** 排名（1 起，连续编号） */
  rank: number;
  supplier: ResultSupplier;
}

/**
 * 开启报价情况表排序：按第一轮报价不含税总额由小到大。
 * 未填写第一轮报价的单位排最后。
 */
export function rankByFirstRound(suppliers: ResultSupplier[] = []): RankedSupplier[] {
  return suppliers
    .map((supplier, index) => ({ index, rank: 0, supplier }))
    .sort((a, b) => ascNullLast(a.supplier?.firstPreTaxTotal, b.supplier?.firstPreTaxTotal))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * 第二轮报价情况表排序：仅「通过第一轮报价=是」的单位参与，
 * 按第二轮报价不含税总额由小到大；未填写第二轮报价的单位排最后。
 */
export function rankBySecondRound(suppliers: ResultSupplier[] = []): RankedSupplier[] {
  return suppliers
    .map((supplier, index) => ({ index, rank: 0, supplier }))
    .filter((row) => isYes(row.supplier?.passedFirst))
    .sort((a, b) => ascNullLast(a.supplier?.secondPreTaxTotal, b.supplier?.secondPreTaxTotal))
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

/**
 * 候选人的最终确认不含税价格默认取值：
 * 优先取第二轮报价不含税总额（通过第一轮且有报价时），否则回退到第一轮报价。
 */
export function defaultFinalPrice(supplier: ResultSupplier | null | undefined): number | null {
  if (!supplier) return null;
  const second = numOrNull(supplier.secondPreTaxTotal);
  if (isYes(supplier.passedFirst) && second != null) return second;
  return numOrNull(supplier.firstPreTaxTotal);
}

/* ---------------- 表格 HTML ---------------- */

/** 表 1：响应单位情况汇总表 */
export function buildSummaryTableHtml(suppliers: ResultSupplier[] = []): string {
  const body = suppliers.length
    ? suppliers
        .map(
          (s, i) =>
            `<tr>${cell(i + 1)}${cell(s.name)}${cell(s.depositPaid)}${cell(s.sealed)}${cell(
              s.remark,
            )}</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="text-align:center">（暂无数据，请先导入响应单位情况汇总表）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>序号</th><th>参与响应单位</th><th>响应保证金是否缴纳</th><th>响应文件密封是否完整</th><th>备注</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** 表 2：开启报价情况表（按第一轮报价不含税总额升序） */
export function buildFirstRoundTableHtml(
  suppliers: ResultSupplier[] = [],
  estimatedAmount?: number | null,
): string {
  const rows = rankByFirstRound(suppliers);
  const est = fmtAmount(estimatedAmount);
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr>${cell(r.rank)}${cell(r.supplier.name)}${cell(
              fmtAmount(r.supplier.firstPreTaxTotal),
            )}${cell(est)}${cell(fmtAmount(r.supplier.firstTax))}</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="text-align:center">（暂无数据）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>排名</th><th>参与响应单位</th><th>第一次报价不含税总额</th><th>预计采购金额</th><th>第一轮报价税金</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** 表 3：第二轮报价情况表（仅「通过第一轮报价=是」，按第二轮报价不含税总额升序） */
export function buildSecondRoundTableHtml(
  suppliers: ResultSupplier[] = [],
  estimatedAmount?: number | null,
): string {
  const rows = rankBySecondRound(suppliers);
  const est = fmtAmount(estimatedAmount);
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr>${cell(r.rank)}${cell(r.supplier.name)}${cell(
              fmtAmount(r.supplier.secondPreTaxTotal),
            )}${cell(est)}${cell(fmtAmount(r.supplier.secondTax))}</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="text-align:center">（暂无通过第一轮报价的单位）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>排名</th><th>参与响应单位</th><th>第二次报价不含税总额</th><th>预计采购金额</th><th>第二轮报价税金</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** 表 4：拟推荐成交候选人表（勾选生成） */
export function buildCandidateTableHtml(candidates: ResultCandidate[] = []): string {
  const body = candidates.length
    ? candidates
        .map(
          (c, i) =>
            `<tr>${cell(i + 1)}${cell(c.name)}${cell(fmtAmount(c.finalPreTaxPrice))}${cell(
              c.remark,
            )}</tr>`,
        )
        .join('')
    : '<tr><td colspan="4" style="text-align:center">（暂无数据，请在第二轮报价情况表中勾选）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>序号</th><th>拟推荐成交候选人</th><th>最终确认不含税价格</th><th>备注</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/* ---------------- 基本信息表 / 文档 / 变量 ---------------- */

/** 成交报告基本信息表（8 个编辑字段 + 预计采购金额） */
export function buildResultInfoTableHtml(
  data: ResultReportData,
  ctx: ResultReportContext,
): string {
  const rows: [string, string][] = [
    ['采购内容', esc(ctx.content ?? '')],
    ['预计采购金额', esc(fmtAmount(ctx.estimatedAmount))],
    ['成交单位数量', esc(fmtCount(data.unitCount))],
    ['采购开启时间', esc(fmtDate(data.openTime))],
    ['开启地点', esc(data.openPlace ?? '')],
    ['评审小组成员', esc(data.reviewMembers ?? '')],
    ['审核通过响应单位数量', esc(fmtCount(data.approvedCount))],
    ['参与响应单位数量', esc(fmtCount(data.participantCount))],
    ['弃权响应单位数量', esc(fmtCount(data.abstainCount))],
    ['有效响应文件数量', esc(fmtCount(data.validFileCount))],
  ];
  return (
    '<table><tbody>' +
    rows.map(([k, v]) => `<tr><th style="width:28%">${esc(k)}</th><td>${v}</td></tr>`).join('') +
    '</tbody></table>'
  );
}

/** 变量取值表：普通变量替换为文本，表格变量替换为对应 HTML */
export function buildResultReportVariableValues(
  data: ResultReportData,
  ctx: ResultReportContext,
): Record<string, string> {
  const suppliers = data.suppliers ?? [];
  return {
    项目名称: ctx.projectName ?? '',
    项目简称: ctx.projectAbbr ?? '',
    承接单位: ctx.undertaker ?? '',
    项目所在省市: ctx.provinceCity ?? '',
    工程地点: ctx.siteLocation ?? '',
    项目地址: ctx.projectAddress ?? '',
    采购内容: ctx.content ?? '',
    预计采购金额: fmtAmount(ctx.estimatedAmount),
    成交单位数量: fmtCount(data.unitCount),
    采购开启时间: fmtDate(data.openTime),
    开启地点: String(data.openPlace ?? ''),
    评审小组成员: String(data.reviewMembers ?? ''),
    审核通过响应单位数量: fmtCount(data.approvedCount),
    参与响应单位数量: fmtCount(data.participantCount),
    弃权响应单位数量: fmtCount(data.abstainCount),
    有效响应文件数量: fmtCount(data.validFileCount),
    '成交报告-响应单位情况汇总表': buildSummaryTableHtml(suppliers),
    '成交报告-开启报价情况表': buildFirstRoundTableHtml(suppliers, ctx.estimatedAmount),
    '成交报告-第二轮报价情况表': buildSecondRoundTableHtml(suppliers, ctx.estimatedAmount),
    '成交报告-拟推荐成交候选人表': buildCandidateTableHtml(data.candidates ?? []),
  };
}

/** 组装成交报告完整文档 HTML（各章节固定顺序） */
export function buildResultReportDocHtml(
  data: ResultReportData,
  ctx: ResultReportContext,
  title?: string,
): string {
  const suppliers = data.suppliers ?? [];
  const docTitle =
    title ?? `${ctx.projectAbbr || ctx.projectName || ''}-${ctx.content || ''}-成交报告`;
  return [
    `<h1>${esc(docTitle)}</h1>`,
    '<h2>一、成交报告基本信息</h2>',
    buildResultInfoTableHtml(data, ctx),
    '<h2>二、响应单位情况汇总表</h2>',
    buildSummaryTableHtml(suppliers),
    '<h2>三、开启报价情况表</h2>',
    buildFirstRoundTableHtml(suppliers, ctx.estimatedAmount),
    '<h2>四、第二轮报价情况表</h2>',
    buildSecondRoundTableHtml(suppliers, ctx.estimatedAmount),
    '<h2>五、拟推荐成交候选人表</h2>',
    buildCandidateTableHtml(data.candidates ?? []),
  ].join('\n');
}

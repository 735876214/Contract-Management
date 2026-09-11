/**
 * 框架协议事前说明 · 文档构建（批次二 · 任务 3.1）
 * 把事前说明各编辑区组装为文档 HTML，用于预览与导出 Word。
 * 变量占位符：{{项目名称}} {{承接单位}} {{采购内容}} {{事前说明-询价情况}} {{事前说明-价格对比表}} {{事前说明-成本分析表}}
 */

export interface InquiryRow {
  rank?: string | number | null;
  unit?: string | null;
  totalPrice?: number | null;
  taxIncluded?: string | null;
  type?: string | null;
}

export interface PriceCompareRow {
  unit?: string | null;
  content?: string | null;
  execPrice?: number | null;
  note?: string | null;
}

export interface CostRow {
  item?: string | null;
  amount?: number | null;
  ratio?: number | null;
  note?: string | null;
}

export interface ExplanationData {
  frameworkIntro?: string;
  negotiation?: string;
  inquiryRows?: InquiryRow[];
  priceCompareRows?: PriceCompareRow[];
  execution?: string;
  costRows?: CostRow[];
  attachments?: { fileName?: string; url?: string; size?: number | null }[];
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const fmtNum = (v: number | null | undefined): string =>
  v == null ? '' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

const cell = (v: unknown): string => `<td>${v == null || v === '' ? '' : esc(v)}</td>`;

/** 询价情况表（排名/单位/总价/含税/类型） */
export function buildInquiryTableHtml(rows: InquiryRow[] = []): string {
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr>${cell(r.rank)}${cell(r.unit)}${cell(fmtNum(r.totalPrice))}${cell(
              r.taxIncluded,
            )}${cell(r.type)}</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="text-align:center">（暂无数据）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>排名</th><th>单位</th><th>总价（元）</th><th>是否含税</th><th>类型</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** 同城/相邻城市局其他单位执行合同价（价格对比表） */
export function buildPriceCompareTableHtml(rows: PriceCompareRow[] = []): string {
  const body = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr>${cell(i + 1)}${cell(r.unit)}${cell(r.content)}${cell(fmtNum(
              r.execPrice,
            ))}${cell(r.note)}</tr>`,
        )
        .join('')
    : '<tr><td colspan="5" style="text-align:center">（暂无数据）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>序号</th><th>单位</th><th>合同内容</th><th>执行合同价（元）</th><th>备注</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** 成本分析表 */
export function buildCostTableHtml(rows: CostRow[] = []): string {
  const body = rows.length
    ? rows
        .map(
          (r) =>
            `<tr>${cell(r.item)}${cell(fmtNum(r.amount))}${
              r.ratio == null ? '<td></td>' : `<td>${esc(r.ratio)}%</td>`
            }${cell(r.note)}</tr>`,
        )
        .join('')
    : '<tr><td colspan="4" style="text-align:center">（暂无数据）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>成本项目</th><th>金额（万元）</th><th>占比</th><th>备注</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** 附表清单（文件名列表） */
export function buildAttachmentHtml(files: ExplanationData['attachments'] = []): string {
  if (!files?.length) return '<p>（无附表）</p>';
  return (
    '<ul>' +
    files
      .map((f) => `<li>${esc(f?.fileName || '附件')}${f?.url ? `（<a href="${esc(f.url)}">查看</a>）` : ''}</li>`)
      .join('') +
    '</ul>'
  );
}

/** 变量取值表：普通变量替换为文本，表格变量替换为表格 HTML */
export function buildExplanationVariableValues(
  data: ExplanationData,
  ctx: { projectName?: string; projectAbbr?: string; undertaker?: string; content?: string },
): Record<string, string> {
  return {
    项目名称: ctx.projectName ?? '',
    项目简称: ctx.projectAbbr ?? '',
    承接单位: ctx.undertaker ?? '',
    采购内容: ctx.content ?? '',
    '事前说明-询价情况': buildInquiryTableHtml(data.inquiryRows ?? []),
    '事前说明-价格对比表': buildPriceCompareTableHtml(data.priceCompareRows ?? []),
    '事前说明-成本分析表': buildCostTableHtml(data.costRows ?? []),
  };
}

/** 组装完整文档 HTML（各章节固定顺序，文本区支持简单换行） */
export function buildExplanationDocHtml(
  data: ExplanationData,
  ctx: { projectName?: string; projectAbbr?: string; undertaker?: string; content?: string },
  title?: string,
): string {
  const paras = (s?: string): string => {
    const t = String(s ?? '').trim();
    if (!t) return '<p>（待填写）</p>';
    return t
      .split(/\n+/)
      .map((line) => `<p>${esc(line)}</p>`)
      .join('');
  };
  const docTitle =
    title ?? `${ctx.projectAbbr || ctx.projectName || ''}-${ctx.content || ''}-框架协议事前说明`;
  return [
    `<h1>${esc(docTitle)}</h1>`,
    '<h2>一、框架简介</h2>',
    paras(data.frameworkIntro),
    '<h2>二、谈判情况</h2>',
    paras(data.negotiation),
    '<h2>三、询价情况</h2>',
    buildInquiryTableHtml(data.inquiryRows ?? []),
    '<h2>四、同城/相邻城市局其他单位执行合同价</h2>',
    buildPriceCompareTableHtml(data.priceCompareRows ?? []),
    '<h2>五、执行情况</h2>',
    paras(data.execution),
    '<h2>六、成本分析</h2>',
    buildCostTableHtml(data.costRows ?? []),
    '<h2>七、附表</h2>',
    buildAttachmentHtml(data.attachments ?? []),
  ].join('\n');
}

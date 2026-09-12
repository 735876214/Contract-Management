/**
 * 采购文件 · 文档构建与变量取值（批次二 · 任务 3.4）
 *
 * 适用范围：仅「单项采购」采购任务，入口条件为「采购公告已完成」；
 * 状态：编辑中 → 已完成（发布后）。
 *
 * 采购清单：数据来自「总采购清单」，只读不可编辑。
 * 表头：序号 | 物资名称 | 规格型号 | 计量单位 | 暂定数量 | 税前单价 | 税率 | 综合单价 | 合价 | 备注
 * 数据来源：
 * - 物资名称、规格型号、计量单位、暂定数量、备注来自总采购清单
 * - 税前单价、税率、综合单价、合价为空白（由投标方填写）
 * 表底：合价合计、报价说明。
 *
 * 变量占位符：
 * {{项目名称}} {{项目简称}} {{承接单位}} {{工程地点}} {{项目地址}}（项目基本信息）
 * {{采购编号}} {{采购内容}} {{技术质量标准}} {{验收方式}} {{付款方式}}（来源采购公告）
 * {{采购时间}} {{响应保证金}} {{报价说明}}
 * {{采购文件-采购清单}}（表格变量）
 */

/** 采购清单行（只读，来自总采购清单；价格列恒为空由投标方填写） */
export interface DocumentPurchaseItem {
  materialName?: string | null;
  spec?: string | null;
  unit?: string | null;
  qty?: number | null;
  /** 税前单价（留空，由投标方填写） */
  preTaxPrice?: number | null;
  /** 税率（留空，由投标方填写） */
  taxRate?: number | null;
  /** 综合单价（留空，由投标方填写） */
  unitPrice?: number | null;
  /** 合价（留空，由投标方填写） */
  amount?: number | null;
  /** 备注 */
  remark?: string | null;
}

export interface DocumentData {
  /** 采购时间（日期） */
  procurementTime?: string | Date | null;
  /** 响应保证金（金额，元） */
  responseDeposit?: number | null;
  /** 报价说明（富文本 HTML） */
  quoteDescription?: string | null;
  /** 采购清单（只读，来自总采购清单） */
  purchaseItems?: DocumentPurchaseItem[] | null;
}

export interface DocumentContext {
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
  /* 以下取自「采购公告」 */
  procurementNo?: string;
  techQuality?: string;
  acceptanceMethod?: string;
  paymentMethod?: string;
}

/* ---------------- 基础格式化 ---------------- */

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const cell = (v: unknown): string => `<td>${v == null || v === '' ? '' : esc(v)}</td>`;

const fmtDate = (v: string | Date | null | undefined): string => {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 金额格式化（千分位 + 2 位小数）；空值返回空串 */
export function fmtAmount(v: number | null | undefined): string {
  if (v == null || v === ('' as unknown) || !Number.isFinite(Number(v))) return '';
  return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 税率格式化（百分号） */
export function fmtRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return '';
  return `${Number(v)}%`;
}

/** 富文本区：为空给占位，非空直接注入（内容来自富文本编辑器） */
const rich = (html?: string | null): string => {
  const t = String(html ?? '').trim();
  return t && t !== '<p><br></p>' ? t : '<p>（待填写）</p>';
};

/** 去标签取纯文本（用于表格单元格内的报价说明摘要） */
export const stripHtml = (html?: string | null): string =>
  String(html ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

/**
 * 合价合计：对「合价」列求和。
 * 价格由投标方填写，系统内均为空 → 合计为空串（不臆造 0）。
 */
export function sumAmount(rows: DocumentPurchaseItem[] = []): string {
  const vals = rows
    .map((r) => r?.amount)
    .filter((v): v is number => v != null && Number.isFinite(Number(v)));
  if (!vals.length) return '';
  return fmtAmount(vals.reduce((sum, v) => sum + Number(v), 0));
}

/* ---------------- HTML 构建（预览 / 导出 Word 共用） ---------------- */

/**
 * 采购清单表（10 列）+ 表底（合价合计、报价说明）
 * 数据来自「总采购清单」，只读不编辑；价格列留空由投标方填写。
 */
export function buildDocumentPurchaseListHtml(
  rows: DocumentPurchaseItem[] = [],
  quoteDescription?: string | null,
): string {
  const body = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr>${cell(i + 1)}${cell(r.materialName)}${cell(r.spec)}${cell(r.unit)}${cell(
              r.qty == null ? '' : Number(r.qty),
            )}${cell(fmtAmount(r.preTaxPrice))}${cell(fmtRate(r.taxRate))}${cell(
              fmtAmount(r.unitPrice),
            )}${cell(fmtAmount(r.amount))}${cell(r.remark)}</tr>`,
        )
        .join('')
    : '<tr><td colspan="10" style="text-align:center">（暂无数据）</td></tr>';

  const total = sumAmount(rows);
  const quote = stripHtml(quoteDescription);
  const foot =
    '<tr><td colspan="8" style="text-align:center;font-weight:bold">合价合计</td>' +
    `<td style="font-weight:bold">${esc(total)}</td><td></td></tr>` +
    '<tr><td colspan="2" style="text-align:center;font-weight:bold">报价说明</td>' +
    `<td colspan="8">${esc(quote || '（待填写）')}</td></tr>`;

  return (
    '<table><thead><tr>' +
    '<th>序号</th><th>物资名称</th><th>规格型号</th><th>计量单位</th><th>暂定数量</th>' +
    '<th>税前单价</th><th>税率</th><th>综合单价</th><th>合价</th><th>备注</th>' +
    `</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`
  );
}

/** 采购文件基本信息表（采购编号/采购内容/采购时间/响应保证金） */
export function buildDocumentInfoTableHtml(data: DocumentData, ctx: DocumentContext): string {
  const rows: [string, string][] = [
    ['采购编号', esc(ctx.procurementNo ?? '')],
    ['采购内容', esc(ctx.content ?? '')],
    ['采购时间', esc(fmtDate(data.procurementTime))],
    ['响应保证金', data.responseDeposit == null ? '' : esc(`${fmtAmount(data.responseDeposit)} 元`)],
  ];
  return (
    '<table><tbody>' +
    rows.map(([k, v]) => `<tr><th style="width:28%">${esc(k)}</th><td>${v}</td></tr>`).join('') +
    '</tbody></table>'
  );
}

/** 变量取值表：普通变量替换为文本，表格/富文本变量替换为对应 HTML */
export function buildDocumentVariableValues(
  data: DocumentData,
  ctx: DocumentContext,
): Record<string, string> {
  return {
    项目名称: ctx.projectName ?? '',
    项目简称: ctx.projectAbbr ?? '',
    承接单位: ctx.undertaker ?? '',
    项目所在省市: ctx.provinceCity ?? '',
    工程地点: ctx.siteLocation ?? '',
    项目地址: ctx.projectAddress ?? '',
    采购编号: String(ctx.procurementNo ?? ''),
    采购内容: String(ctx.content ?? ''),
    技术质量标准: rich(ctx.techQuality),
    验收方式: rich(ctx.acceptanceMethod),
    付款方式: rich(ctx.paymentMethod),
    采购时间: fmtDate(data.procurementTime),
    响应保证金: data.responseDeposit == null ? '' : fmtAmount(data.responseDeposit),
    报价说明: rich(data.quoteDescription),
    '采购文件-采购清单': buildDocumentPurchaseListHtml(data.purchaseItems ?? [], data.quoteDescription),
  };
}

/** 组装采购文件完整文档 HTML（各章节固定顺序） */
export function buildDocumentDocHtml(
  data: DocumentData,
  ctx: DocumentContext,
  title?: string,
): string {
  const docTitle =
    title ?? `${ctx.projectAbbr || ctx.projectName || ''}-${ctx.content || ''}-采购文件`;
  return [
    `<h1>${esc(docTitle)}</h1>`,
    '<h2>一、采购文件基本信息</h2>',
    buildDocumentInfoTableHtml(data, ctx),
    '<h2>二、采购清单</h2>',
    buildDocumentPurchaseListHtml(data.purchaseItems ?? [], data.quoteDescription),
    '<h2>三、技术质量标准</h2>',
    rich(ctx.techQuality),
    '<h2>四、验收方式</h2>',
    rich(ctx.acceptanceMethod),
    '<h2>五、付款方式</h2>',
    rich(ctx.paymentMethod),
    '<h2>六、报价说明</h2>',
    rich(data.quoteDescription),
  ].join('\n');
}

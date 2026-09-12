/**
 * 采购公告 · 文档构建与变量取值（批次二 · 任务 3.3）
 *
 * 适用范围：仅「单项采购」采购任务，且状态为「采购公告编制中」（发布后变更为「已完成」）。
 *
 * 采购清单：数据来自「总采购清单」，只读不可编辑。
 * 表头：序号 | 物资名称 | 规格型号 | 计量单位 | 暂定数量 | 备注
 *
 * 变量占位符：
 * {{项目名称}} {{承接单位}} {{采购公告-采购清单}}（表格变量）
 * {{采购编号}} {{采购时间}} {{采购内容}} {{技术质量标准}} {{验收方式}} {{付款方式}}
 * {{联系人1}} {{联系电话1}} {{联系人2}} {{联系电话2}} …（按位置自动编号，支持 N 个）
 */

/** 采购清单行（只读，来自总采购清单） */
export interface NoticePurchaseItem {
  materialName?: string | null;
  spec?: string | null;
  unit?: string | null;
  qty?: number | null;
  /** 备注（总采购清单未提供该字段时为空） */
  remark?: string | null;
}

export interface NoticeData {
  procurementNo?: string | null;
  procurementTime?: string | Date | null;
  content?: string | null;
  techQuality?: string | null;
  acceptanceMethod?: string | null;
  paymentMethod?: string | null;
  /** 联系人（动态增加，按位置自动编号 联系人1/联系人2…） */
  contacts?: string[] | null;
  /** 联系电话（动态增加，按位置自动编号 联系电话1/联系电话2…） */
  contactPhones?: string[] | null;
  /** 采购清单（只读） */
  purchaseItems?: NoticePurchaseItem[] | null;
}

export interface NoticeContext {
  projectName?: string;
  projectAbbr?: string;
  undertaker?: string;
  /** 项目所在省市（来源：项目管理 · 项目信息） */
  provinceCity?: string;
  /** 工程地点（来源：项目管理 · 项目信息） */
  siteLocation?: string;
  /** 项目地址（来源：项目管理 · 项目信息） */
  projectAddress?: string;
  /** 采购内容（采购任务内容，作为默认值） */
  content?: string;
}

/** 联系人 / 联系电话配对视图（按位置编号） */
export interface ContactEntry {
  /** 编号（1 起） */
  no: number;
  name: string;
  phone: string;
}

/* ---------------- 联系人 / 联系电话编号 ---------------- */

/** 按位置把「联系人」与「联系电话」两列动态列表配对编号（长度取两者较大值） */
export function contactEntries(
  contacts: string[] | null | undefined,
  phones: string[] | null | undefined,
): ContactEntry[] {
  const a = (contacts ?? []).map((x) => String(x ?? '').trim());
  const b = (phones ?? []).map((x) => String(x ?? '').trim());
  const len = Math.max(a.length, b.length);
  const out: ContactEntry[] = [];
  for (let i = 0; i < len; i += 1) out.push({ no: i + 1, name: a[i] ?? '', phone: b[i] ?? '' });
  return out;
}

/** 「联系人 / 联系电话」变量取值（未提供的编号保留占位符便于核对） */
export function contactVariableValues(
  contacts: string[] | null | undefined,
  phones: string[] | null | undefined,
  /** 最少生成的编号数量（规格明确列出 联系人1/联系电话1、联系人2/联系电话2） */
  minCount = 2,
): Record<string, string> {
  const entries = contactEntries(contacts, phones);
  const len = Math.max(entries.length, minCount);
  const out: Record<string, string> = {};
  for (let i = 1; i <= len; i += 1) {
    const e = entries[i - 1];
    out[`联系人${i}`] = e?.name ?? '';
    out[`联系电话${i}`] = e?.phone ?? '';
  }
  return out;
}

/* ---------------- HTML 构建（预览 / 导出 Word 共用） ---------------- */

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

/** 富文本区：为空给占位，非空直接注入（内容来自富文本编辑器） */
const rich = (html?: string | null): string => {
  const t = String(html ?? '').trim();
  return t && t !== '<p><br></p>' ? t : '<p>（待填写）</p>';
};

/**
 * 采购清单表（序号|物资名称|规格型号|计量单位|暂定数量|备注）
 * 数据来自「总采购清单」，只读不编辑。
 */
export function buildNoticePurchaseListHtml(rows: NoticePurchaseItem[] = []): string {
  const body = rows.length
    ? rows
        .map(
          (r, i) =>
            `<tr>${cell(i + 1)}${cell(r.materialName)}${cell(r.spec)}${cell(r.unit)}${cell(
              r.qty == null ? '' : Number(r.qty),
            )}${cell(r.remark)}</tr>`,
        )
        .join('')
    : '<tr><td colspan="6" style="text-align:center">（暂无数据）</td></tr>';
  return (
    '<table><thead><tr>' +
    '<th>序号</th><th>物资名称</th><th>规格型号</th><th>计量单位</th><th>暂定数量</th><th>备注</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`
  );
}

/** 多值单元格：多行「联系人1：张三」，为空给占位 */
const multiCell = (entries: ContactEntry[], pick: (e: ContactEntry) => string, label: string): string => {
  const lines = entries.filter((e) => pick(e)).map((e) => `${label}${e.no}：${pick(e)}`);
  return lines.length ? lines.map((l) => esc(l)).join('<br/>') : '（待填写）';
};

/** 公告基本信息表（采购编号/采购时间/采购内容/联系人/联系电话） */
export function buildNoticeInfoTableHtml(data: NoticeData, ctx: NoticeContext): string {
  const entries = contactEntries(data.contacts, data.contactPhones);
  const rows: [string, string][] = [
    ['采购编号', esc(data.procurementNo ?? '')],
    ['采购时间', esc(fmtDate(data.procurementTime))],
    ['采购内容', esc(data.content ?? ctx.content ?? '')],
    ['联系人', multiCell(entries, (e) => e.name, '联系人')],
    ['联系电话', multiCell(entries, (e) => e.phone, '联系电话')],
  ];
  return (
    '<table><tbody>' +
    rows.map(([k, v]) => `<tr><th style="width:28%">${esc(k)}</th><td>${v}</td></tr>`).join('') +
    '</tbody></table>'
  );
}

/** 变量取值表：普通变量替换为文本，表格/富文本变量替换为对应 HTML */
export function buildNoticeVariableValues(
  data: NoticeData,
  ctx: NoticeContext,
): Record<string, string> {
  return {
    项目名称: ctx.projectName ?? '',
    项目简称: ctx.projectAbbr ?? '',
    承接单位: ctx.undertaker ?? '',
    项目所在省市: ctx.provinceCity ?? '',
    工程地点: ctx.siteLocation ?? '',
    项目地址: ctx.projectAddress ?? '',
    采购编号: String(data.procurementNo ?? ''),
    采购时间: fmtDate(data.procurementTime),
    采购内容: String(data.content ?? ctx.content ?? ''),
    技术质量标准: rich(data.techQuality),
    验收方式: rich(data.acceptanceMethod),
    付款方式: rich(data.paymentMethod),
    ...contactVariableValues(data.contacts, data.contactPhones),
    '采购公告-采购清单': buildNoticePurchaseListHtml(data.purchaseItems ?? []),
  };
}

/** 组装采购公告完整文档 HTML（各章节固定顺序） */
export function buildNoticeDocHtml(data: NoticeData, ctx: NoticeContext, title?: string): string {
  const docTitle =
    title ?? `${ctx.projectAbbr || ctx.projectName || ''}-${data.content || ctx.content || ''}-采购公告`;
  return [
    `<h1>${esc(docTitle)}</h1>`,
    '<h2>一、公告基本信息</h2>',
    buildNoticeInfoTableHtml(data, ctx),
    '<h2>二、采购清单</h2>',
    buildNoticePurchaseListHtml(data.purchaseItems ?? []),
    '<h2>三、技术质量标准</h2>',
    rich(data.techQuality),
    '<h2>四、验收方式</h2>',
    rich(data.acceptanceMethod),
    '<h2>五、付款方式</h2>',
    rich(data.paymentMethod),
  ].join('\n');
}

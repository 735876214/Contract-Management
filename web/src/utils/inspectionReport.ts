/**
 * 考察报告（批次二 · 任务 3.7）前端工具
 *
 * - 文档 HTML 构建（Word 导出 / 预览共用）
 * - 变量占位符取值：{{项目名称}} / {{承接单位}} / {{考察报告-考察内容}} / {{考察报告-考察结论}}
 * - 导出前把远程图片（考察照片）内联为 base64 dataURL，保证 Word 中可见
 */
import { replaceProcurementVariables } from '@/constants/procurementVariables';

export interface InspectionPhoto {
  fileName: string;
  url: string;
  size?: number;
}

export interface InspectionReportData {
  unitName?: string;
  inspectionTime?: string | null;
  inspectionPlace?: string;
  inspectors?: string;
  content?: string;
  conclusion?: string;
  photos?: InspectionPhoto[];
}

export interface InspectionCtx {
  projectName?: string;
  projectCode?: string;
  projectAbbr?: string;
  undertaker?: string;
  provinceCity?: string;
  siteLocation?: string;
  projectAddress?: string;
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

export function fmtInspectionDate(v?: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 空白富文本判定（空段落 / 仅换行） */
export function isEmptyRichText(html?: string | null): boolean {
  if (!html) return true;
  const text = String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
  return text === '';
}

/** 信息栏（考察单位名称/考察时间/考察地点/考察人员 两列表格） */
export function buildInspectionInfoTable(data: InspectionReportData): string {
  const row = (label: string, value: string) =>
    `<tr><td style="width:18%;background:#f2f2f2;font-weight:bold;text-align:center;">${label}</td><td>${value || ''}</td></tr>`;
  return `<table>
${row('考察单位名称', esc(data.unitName))}
${row('考察时间', esc(fmtInspectionDate(data.inspectionTime)))}
${row('考察地点', esc(data.inspectionPlace))}
${row('考察人员', esc(data.inspectors))}
</table>`;
}

/** 考察照片区（两列网格，含序号题注） */
export function buildInspectionPhotosSection(data: InspectionReportData): string {
  const photos = Array.isArray(data.photos) ? data.photos.filter((p) => p?.url) : [];
  if (!photos.length) return '<p>（暂无考察照片）</p>';
  const cells = photos.map(
    (p, i) =>
      `<td style="border:none;text-align:center;vertical-align:bottom;padding:8pt;">
        <img src="${esc(p.url)}" style="max-width:320px;max-height:240px;" />
        <div style="font-size:10pt;color:#444;">考察照片${i + 1}${p.fileName ? `（${esc(p.fileName)}）` : ''}</div>
      </td>`,
  );
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2) {
    rows.push(`<tr>${cells[i]}${cells[i + 1] ?? '<td style="border:none;"></td>'}</tr>`);
  }
  return `<table>${rows.join('')}</table>`;
}

/** Word 文档 HTML（含变量占位符，导出前由 replaceProcurementVariables 替换） */
export function buildInspectionDocHtml(
  data: InspectionReportData,
  _ctx: InspectionCtx,
  title = '考察报告',
): string {
  return `<h1>考察报告</h1>
<p style="text-align:center;color:#444;">${esc(title)}</p>
${buildInspectionInfoTable(data)}
<h2>一、考察内容</h2>
{{考察报告-考察内容}}
<h2>二、考察结论</h2>
{{考察报告-考察结论}}
<h2>三、考察照片</h2>
${buildInspectionPhotosSection(data)}`;
}

/**
 * 变量取值：
 * - 公共变量来自项目信息；考察内容/结论为富文本 HTML 值（html 变量，原样注入）
 * - 注入前先在内容内部完成公共变量替换（如内容里写了 {{项目名称}}）
 */
export function buildInspectionVariableValues(
  data: InspectionReportData,
  ctx: InspectionCtx,
): Record<string, string> {
  const common: Record<string, string> = {
    项目名称: ctx.projectName ?? '',
    项目简称: ctx.projectAbbr ?? ctx.projectName ?? '',
    承接单位: ctx.undertaker ?? '',
    项目所在省市: ctx.provinceCity ?? '',
    工程地点: ctx.siteLocation ?? '',
    项目地址: ctx.projectAddress ?? '',
  };
  const values: Record<string, string> = { ...common };
  values['考察报告-考察内容'] = replaceProcurementVariables(
    data.content || '<p></p>',
    common,
    'INSPECTION',
  );
  values['考察报告-考察结论'] = replaceProcurementVariables(
    data.conclusion || '<p></p>',
    common,
    'INSPECTION',
  );
  return values;
}

/** 导出文件名：{项目简称}-{供应商名称}-考察报告.docx */
export function inspectionExportFilename(data: InspectionReportData, ctx: InspectionCtx): string {
  const abbr = ctx.projectAbbr || ctx.projectName || '项目';
  const unit = (data.unitName || '').trim() || '供应商';
  return `${abbr}-${unit}-考察报告.docx`;
}

/** 把 HTML 中的远程图片（考察照片等）替换为 base64 dataURL（Word 内嵌显示必需） */
export async function inlineImageUrls(html: string): Promise<string> {
  if (!html) return html || '';
  const srcs = new Set<string>();
  const re = /<img[^>]+src=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const src = m[1];
    if (src && !src.startsWith('data:')) srcs.add(src);
  }
  let out = html;
  for (const src of srcs) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      const blob = await res.blob();
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      out = out.split(`src="${src}"`).join(`src="${dataUrl}"`);
      out = out.split(`src='${src}'`).join(`src='${dataUrl}'`);
    } catch {
      // 单张图片转换失败时保留原地址，不阻塞导出
    }
  }
  return out;
}

/**
 * 采购模块 Word 导出通用功能（批次四 · 任务 4.1）
 *
 * 统一导出管线：
 * 1. 读取对应的采购模板（基础信息管理 → 采购模板，按 moduleType 匹配；templateId 显式指定时优先）
 * 2. 解析模板 / 模块内置文档中的 {{变量占位符}}
 * 3. 替换为真实数据（文本变量转义注入、表格变量 / 富文本变量按 HTML 原样注入）
 * 4. 远程图片（考察照片等）内联为 base64，保证 Word 中可见
 * 5. 生成 Word 文档（MSO 兼容 HTML 封装，扩展名 .docx，Word/WPS 直接打开；表格渲染为 Word 表格）
 * 6. 自动下载并返回 Blob
 *
 * 文件命名规则：{项目简称}-{采购内容}-{模块名称}.docx
 */
import { procurementApi } from '@/api/modules';
import {
  procurementModuleLabel,
  replaceProcurementVariables,
} from '@/constants/procurementVariables';
import { WORD_TPL } from '@/utils/docExport';

export interface ProcurementExportInput {
  /** 采购模块类型：PRE_MEETING/NOTICE/DOCUMENT/RESULT_REPORT/PRICE_COMPARE/FRAMEWORK… */
  moduleType: string;
  /** 关联采购任务（用于链路追踪 / 预留服务端渲染） */
  taskId?: string;
  /** 显式指定模板 id；缺省按 moduleType 自动匹配当前项目的采购模板 */
  templateId?: string;
  /** 模块内置文档 HTML（含 {{占位符}}）；配置了采购模板时以模板内容为底稿 */
  docHtml: string;
  /** 变量取值（文本 / 表格 HTML / 富文本 HTML） */
  values: Record<string, string>;
  /** 导出文件名；缺省按 {项目简称}-{采购内容}-{模块名称}.docx */
  filename?: string;
  /** 是否把远程图片内联为 base64（默认 true；预览时可关以免重复拉图） */
  inlineImages?: boolean;
}

export interface BuiltProcurementDoc {
  /** 变量替换（含图片内联）后的最终文档 HTML */
  html: string;
  /** 是否使用了采购模板作为底稿 */
  templateUsed: boolean;
  /** 使用的采购模板名称 */
  templateName?: string;
}

/** 按 {项目简称}-{采购内容}-{模块名称}.docx 生成导出文件名 */
export function procurementExportFilename(
  abbr: string | undefined | null,
  content: string | undefined | null,
  moduleType: string,
): string {
  const a = String(abbr || '').trim() || '项目';
  const c = String(content || '').trim() || '采购';
  return `${a}-${c}-${procurementModuleLabel(moduleType)}.docx`;
}

/**
 * 读取当前模块对应的采购模板（templateId 显式指定优先，否则按 moduleType 匹配）。
 * 读取失败（接口异常 / 无模板）返回 null，导出降级为模块内置文档，不阻塞流程。
 */
export async function fetchModuleTemplate(
  moduleType: string,
  templateId?: string,
): Promise<{ id: string; templateName: string; content: string } | null> {
  try {
    if (templateId) {
      const res: any = await procurementApi.detail(templateId);
      const row = res?.data ?? res;
      if (row?.content) {
        return { id: row.id, templateName: row.templateName ?? '', content: row.content };
      }
      return null;
    }
    const res: any = await procurementApi.list();
    const list: any[] = res?.list ?? res?.data?.list ?? (Array.isArray(res) ? res : []);
    const row = list.find((t) => t?.moduleType === moduleType && t?.content);
    if (row) return { id: row.id, templateName: row.templateName ?? '', content: row.content };
    return null;
  } catch {
    return null;
  }
}

/**
 * 统一构建文档：模板优先 → 变量替换 →（可选）图片 base64 内联。
 * 预览与导出共用，保证「所见即所得」。
 */
export async function buildProcurementDoc(
  input: ProcurementExportInput,
  opts?: { inlineImages?: boolean },
): Promise<BuiltProcurementDoc> {
  const tpl = await fetchModuleTemplate(input.moduleType, input.templateId);
  const bottom = tpl?.content || input.docHtml || '';
  let html = replaceProcurementVariables(bottom, input.values ?? {}, input.moduleType);
  const inline = opts?.inlineImages ?? input.inlineImages ?? true;
  if (inline) html = await inlineImageUrls(html);
  return { html, templateUsed: !!tpl, templateName: tpl?.templateName };
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 通用导出接口：构建（模板优先）→ 替换 → 图片内联 → 生成 Word Blob → 自动下载。
 * 各采购模块统一调用本接口完成 Word 导出。
 */
export async function exportProcurementWord(input: ProcurementExportInput): Promise<Blob> {
  const { html } = await buildProcurementDoc(input, { inlineImages: true });
  const filename = input.filename || `采购文档-${procurementModuleLabel(input.moduleType)}.docx`;
  const doc = WORD_TPL(filename.replace(/\.docx?$/, ''), html || '<p></p>');
  const blob = new Blob(['\ufeff' + doc], { type: 'application/msword;charset=utf-8' });
  download(blob, filename);
  return blob;
}

/** 把 HTML 中的远程图片（如采购照片）替换为 base64 dataURL（Word 内嵌显示必需） */
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

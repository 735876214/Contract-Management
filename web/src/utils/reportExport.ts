/**
 * 报告/表格下载的统一出口：解析 `content-disposition` 文件名并触发浏览器下载。
 *
 * 之前 `ScmAnalysisPanel` / `AiReportPanel` / `GeneratePanel` / `HistoryPanel` 各写一份
 * （正则、空 headers、URL 回收），任一处改错就会出现「下载文件名乱码」或内存泄漏。
 */

export const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MIME_PDF = 'application/pdf';

/** 从响应头取 `filename*=UTF-8''...`；取不到用 fallback（不要抛错——下载本身已成功） */
export function fileNameFromDisposition(headers: unknown, fallback: string): string {
  const h = (headers || {}) as Record<string, unknown>;
  const raw = String(h['content-disposition'] ?? h['Content-Disposition'] ?? '');
  const m = /filename\*=UTF-8''([^;]+)/i.exec(raw);
  return m ? decodeURIComponent(m[1]) : fallback;
}

/**
 * 生成 `<a download>` 触发下载并回收 object URL。
 * 实现已收敛到 `utils/blobDownload.ts`（三份拷贝合一，含"延迟回收"的浏览器兼容处理），
 * 这里只做再导出，调用方零改动。
 */
export { downloadBlob } from './blobDownload.ts';

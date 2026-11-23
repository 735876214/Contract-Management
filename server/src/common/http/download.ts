import type { Response } from 'express';

/**
 * 文件下载响应的**唯一出口**（Excel / Word / PDF / ZIP / CSV / 二进制）。
 *
 * 起因（2026-11-22 质量审计）：同一件事在 20+ 个 controller 里各写一遍，已经漂移出三种写法 ——
 *  · `Content-Disposition` 有 `filename*=UTF-8''` 与 `filename=` 两种（后者不带字符集标记，
 *    中文文件名在部分客户端/代理上会乱码或截断）；
 *  · 有的 `res.end`、有的 `res.send`，有的漏 `Content-Length`；
 *  · mime 字符串硬编码在多处（写错一个字母 = 下载下来打不开）。
 *
 * 统一按 RFC 5987 输出：`filename="<ASCII 兜底>"; filename*=UTF-8''<百分号编码>` ——
 * 现代客户端用 `filename*`（中文正常），老客户端退回 ASCII 兜底（不乱码，名字里的中文变 `_`）。
 */

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  zip: 'application/zip',
  csv: 'text/csv; charset=utf-8',
  bin: 'application/octet-stream',
} as const;

export type DownloadKind = keyof typeof MIME;

/** 非 ASCII 字符替换为 `_`（保留扩展名），供 `filename=` 兜底使用 */
function asciiFallback(filename: string): string {
  const safe = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return safe || 'download';
}

/** RFC 5987 的 Content-Disposition（`filename=` 走 ASCII 兜底，`filename*` 走百分号编码） */
function contentDisposition(filename: string): string {
  const ascii = asciiFallback(filename);
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * **流式**下载的响应头（archiver 等直接 `pipe(res)` 的场景）：与 `sendFile` 同一套 mime 与文件名编码，
 * 但不缓冲整个文件、不设 Content-Length。
 */
export function sendAttachmentHeaders(
  res: Response,
  filename: string,
  kind: DownloadKind = 'zip',
  extraHeaders?: Record<string, string>,
): void {
  res.setHeader('Content-Type', MIME[kind]);
  res.setHeader('Content-Disposition', contentDisposition(filename));
  for (const [k, v] of Object.entries(extraHeaders ?? {})) res.setHeader(k, v);
}

/**
 * 以附件形式回一个二进制（统一 mime、文件名编码、Content-Length 与结束方式）。
 *
 * `extraHeaders`：附件流没有 JSON 正文，统计信息只能靠响应头回传（AI 填表的 `x-ai-filled` 等），
 * 前端要读这些头还必须带 `Access-Control-Expose-Headers`。
 */
export function sendFile(
  res: Response,
  filename: string,
  body: Buffer | string,
  kind: DownloadKind = 'xlsx',
  extraHeaders?: Record<string, string>,
): void {
  sendAttachmentHeaders(res, filename, kind, extraHeaders);
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

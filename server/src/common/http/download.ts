import type { Response } from 'express';

/**
 * 文件下载响应的**唯一出口**（Excel / Word / PDF / ZIP / CSV）。
 *
 * 起因（2026-11-22 质量审计）：同一件事在 20 个 controller 里各写一遍，已经漂移出三种写法 ——
 *  · `Content-Disposition` 有 `filename*=UTF-8''` 与 `filename=` 两种（后者不带字符集标记，
 *    中文文件名在部分客户端/代理上会乱码或截断）；
 *  · 有的 `res.end`、有的 `res.send`，有的漏 `Content-Length`；
 *  · mime 字符串硬编码在多处（写错一个字母 = 下载下来打不开）。
 *
 * 统一按 RFC 5987 输出：`filename="<ASCII 兜底>"; filename*=UTF-8''<百分号编码>`——
 * 现代客户端用 `filename*`（中文正常），老客户端退回 ASCII 兜底（不乱码，名字里的中文变 `_`）。
 */

const MIME = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  zip: 'application/zip',
  csv: 'text/csv; charset=utf-8',
} as const;

export type DownloadKind = keyof typeof MIME;

/** 非 ASCII 字符替换为 `_`（保留扩展名），供 `filename=` 兜底使用 */
function asciiFallback(filename: string): string {
  const safe = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\"\\]/g, '_');
  return safe || 'download';
}

/** 以附件形式回一个二进制（统一 mime、文件名编码与结束方式） */
export function sendFile(res: Response, filename: string, body: Buffer | string, kind: DownloadKind = 'xlsx'): void {
  res.setHeader('Content-Type', MIME[kind]);
  res.setHeader(
    'Content-Disposition',
    'attachment; filename="' + asciiFallback(filename) + "\"; filename*=UTF-8''" + encodeURIComponent(filename),
  );
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

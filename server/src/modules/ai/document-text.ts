import * as ExcelJS from 'exceljs';
import * as JSZip from 'jszip';
import { docxXmlToText } from './docx-text';

/**
 * 上传文件 → 供模型阅读的纯文本。
 *
 * 只支持 `.docx` 与 `.xlsx`：`.doc`（二进制 OLE）与 `.pdf` 都要额外依赖或外部服务，
 * 而且准确率差——与其静默抽成乱码，不如在入口就拒绝并提示另存为 docx/xlsx。
 */
export const DOC_EXTS = ['.docx', '.xlsx'] as const;
export type DocExt = (typeof DOC_EXTS)[number];

/** 单文件正文上限：够一份几十页合同，超出截断并在响应里告诉用户 */
const MAX_TEXT_CHARS = 60000;
const XLSX_MAX_ROWS = 3000;
const XLSX_MAX_COLS = 40;

export interface ExtractedDoc {
  kind: 'docx' | 'xlsx';
  fileName: string;
  text: string;
  chars: number;
  /** 正文被截断（文件太长，模型上下文放不下） */
  truncated: boolean;
  sheetNames?: string[];
}

export function extOf(fileName: string): string {
  const m = /\.[^.]+$/.exec(String(fileName || ''));
  return m ? m[0].toLowerCase() : '';
}

export async function extractDocxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const main = zip.file('word/document.xml');
  if (!main) throw new Error('不是有效的 docx：缺少 word/document.xml');
  const xml = await main.async('string');
  return docxXmlToText(xml);
}

export async function extractXlsxText(buffer: Buffer): Promise<{ text: string; sheetNames: string[]; truncated: boolean }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const chunks: string[] = [];
  let truncated = false;
  wb.eachSheet((ws) => {
    chunks.push(`【工作表：${ws.name}】`);
    const maxRow = Math.min(ws.rowCount || 0, XLSX_MAX_ROWS);
    for (let r = 1; r <= maxRow; r += 1) {
      const row = ws.getRow(r);
      const cells: string[] = [];
      const maxCol = Math.min(row.cellCount || 0, XLSX_MAX_COLS);
      for (let c = 1; c <= maxCol; c += 1) {
        const v = row.getCell(c).value as any;
        const text =
          v === null || v === undefined
            ? ''
            : typeof v === 'object' && 'text' in v
              ? String((v as any).text ?? '')
              : typeof v === 'object' && 'result' in v
                ? String((v as any).result ?? '')
                : String(v);
        cells.push(text.replace(/\s+/g, ' ').trim());
      }
      if (cells.some((x) => x)) chunks.push(cells.join(' | '));
    }
    if ((ws.rowCount || 0) > XLSX_MAX_ROWS) truncated = true;
  });
  return { text: chunks.join('\n'), sheetNames: wb.worksheets.map((w) => w.name), truncated };
}

export async function extractDocumentText(buffer: Buffer, fileName: string): Promise<ExtractedDoc> {
  const ext = extOf(fileName) as DocExt;
  if (ext === '.docx') {
    const text = await extractDocxText(buffer);
    const clipped = text.length > MAX_TEXT_CHARS;
    return {
      kind: 'docx',
      fileName,
      text: clipped ? text.slice(0, MAX_TEXT_CHARS) : text,
      chars: text.length,
      truncated: clipped,
    };
  }
  if (ext === '.xlsx') {
    const { text, sheetNames, truncated } = await extractXlsxText(buffer);
    const clipped = text.length > MAX_TEXT_CHARS;
    return {
      kind: 'xlsx',
      fileName,
      text: clipped ? text.slice(0, MAX_TEXT_CHARS) : text,
      chars: text.length,
      truncated: clipped || truncated,
      sheetNames,
    };
  }
  throw new Error(`不支持的文件类型 ${ext || '(无扩展名)'}：请上传 .docx 或 .xlsx`);
}

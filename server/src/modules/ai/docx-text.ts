/**
 * 把 `word/document.xml` 转成**带表格结构的纯文本**（零依赖，可被 `.mts` 单测直接加载）。
 *
 * 为什么不用现成的 docx 解析库：项目里没有，而登记只关心「文字 + 表格行列」，
 * WordprocessingML 的这部分结构非常稳定，自己走一遍标签比引依赖划算。
 * 保留表格用 ` | ` 分隔单元格、行尾换行——合同里的开户行/账号/明细都在表格里，
 * 拍平成一串会让「账号」和相邻的「开户行」粘在一起，模型容易串行。
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}

export interface DocxTextOptions {
  /** 表格单元格之间的分隔符，默认 ` | ` */
  cellSeparator?: string;
  /** 保留空段落（合同模板里常用来占位），默认丢弃 */
  keepEmptyLines?: boolean;
}

export function docxXmlToText(xml: string, options: DocxTextOptions = {}): string {
  const cellSep = options.cellSeparator ?? ' | ';
  const lines: string[] = [];
  const tokens = String(xml || '').match(/<[^>]+>|[^<]+/g) ?? [];

  let inText = false;
  let paragraph = '';
  let cell: string | null = null;
  let row: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.replace(/\n+$/g, '');
    paragraph = '';
    if (cell !== null) {
      cell += text ? (cell ? '\n' : '') + text : '';
      return;
    }
    if (text.trim() || options.keepEmptyLines) lines.push(text);
  };

  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (inText) paragraph += decodeXmlEntities(token);
      continue;
    }
    const selfClosing = token.endsWith('/>');
    const name = /^<\/?\s*([\w:]+)/.exec(token)?.[1] ?? '';
    const closing = token.startsWith('</');
    switch (name) {
      case 'w:t':
        inText = !closing && !selfClosing;
        break;
      case 'w:tab':
        paragraph += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        paragraph += '\n';
        break;
      case 'w:p':
        if (closing) flushParagraph();
        break;
      case 'w:tc':
        if (closing) {
          row.push((cell ?? '').trim());
          cell = null;
        } else {
          cell = '';
          paragraph = '';
        }
        break;
      case 'w:tr':
        if (closing) {
          if (row.some((c) => c)) lines.push(row.join(cellSep).trim());
          row = [];
          cell = null;
        }
        break;
      default:
        break;
    }
  }
  if (paragraph.trim()) flushParagraph();
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 正文里出现这些词基本可以认定是合同（用于拒绝把无关文件丢进登记） */
const CONTRACT_HINTS = ['合同', '协议', '甲方', '乙方', '供方', '购方', '货款', '结算'];

export function looksLikeContract(text: string): boolean {
  const t = String(text || '');
  if (t.length < 60) return false;
  return CONTRACT_HINTS.filter((k) => t.includes(k)).length >= 3;
}

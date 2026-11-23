import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFPage, rgb } from 'pdf-lib';

/**
 * 汇报材料 → PDF（**只依赖 pdf-lib，不碰 fs**；字体字节由调用方给）。
 *
 * 为什么自己排版而不是把 HTML 丢给渲染引擎：
 * 这个项目不引 headless Chrome / LibreOffice（单实例、镜像越小越好），
 * 而汇报材料的结构是我们自己定的（标题 + 二级标题 + 列表 + 段落），
 * 用 pdf-lib 直接画反而更可控，也省掉一大堆字体/样式兼容问题。
 *
 * 排版规则贴近公文：A4、四边 2cm、标题居中加粗（用字号模拟）、正文 10.5pt、行距 1.6、
 * 页眉放材料名、页脚放「第 X 页 / 共 Y 页」。
 */

/**
 * 字体来源：生产给 TTF/OTF 字节（pdf-lib 无内置汉字字体）；
 * 单测用工厂函数塞一个标准字体，避免测试依赖系统字体文件。
 */
export type PdfFontSource = Uint8Array | ((doc: PDFDocument) => Promise<PDFFont>);

export interface PdfRenderOptions {
  font: PdfFontSource;
  title: string;
  header?: string;
  footer?: string;
  /** 页码文案（默认中文；单测用标准字体时传 ASCII） */
  pageLabel?: (index: number, total: number) => string;
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = { top: 64, bottom: 56, left: 56, right: 56 };
const BODY_SIZE = 10.5;
const LINE_GAP = 1.6;
const HEAD1_SIZE = 16;
const HEAD2_SIZE = 12.5;

/** 一行文本（已折行） */
interface Line {
  text: string;
  size: number;
  /** 上方额外留白 */
  spaceBefore: number;
  /** 是否居中（标题） */
  center?: boolean;
  bullet?: boolean;
}

const stripInline = (s: string): string => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');

/**
 * Markdown → 行序列。只认汇报材料用到的语法：`#`/`##`/`###`、`- `、`1. `、空行分段。
 * 表格按「单元格用 · 分隔」的纯文本行输出——PDF 里画表格性价比不高，领导的材料也不看表格。
 */
export function markdownToLines(md: string): Line[] {
  const out: Line[] = [];
  const raw = String(md ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  for (const source of raw) {
    const line = stripInline(source.trimEnd());
    if (!line.trim()) {
      out.push({ text: '', size: BODY_SIZE, spaceBefore: 0 });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push({
        text: h[2].trim(),
        size: level === 1 ? HEAD1_SIZE : level === 2 ? HEAD2_SIZE : BODY_SIZE + 1,
        spaceBefore: level === 1 ? 0 : 10,
        center: level === 1,
      });
      continue;
    }
    if (/^\|.*\|$/.test(line.trim())) {
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔行
      out.push({ text: cells.filter(Boolean).join('  ·  '), size: BODY_SIZE, spaceBefore: 0 });
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      out.push({ text: ul[1], size: BODY_SIZE, spaceBefore: 0, bullet: true });
      continue;
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      out.push({ text: ol[1], size: BODY_SIZE, spaceBefore: 0, bullet: true });
      continue;
    }
    out.push({ text: line, size: BODY_SIZE, spaceBefore: 0 });
  }
  return out;
}

/** 按可用宽度逐字折行（中文没有空格，按字符累加最稳） */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  let cur = '';
  let width = 0;
  for (const ch of text) {
    const w = font.widthOfTextAtSize(ch, size);
    if (width + w > maxWidth && cur) {
      // 断行时**保留**当前字符（含空格）到下一行：丢掉空格会把两个英文单词粘在一起
      lines.push(cur);
      cur = ch;
      width = w;
      continue;
    }
    cur += ch;
    width += w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export async function renderReportPdf(markdown: string, opts: PdfRenderOptions): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  // pdf-lib 内嵌 TTF/OTF 必须注册 fontkit（不注册只能嵌 14 个标准字体，汉字全丢）
  pdf.registerFontkit(fontkit);
  const font =
    typeof opts.font === 'function'
      ? await opts.font(pdf)
      : await pdf.embedFont(opts.font, { subset: true });
  pdf.setTitle(opts.title || '汇报材料');
  pdf.setCreator('合同管理系统');

  const contentWidth = A4.width - MARGIN.left - MARGIN.right;
  const bottomLimit = MARGIN.bottom + 18;

  let page: PDFPage = pdf.addPage([A4.width, A4.height]);
  let y = A4.height - MARGIN.top;

  const newPage = () => {
    page = pdf.addPage([A4.width, A4.height]);
    y = A4.height - MARGIN.top;
  };

  for (const line of markdownToLines(markdown)) {
    if (!line.text) {
      y -= BODY_SIZE * 0.6;
      continue;
    }
    y -= line.spaceBefore;
    const bulletIndent = line.bullet ? 12 : 0;
    const available = contentWidth - bulletIndent;
    const parts = wrapText(line.text, font, line.size, available);
    for (let i = 0; i < parts.length; i += 1) {
      const lineHeight = line.size * LINE_GAP;
      if (y - lineHeight < bottomLimit) newPage();
      const isFirst = i === 0;
      if (isFirst && line.bullet) {
        page.drawText('·', { x: MARGIN.left, y: y - line.size, size: line.size, font, color: rgb(0.2, 0.2, 0.2) });
      }
      // 折行处残留的行首空格不画出来（只影响视觉，不影响内容）
      const drawn = parts[i].replace(/^\s+/, '');
      const x = line.center
        ? MARGIN.left + Math.max(0, (contentWidth - font.widthOfTextAtSize(drawn, line.size)) / 2)
        : MARGIN.left + bulletIndent;
      page.drawText(drawn, {
        x,
        y: y - line.size,
        size: line.size,
        font,
        color: rgb(0.08, 0.08, 0.08),
      });
      y -= lineHeight;
    }
  }

  // 页眉/页脚最后画（总页数已知）
  const pages = pdf.getPages();
  const headerText = opts.header || opts.title || '';
  const footerText = opts.footer || '本材料由系统数据自动汇总生成，请核对后使用';
  pages.forEach((p, idx) => {
    const index = (opts.pageLabel ?? ((i: number, total: number) => `第 ${i} 页 / 共 ${total} 页`))(
      idx + 1,
      pages.length,
    );
    if (headerText) {
      const size = 8.5;
      const w = font.widthOfTextAtSize(headerText, size);
      p.drawText(headerText, {
        x: (A4.width - w) / 2,
        y: A4.height - MARGIN.top + 18,
        size,
        font,
        color: rgb(0.45, 0.45, 0.45),
      });
      p.drawLine({
        start: { x: MARGIN.left, y: A4.height - MARGIN.top + 12 },
        end: { x: A4.width - MARGIN.right, y: A4.height - MARGIN.top + 12 },
        thickness: 0.5,
        color: rgb(0.8, 0.8, 0.8),
      });
    }
    const size = 8.5;
    const fw = font.widthOfTextAtSize(footerText, size);
    const iw = font.widthOfTextAtSize(index, size);
    p.drawText(footerText, {
      x: (A4.width - fw) / 2,
      y: MARGIN.bottom - 8,
      size,
      font,
      color: rgb(0.45, 0.45, 0.45),
    });
    p.drawText(index, {
      x: A4.width - MARGIN.right - iw,
      y: MARGIN.bottom - 22,
      size,
      font,
      color: rgb(0.45, 0.45, 0.45),
    });
  });

  return Buffer.from(await pdf.save());
}

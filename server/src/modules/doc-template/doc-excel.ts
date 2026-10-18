import ExcelJS from 'exceljs';

/**
 * **单据 Excel 渲染引擎**（业务 2026-10-17：五类单据模板改为上传 xlsx、生成路径 Word → Excel）。
 *
 * 口径：
 * - 模板 = 普通 .xlsx，占位符写在单元格文本里，语法与合同/采购模板**一致**：`{{变量名}}`；
 * - 渲染 = 遍历所有 worksheet 的所有单元格，把含 `{{名}}` 的字符串用 `values` 替换
 *   （一个单元格里有多个占位符也能一并替换；未取到值的占位符**原样保留**——
 *   与 template-render 同一口径：打印件上留着 `{{xxx}}` 一眼能看出缺什么）；
 * - **表格占位符**（`tables` 传入的，如 `{{结算明细表}}`）：
 *   - 单元格文本**只有**该占位符（允许首尾空白）→ **真正的行展开**（2026-10-18）：
 *     从该单元格向右、向下写出二维数组；需要多出 N−1 行时在下方插行，
 *     新行套用占位符所在行的**样式与行高**，下方的合并单元格区域一并下移。
 *     行数组首行由调用方决定是否为表头（`itemsToRows()` 会带表头）；
 *   - 占位符与文字混排（如「合计：{{结算明细表}}」）→ 退回旧行为：整格替换为**多行文本**
 *     （单元格内换行、每行 `列1\t列2`），因为此时不存在可展开的单元格区域；
 * - 富文本单元格（cell.type === RichText）取 text 拼接后整体替换回纯文本（模板一般不会用到）；
 * - 公式单元格不触碰（只在 cell.value 为纯字符串时替换）。
 */

export interface DocExcelRenderOptions {
  /** 模板 xlsx 二进制 */
  template: Buffer;
  /** 单值占位符取值表（键 = 变量名，如 `单据编号`） */
  values: Record<string, string>;
  /** 表格占位符：键 = 变量名，值 = 行数组（每行为列文本数组） */
  tables?: Record<string, string[][]>;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 单元格文本（字符串 / 富文本拼接；其他类型返回空串） */
function cellText(cell: ExcelJS.Cell): string {
  const v: any = cell.value;
  if (typeof v === 'string') return v;
  if (Array.isArray(v?.richText)) return v.richText.map((t: any) => t.text).join('');
  return '';
}

/** 单元格文本里的 {{名}} 替换（与 template-render 同语义：未取到值原样保留） */
export function replaceCellText(
  text: string,
  values: Record<string, string>,
  tables: Record<string, string[][]> = {},
): string {
  // 先做表格占位符（整格多行文本：仅用于占位符与文字混排、无法行展开的场景）
  let out = text;
  for (const [name, rows] of Object.entries(tables)) {
    const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`);
    if (pattern.test(out)) {
      const cellText = (rows || []).map((cols) => (cols || []).join('\t')).join('\n');
      out = out.replace(pattern, cellText);
    }
  }
  // 再做单值占位符（同一单元格可能有多个、与文字混排）
  return out.replace(/\{\{\s*([^{}]{1,60}?)\s*\}\}/g, (raw, name: string) => {
    const v = values[name];
    return v === undefined || v === null ? raw : String(v);
  });
}

interface TableHit {
  row: number;
  col: number;
  rows: string[][];
}

/** 收集「单元格文本恰为某个表格占位符」的位置（混排的不收，走多行文本兜底） */
function findTableHits(ws: ExcelJS.Worksheet, tables: Record<string, string[][]>): TableHit[] {
  const hits: TableHit[] = [];
  const patterns = Object.entries(tables).map(([name, rows]) => ({
    re: new RegExp(`^\\s*\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}\\s*$`),
    rows: rows || [],
  }));
  if (!patterns.length) return hits;
  ws.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const text = cellText(cell);
      if (!text.includes('{{')) return;
      const hit = patterns.find((p) => p.re.test(text));
      if (hit) hits.push({ row: rowNumber, col: colNumber, rows: hit.rows });
    });
  });
  // 自下而上处理：插行只影响更下方的行，先处理下方命中不会让上方坐标失效
  return hits.sort((a, b) => b.row - a.row || a.col - b.col);
}

/** 列字母 ↔ 列号（1 起） */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}


/**
 * 合并单元格区域整体下移。
 * ExcelJS 的 `spliceRows()` **不会**移动合并区域（实测 `model.merges` 原样保留），
 * 不手动重映射就会出现「数据下移、合并框留在原处」的错位。
 */
function shiftMergesBelow(ws: ExcelJS.Worksheet, atRow: number, count: number): void {
  const merges = (ws.model.merges || []).slice();
  if (!count || !merges.length) return;
  const parsed = merges.map((ref) => {
    const [from, to = from] = ref.split(':');
    const a = /^\$?([A-Z]+)\$?(\d+)$/.exec(from)!;
    const b = /^\$?([A-Z]+)\$?(\d+)$/.exec(to)!;
    const cols = [colIndex(a[1]), colIndex(b[1])];
    const rows = [Number(a[2]), Number(b[2])];
    return {
      left: Math.min(...cols),
      right: Math.max(...cols),
      top: Math.min(...rows),
      bottom: Math.max(...rows),
    };
  });
  for (const ref of merges) ws.unMergeCells(ref);
  for (const r of parsed) {
    const top = r.top >= atRow ? r.top + count : r.top;
    const bottom = r.bottom >= atRow ? r.bottom + count : r.bottom;
    ws.mergeCells(top, r.left, bottom, r.right);
  }
}

const cloneStyle = (style: any) => (style ? JSON.parse(JSON.stringify(style)) : {});

/** 把一处表格占位符按二维数组展开：插行、复制样式与行高、合并区域下移、写值 */
function expandTable(ws: ExcelJS.Worksheet, hit: TableHit): void {
  const { row, col, rows } = hit;
  if (!rows.length) {
    // 空表：清掉占位符、保留单元格样式
    ws.getCell(row, col).value = null;
    return;
  }

  const count = rows.length - 1;
  if (count > 0) {
    // 先取模板行的样式与行高（spliceRows 之后行对象会重排）。
    // ⚠️ 必须 includeEmpty: true：模板行里「只有边框/字体、没有值」的单元格也要复制样式；
    // 它的回调对空洞给 undefined，跳过即可。
    const templateRow = ws.getRow(row);
    const styles = new Map<number, any>();
    templateRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (cell) styles.set(colNumber, cloneStyle(cell.style));
    });
    const height = templateRow.height;

    ws.spliceRows(row + 1, 0, ...Array.from({ length: count }, () => [] as any[]));
    shiftMergesBelow(ws, row + 1, count);

    for (let i = 1; i <= count; i++) {
      const inserted = ws.getRow(row + i);
      if (height) inserted.height = height;
      for (const [colNumber, style] of styles) {
        inserted.getCell(colNumber).style = cloneStyle(style);
      }
    }
  }

  rows.forEach((cols, i) => {
    (cols || []).forEach((v, j) => {
      ws.getCell(row + i, col + j).value = v === undefined || v === null ? null : String(v);
    });
  });
}

/** 读模板 → 表格占位符行展开 → 全单元格替换 → 输出 xlsx Buffer */
export async function renderTemplateExcel(opts: DocExcelRenderOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(opts.template as any);

  const replaceCell = (cell: ExcelJS.Cell) => {
    const apply = (text: string) => {
      if (!text.includes('{{')) return;
      const next = replaceCellText(text, opts.values, opts.tables ?? {});
      if (next !== text) {
        cell.value = next;
        // 多行文本自动开换行，避免打印挤成一行
        if (next.includes('\n') && !cell.alignment?.wrapText) {
          cell.alignment = { ...cell.alignment, wrapText: true };
        }
      }
    };
    // 字符串单元格
    const v = cell.value;
    if (typeof v === 'string') {
      apply(v);
      return;
    }
    // 富文本单元格：拼接替换后整体转纯文本
    if (Array.isArray((v as any)?.richText)) {
      apply((v as any).richText.map((t: any) => t.text).join(''));
    }
    // 公式/其他类型不触碰
  };

  const tables = opts.tables ?? {};
  for (const ws of wb.worksheets) {
    // 先展开表格（会插行），再做单值替换——否则先替换会让占位符文本不再是「整格占位符」
    for (const hit of findTableHits(ws, tables)) expandTable(ws, hit);
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => replaceCell(cell));
    });
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

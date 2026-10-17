import ExcelJS from 'exceljs';

/**
 * **单据 Excel 渲染引擎**（业务 2026-10-17：五类单据模板改为上传 xlsx、生成路径 Word → Excel）。
 *
 * 口径：
 * - 模板 = 普通 .xlsx，占位符写在单元格文本里，语法与合同/采购模板**一致**：`{{变量名}}`；
 * - 渲染 = 遍历所有 worksheet 的所有单元格，把含 `{{名}}` 的字符串用 `values` 替换
 *   （一个单元格里有多个占位符也能一并替换；未取到值的占位符**原样保留**——
 *   与 template-render 同一口径：打印件上留着 `{{xxx}}` 一眼能看出缺什么）；
 * - **表格占位符**（`tables` 传入的，如 `{{结算明细表}}`）：整格替换为多行文本——
 *   单元格内换行（wrapText），每行一条 `列1\t列2`（制表符分列，Excel 粘贴/打印可读）；
 *   真正的 Excel 行展开首版不做（记 TODO），多行文本已满足「数据来自表格、导出 Excel」的核对场景；
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

/** 单元格文本里的 {{名}} 替换（与 template-render 同语义：未取到值原样保留） */
export function replaceCellText(
  text: string,
  values: Record<string, string>,
  tables: Record<string, string[][]> = {},
): string {
  // 先做表格占位符（整格多行文本）
  let out = text;
  for (const [name, rows] of Object.entries(tables)) {
    const pattern = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`);
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

/** 读模板 → 全单元格替换 → 输出 xlsx Buffer */
export async function renderTemplateExcel(opts: DocExcelRenderOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(opts.template as any);

  const replaceCell = (cell: ExcelJS.Cell) => {
    const v = cell.value;
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

  for (const ws of wb.worksheets) {
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => replaceCell(cell));
    });
  }


  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

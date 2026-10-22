import { BadRequestException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { StyledExcelService } from './styled-excel.service';
import { sanitizeSheetName } from '../utils/excel-sheet';

export interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
}

@Injectable()
export class ExcelService {
  constructor(private readonly styled: StyledExcelService) {}

  /** 生成 Excel 文件 Buffer（含中建 logo 表头：第 1~2 行，列表头第 3 行，数据第 4 行起） */
  async export(columns: ExcelColumn[], rows: any[], sheetName = 'Sheet1'): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sanitizeSheetName(sheetName, 'Sheet1'));
    this.styled.writeLogoHeader(ws, { title: sheetName, lastCol: columns.length });
    ws.getRow(3).values = columns.map((c) => c.header);
    ws.getRow(3).font = { bold: true };
    ws.getRow(3).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width || 18;
      ws.getCell(3, i + 1).border = {
        top: { style: 'thin', color: { argb: 'FF000000' } },
        left: { style: 'thin', color: { argb: 'FF000000' } },
        bottom: { style: 'thin', color: { argb: 'FF000000' } },
        right: { style: 'thin', color: { argb: 'FF000000' } },
      };
    });
    rows.forEach((r) => ws.addRow(columns.map((c) => r[c.key] ?? null)));
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /**
   * 解析上传的 Excel：表头 -> 数据行（对象数组）
   * @param skipRowNumbers 需要跳过的行号（1 基），如填写模板的示例行固定为第 2 行
   * @param headerRowNo 表头所在行号（1 基）。导出的文件带 logo 表头，表头在第 3 行，
   *   用 `detectHeaderRow()` 探测后传入；默认 1（填写模板的口径）
   */
  async parse(buffer: Buffer, skipRowNumbers: number[] = [], headerRowNo = 1): Promise<any[]> {
    const skip = new Set(skipRowNumbers);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const colCount = Math.max(ws.columnCount || 0, ws.getRow(headerRowNo).cellCount || 0);
    // 表头行：优先用调用方指定的行，指定行没有表头（导出件的第 1 行是 logo 头）时自动往后探测（P1-2）
    const headerRow = this.pickHeaderRow(ws, headerRowNo, colCount);
    // **按列号固定取表头**（P1-3）：中间存在空表头列时也要占位，
    // 否则后面各列整体左移一格，值会被塞进前一列的字段里（金额列进文本、文本进金额列）。
    const headers: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      headers[c - 1] = this.headerText(ws.getRow(headerRow).getCell(c).value);
    }
    const rows: any[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRow || skip.has(rowNumber)) return;
      const obj: any = {};
      headers.forEach((h, i) => {
        if (!h) return;
        let v: any = this.cellValue(row.getCell(i + 1).value);
        // 日期单元格统一为 YYYY-MM-DD 字符串，便于各模块按文本日期解析
        if (v instanceof Date) {
          v = Number.isNaN(v.getTime())
            ? null
            : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
        } else if (typeof v === 'string' && /^\d(?:\.\d+)?[eE]\+?\d+$/.test(v.trim())) {
          // 长数字被 Excel 自己转成了科学计数法：原始位已经丢了，导入只会写入错值
          throw new BadRequestException(
            `第 ${rowNumber} 行「${h}」是科学计数法（${v.trim()}），原始数字已丢失精度：请把该列设为「文本」格式后重新填写`,
          );
        } else if (typeof v === 'number' && String(Math.abs(Math.trunc(v))).length > 15) {
          // 15 位以上整数：Excel 数字只有 15 位可靠精度，身份证/银行账号到这里已经不是原值
          throw new BadRequestException(
            `第 ${rowNumber} 行「${h}」是 ${v}：超过 15 位的长数字被 Excel 转成浮点后已丢精度，请把该列设为「文本」格式后重新填写`,
          );
        }
        obj[h] = v;
      });
      if (Object.values(obj).some((v) => v !== null && v !== undefined && v !== '')) rows.push(obj);
    });
    return rows;
  }

  /**
   * 单元格原始值：富文本取 text、公式取计算结果，其余原样。
   * 抽出来是为了让表头与数据行用完全一样的取值口径。
   */
  private cellValue(cell: any): any {
    if (cell && typeof cell === 'object') {
      if ('text' in cell) return cell.text;
      if ('result' in cell) return cell.result;
    }
    return cell;
  }

  /** 表头文本：去空白、去填写模板的必填 `*` 前缀 */
  private headerText(cell: any): string {
    const v = this.cellValue(cell);
    return String(v ?? '')
      .trim()
      .replace(/^\*/, '');
  }

  /**
   * 选表头行（P1-2）：`export()` 产出的文件第 1~2 行是 logo/标题、表头在第 3 行，
   * 而填写模板的表头在第 1 行。调用方给的 `preferred` 行如果几乎没有表头（<2 列），
   * 就在前 6 行里挑表头列最多的一行——这样「导出 → 改 → 导回」不必逐模块传行号。
   */
  private pickHeaderRow(ws: ExcelJS.Worksheet, preferred: number, colCount: number): number {
    /**
     * 每行的「表头像不像」打分 = **不同**非空文本的个数。
     * 用「不同」而不是「非空」是因为导出文件第 1~2 行是**合并单元格的标题**：
     * ExcelJS 会把合并区域里每个格子的值都读成同一个标题文本，
     * 按非空计数时标题行（3 个格子同文）会赢过真正的表头行（如 2 列），实测就是这样错判的。
     */
    const filled = (r: number): number => {
      const set = new Set<string>();
      for (let c = 1; c <= colCount; c++) {
        const text = this.headerText(ws.getRow(r).getCell(c).value);
        if (text) set.add(text);
      }
      return set.size;
    };
    if (filled(preferred) >= 2) return preferred;
    let best = preferred;
    let bestN = filled(preferred);
    const scan = Math.min(6, ws.rowCount || 6);
    for (let r = 1; r <= scan; r++) {
      const n = filled(r);
      if (n > bestN) {
        bestN = n;
        best = r;
      }
    }
    return bestN >= 2 ? best : preferred;
  }

  /**
   * 探测表头行号：在表头候选区（前 `maxScan` 行）里找同时含指定列名的行。
   *
   * 存在的理由：`export()` 产出的文件第 1~2 行是 logo/标题、表头在第 3 行，
   * 而填写模板的表头在第 1 行。用户的真实用法是「导出 → 改 → 导回」，
   * 若固定按第 1 行取表头，导出的文件原样导回会被解析成 0 行且不报错。
   */
  async detectHeaderRow(buffer: Buffer, requiredHeaders: string[], maxScan = 6): Promise<number> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.worksheets[0];
    if (!ws) return 1;
    const wanted = requiredHeaders.map((h) => h.replace(/^\*/, '').trim());
    for (let r = 1; r <= Math.min(maxScan, ws.rowCount || maxScan); r++) {
      const cells: string[] = [];
      ws.getRow(r).eachCell((cell) => cells.push(String(cell.value ?? '').trim().replace(/^\*/, '')));
      if (wanted.every((h) => cells.includes(h))) return r;
    }
    return 1;
  }
}

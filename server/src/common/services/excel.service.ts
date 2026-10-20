import { Injectable } from '@nestjs/common';
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
    const headers: string[] = [];
    ws.getRow(headerRowNo).eachCell((cell) => {
      // 填写模板表头的必填列带 * 前缀，解析时统一去除，导入端按原始列名取值
      headers.push(String(cell.value ?? '').trim().replace(/^\*/, ''));
    });
    const rows: any[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowNo || skip.has(rowNumber)) return;
      const obj: any = {};
      headers.forEach((h, i) => {
        if (!h) return;
        const cell: any = row.getCell(i + 1).value;
        let v: any;
        if (cell && typeof cell === 'object' && 'text' in cell) v = cell.text;
        else if (cell && typeof cell === 'object' && 'result' in cell) v = cell.result;
        else v = cell;
        // 日期单元格统一为 YYYY-MM-DD 字符串，便于各模块按文本日期解析
        if (v instanceof Date) {
          v = Number.isNaN(v.getTime())
            ? null
            : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
        }
        obj[h] = v;
      });
      if (Object.values(obj).some((v) => v !== null && v !== undefined && v !== '')) rows.push(obj);
    });
    return rows;
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

import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

export interface ExcelColumn {
  header: string;
  key: string;
  width?: number;
}

@Injectable()
export class ExcelService {
  /** 生成 Excel 文件 Buffer */
  async export(columns: ExcelColumn[], rows: any[], sheetName = 'Sheet1'): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName);
    ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
    ws.getRow(1).font = { bold: true };
    rows.forEach((r) => ws.addRow(r));
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /** 解析上传的 Excel：表头 -> 数据行（对象数组） */
  async parse(buffer: Buffer): Promise<any[]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell) => headers.push(String(cell.value ?? '').trim()));
    const rows: any[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const obj: any = {};
      headers.forEach((h, i) => {
        if (!h) return;
        const cell: any = row.getCell(i + 1).value;
        obj[h] = cell && typeof cell === 'object' && 'text' in cell ? cell.text : cell;
      });
      if (Object.values(obj).some((v) => v !== null && v !== undefined && v !== '')) rows.push(obj);
    });
    return rows;
  }
}

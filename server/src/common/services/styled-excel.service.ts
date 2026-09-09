import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';

/**
 * 中建项目管理表格样式导出服务
 *
 * 样式规范（表格样式需求文档固化）：
 * - 第一行：品牌标识行「中国建筑」+「中国建筑土木建设有限公司物资管理表格」
 * - 第二行：表格标题（居中、加粗、大于正文字号）
 * - 表头：浅灰 F0F0F0 底色、加粗、居中、细边框
 * - 正文：细边框；金额 2 位小数右对齐、数量 4 位小数右对齐、日期 YYYY-MM-DD、布尔/枚举居中
 * - 合计行：浅灰底色、加粗、SUBTOTAL(109) 公式（支持筛选汇总）
 * - 打印：A4 横向、每页重复标题行、所有列一页宽
 * - 下拉：数据验证引用隐藏「选项」工作表，支持用户在字典中自定义扩展
 */

export type StyledColType = 'text' | 'center' | 'money' | 'qty' | 'pct' | 'int';

export interface StyledColumn {
  header: string;
  key: string;
  /** 需求文档中的像素宽度，导出时换算为 Excel 列宽 */
  width?: number;
  type?: StyledColType;
}

export interface StyledTableOptions {
  sheetName: string;
  /** 第二行表格标题，如「物资进出场台账（滨江商务中心项目）」 */
  title: string;
  /** 品牌行文字，默认中建标准抬头 */
  brand?: string;
  columns: StyledColumn[];
  rows: Record<string, any>[];
  /** 需要做 SUBTOTAL(109) 汇总的列 key */
  totalsKeys?: string[];
  totalsLabel?: string;
  /** 下拉数据验证：列 key → 选项列表 */
  dropdowns?: Record<string, string[]>;
  /** 表头采用「左列中建 logo 块 + 右侧两行文字」布局（默认 false 为整行品牌行） */
  logoColumn?: boolean;
}

const NUMFMT: Record<string, string> = {
  money: '#,##0.00',
  qty: '0.0000',
  pct: '0.00%',
  int: '0',
};

const thin: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FF000000' } },
};

const colLetter = (n: number): string => {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

@Injectable()
export class StyledExcelService {
  /** 生成带中建样式的表格，返回 xlsx Buffer */
  async exportTable(opts: StyledTableOptions): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(opts.sheetName, {
      views: [{ state: 'frozen', ySplit: 3 }],
    });
    const colCount = opts.columns.length;

    // ---- 第 1~2 行：表头块 ----
    if (opts.logoColumn) {
      // 左列 logo 块：上=中建蓝方块（白字），下=「中建」书法字；右侧两行分别为品牌行与标题行
      const logoTop = ws.getCell(1, 1);
      logoTop.value = '中国建筑';
      logoTop.font = { bold: true, size: 8, color: { argb: 'FFFFFFFF' }, name: '微软雅黑' };
      logoTop.alignment = { horizontal: 'center', vertical: 'middle' };
      logoTop.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF005BAC' } };
      logoTop.border = thin;
      const logoBottom = ws.getCell(2, 1);
      logoBottom.value = '中建';
      logoBottom.font = { bold: true, size: 22, name: '华文行楷' };
      logoBottom.alignment = { horizontal: 'center', vertical: 'middle' };
      logoBottom.border = thin;

      ws.mergeCells(1, 2, 1, Math.max(colCount, 4));
      const brandCell = ws.getCell(1, 2);
      brandCell.value = opts.brand || '中国建筑土木建设有限公司物资管理表格';
      brandCell.font = { size: 10, name: '微软雅黑' };
      brandCell.alignment = { horizontal: 'center', vertical: 'middle' };
      brandCell.border = thin;

      ws.mergeCells(2, 2, 2, Math.max(colCount, 4));
      const titleCell = ws.getCell(2, 2);
      titleCell.value = opts.title;
      titleCell.font = { bold: true, size: 14, name: '微软雅黑' };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
      titleCell.border = thin;
      ws.getRow(1).height = 22;
      ws.getRow(2).height = 34;
    } else {
      // 整行品牌行
      ws.mergeCells(1, 1, 1, Math.max(colCount, 4));
      const brandCell = ws.getCell(1, 1);
      brandCell.value = `${opts.brand || '〖中国建筑〗中国建筑土木建设有限公司物资管理表格'}`;
      brandCell.font = { bold: true, size: 14, name: '微软雅黑' };
      brandCell.alignment = { horizontal: 'left', vertical: 'middle' };
      ws.getRow(1).height = 26;

      // ---- 第 2 行：表格标题 ----
      ws.mergeCells(2, 1, 2, Math.max(colCount, 4));
      const titleCell = ws.getCell(2, 1);
      titleCell.value = opts.title;
      titleCell.font = { bold: true, size: 13, name: '微软雅黑' };
      titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(2).height = 24;
    }

    // ---- 第 3 行：表头 ----
    const headerRow = ws.getRow(3);
    opts.columns.forEach((c, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true, size: 11, name: '微软雅黑' };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
      cell.border = thin;
      ws.getColumn(i + 1).width = Math.max(6, Math.round((c.width || 100) / 7));
    });
    headerRow.height = 24;

    // ---- 数据行 ----
    const dataStart = 4;
    opts.rows.forEach((r, ri) => {
      const row = ws.getRow(dataStart + ri);
      opts.columns.forEach((c, ci) => {
        const cell = row.getCell(ci + 1);
        const raw = r[c.key];
        const isNum = c.type === 'money' || c.type === 'qty' || c.type === 'pct' || c.type === 'int';
        if (raw === null || raw === undefined || raw === '') {
          cell.value = null; // 空值显示为空白
        } else if (isNum) {
          const n = Number(raw);
          cell.value = Number.isFinite(n) ? n : null;
          cell.numFmt = NUMFMT[c.type as string];
        } else {
          cell.value = String(raw);
        }
        cell.font = { size: 10.5, name: '微软雅黑' };
        cell.border = thin;
        const align =
          isNum ? 'right'
          : c.type === 'center' ? 'center'
          : 'left';
        cell.alignment = { horizontal: align, vertical: 'middle' };
      });
    });
    const dataEnd = dataStart + opts.rows.length - 1;

    // ---- 合计行：SUBTOTAL(109) 支持筛选汇总 ----
    if (opts.totalsKeys?.length) {
      const totalRow = ws.getRow(Math.max(dataEnd, 3) + 1);
      opts.columns.forEach((c, ci) => {
        const cell = totalRow.getCell(ci + 1);
        cell.border = thin;
        cell.font = { bold: true, size: 10.5, name: '微软雅黑' };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };
        cell.alignment = { horizontal: c.type === 'money' || c.type === 'qty' ? 'right' : 'center', vertical: 'middle' };
        if (ci === 0) {
          cell.value = opts.totalsLabel || '汇总';
        } else if (opts.totalsKeys.includes(c.key) && opts.rows.length > 0) {
          const L = colLetter(ci + 1);
          cell.value = { formula: `SUBTOTAL(109,${L}${dataStart}:${L}${dataEnd})` };
          if (NUMFMT[c.type as string]) cell.numFmt = NUMFMT[c.type as string];
        }
      });
    }

    // ---- 下拉数据验证（写入隐藏「选项」表，支持自定义扩展） ----
    if (opts.dropdowns && Object.keys(opts.dropdowns).length) {
      const optWs = wb.addWorksheet('选项', { state: 'hidden' });
      const keys = Object.keys(opts.dropdowns);
      keys.forEach((k, ki) => {
        const col = optWs.getColumn(ki + 1);
        col.values = [k, ...opts.dropdowns![k]];
      });
      keys.forEach((k, ki) => {
        const ci = opts.columns.findIndex((c) => c.key === k);
        if (ci < 0) return;
        const L = colLetter(ki + 1);
        const end = opts.dropdowns![k].length + 1;
        const target = `${colLetter(ci + 1)}${dataStart}:${colLetter(ci + 1)}${Math.max(dataEnd, dataStart)}`;
        for (let r = dataStart; r <= Math.max(dataEnd, dataStart); r++) {
          ws.getCell(r, ci + 1).dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: [`选项!$${L}$2:$${L}$${end}`],
          };
        }
      });
    }

    // ---- 打印设置：A4 横向、一页宽、标题行重复 ----
    ws.pageSetup = {
      paperSize: 9, // A4
      orientation: 'landscape',
      horizontalCentered: true,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '1:3',
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    };

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  /** 合规性检查表等非表格布局的通用入口：自由定制回调 */
  async withWorkbook(fn: (wb: ExcelJS.Workbook) => Promise<void>): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    await fn(wb);
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }
}

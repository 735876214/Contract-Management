import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { localDayKey } from '../utils/helpers';

/**
 * 通用「下载填写模板」服务
 *
 * 模板结构（固定，导入端按此解析）：
 * - 第 1 行：表头（中文列名，必填列带 * 前缀）
 * - 第 2 行：示例数据行（仅作格式参考，导入时自动忽略，不入库）
 * - 第 3 行起：数据填写区（预设数据验证，共 5000 行可用）
 * - 隐藏「选项」表：下拉字段的数据源
 * - 「填写说明」表：字段格式与业务规则说明
 */

export type TplColType = 'text' | 'int' | 'number' | 'money' | 'qty' | 'pct' | 'date' | 'select' | 'cascader';

export interface TemplateColumn {
  /** 中文列名（不带 *，必填列服务端自动添加 * 前缀） */
  label: string;
  key: string;
  required?: boolean;
  type?: TplColType;
  width?: number;
  /** 示例值（第二行展示，必须符合业务规则） */
  example?: any;
  /** type=select 时的下拉选项（调用方从字典表读取后传入） */
  options?: string[];
  /**
   * type=cascader 时的级联数据源：键 = 父级选项文本，值 = 该父级下的子选项列表。
   * 生成「选项」表时按父级列建命名区域，子级列数据验证用 `INDIRECT("前缀_" & 父级单元格)` 联动。
   * ⚠️ 父级选项文本会经 `sanitizeDefinedName()` 处理（空白/特殊字符转 `_`），Excel 命名区域只允许合法字符。
   */
  cascade?: Record<string, string[]>;
  /** 级联的父级列 key（type=cascader 时必填） */
  cascadeFrom?: string;
  /** 级联下拉的前缀（命名区域前缀；缺省取本列 key） */
  cascadePrefix?: string;
  /** 填写说明（展示在「填写说明」表） */
  desc?: string;
}

export interface TemplateSpec {
  /** 模块名称，如「合同物资清单」；用于标题与文件名 */
  moduleName: string;
  sheetName?: string;
  columns: TemplateColumn[];
  /** 附加填写说明（整段文字） */
  extraNotes?: string[];
}

const NUMFMT: Record<string, string> = {
  int: '0',
  number: '0.0000',
  money: '#,##0.00',
  qty: '0.0000',
  pct: '0.00"%"',
};

const thin: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FF000000' } },
};

export const colLetter = (n: number): string => {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/** 数据填写区行数（含第 3 行起） */
export const TEMPLATE_MAX_ROWS = 5000;

/**
 * 把选项文本转成合法的 Excel 定义名称片段：非法字符（空格、`-`、`.` 等）替换为 `_`。
 * 父子两列用同一函数处理，保证 `INDIRECT("前缀_" & 父级单元格)` 能命中命名区域。
 */
export const sanitizeDefinedName = (s: string): string =>
  String(s ?? '').replace(/[^\p{L}\p{N}_]/gu, '_');

/** 级联下拉的命名区域名：`<前缀>_<父级选项的合法化文本>` */
export const cascadeRangeName = (prefix: string, parentValue: string): string =>
  `${sanitizeDefinedName(prefix)}_${sanitizeDefinedName(parentValue)}`;

@Injectable()
export class ImportTemplateService {
  /** 生成空白填写模板，返回 xlsx Buffer 与文件名 */
  async buildTemplate(spec: TemplateSpec): Promise<{ buffer: Buffer; filename: string }> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(spec.sheetName || '数据');

    // ---- 第 1 行：表头 ----
    spec.columns.forEach((c, i) => {
      const cell = ws.getRow(1).getCell(i + 1);
      cell.value = `${c.required ? '*' : ''}${c.label}`;
      cell.font = { bold: true, size: 11, name: '微软雅黑' };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
      cell.border = thin;
      ws.getColumn(i + 1).width = Math.max(8, c.width || Math.max(10, c.label.length * 2.5));
    });
    ws.getRow(1).height = 22;
    ws.views = [{ state: 'frozen', ySplit: 2 }];

    // ---- 第 2 行：示例数据行（灰色斜体，导入时自动忽略） ----
    const isNumType = (t?: TplColType) => !!t && ['int', 'number', 'money', 'qty', 'pct'].includes(t);
    spec.columns.forEach((c, i) => {
      const cell = ws.getRow(2).getCell(i + 1);
      const raw = c.example;
      if (raw !== undefined && raw !== null && raw !== '') {
        cell.value = isNumType(c.type) ? Number(raw) : String(raw);
        if (NUMFMT[c.type as string] && typeof cell.value === 'number') cell.numFmt = NUMFMT[c.type as string];
      }
      cell.font = { italic: true, size: 10, color: { argb: 'FF808080' }, name: '微软雅黑' };
      cell.border = thin;
      cell.alignment = { vertical: 'middle' };
    });

    // ---- 数据验证（第 3 行起） ----
    const dataStart = 3;
    const dataEnd = dataStart + TEMPLATE_MAX_ROWS - 1;
    const selects = spec.columns.filter((c) => c.type === 'select' && c.options?.length);
    const cascaders = spec.columns.filter((c) => c.type === 'cascader' && c.cascade && c.cascadeFrom);
    if (selects.length || cascaders.length) {
      const optWs = wb.addWorksheet('选项', { state: 'hidden' });

      // 普通下拉：每列一段
      selects.forEach((c, ki) => {
        optWs.getColumn(ki + 1).values = [c.label, ...c.options!];
      });
      selects.forEach((c, ki) => {
        const ci = spec.columns.indexOf(c);
        const L = colLetter(ki + 1);
        const end = c.options!.length + 1;
        for (let r = dataStart; r <= dataEnd; r++) {
          ws.getCell(r, ci + 1).dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: [`选项!$${L}$2:$${L}$${end}`],
            showErrorMessage: true,
            errorTitle: '输入无效',
            error: `请从下拉列表中选择「${c.label}」`,
          };
        }
      });

      // 级联下拉：子级选项按父级分组排在选项表后续列，每组注册命名区域；
      // 子级列数据验证 = INDIRECT("<前缀>_" & 父级单元格文本)，随父级联动（2026-10-18 物资一二级分类）。
      let cascadeCol = selects.length;
      const parentColIndex = new Map<string, number>();
      spec.columns.forEach((c, i) => parentColIndex.set(c.key, i));
      for (const c of cascaders) {
        const prefix = c.cascadePrefix || c.key;
        const parentCi = parentColIndex.get(c.cascadeFrom!);
        if (parentCi === undefined) continue;
        const parentLetter = colLetter(parentCi + 1);
        for (const [parent, children] of Object.entries(c.cascade!)) {
          if (!children?.length) continue;
          cascadeCol += 1;
          const L = colLetter(cascadeCol);
          optWs.getColumn(cascadeCol).values = [`${c.label}（${parent}）`, ...children];
          // 命名区域含中文是合法的（Excel 允许），写入与读回都经 ExcelJS 处理
          wb.definedNames.add(`选项!$${L}$2:$${L}$${children.length + 1}`, cascadeRangeName(prefix, parent));
        }
        const selfCi = spec.columns.indexOf(c);
        for (let r = dataStart; r <= dataEnd; r++) {
          ws.getCell(r, selfCi + 1).dataValidation = {
            type: 'list',
            allowBlank: true,
            // 父级空白时 INDIRECT 解析到不存在的名称 → Excel 显示空下拉（allowBlank 放行留空）
            formulae: [`INDIRECT("${cascadeRangeName(prefix, '')}"&SUBSTITUTE(${parentLetter}${r}," ","_"))`],
            showErrorMessage: true,
            errorTitle: '输入无效',
            error: `请先选择「${spec.columns[parentCi].label}」，再从下拉列表中选择「${c.label}」`,
          };
        }
      }
    }
    for (const c of spec.columns) {
      const ci = spec.columns.indexOf(c);
      for (let r = dataStart; r <= dataEnd; r++) {
        const cell = ws.getCell(r, ci + 1);
        if (c.type === 'date') {
          cell.dataValidation = {
            type: 'date',
            operator: 'between',
            allowBlank: true,
            formulae: [localDayKey(new Date(2000, 0, 1)), localDayKey(new Date(2099, 11, 31))],
            showErrorMessage: true,
            errorTitle: '日期无效',
            error: '请填写有效日期，格式 YYYY-MM-DD',
          };
          cell.numFmt = 'yyyy-mm-dd';
        } else if (['number', 'money', 'qty', 'pct', 'int'].includes(c.type || 'text')) {
          cell.dataValidation = {
            type: 'decimal',
            operator: 'greaterThanOrEqual',
            allowBlank: true,
            formulae: [0],
            showErrorMessage: true,
            errorTitle: '数字无效',
            error: '请填写不小于 0 的有效数字',
          };
          if (NUMFMT[c.type as string]) cell.numFmt = NUMFMT[c.type as string];
        } else {
          // 文本列（含下拉/级联列）整列设为文本格式（第 22 轮审计 P2-7）：
          // 18 位身份证、19 位银行账号若按数字存入，Excel 只保留 15 位有效数字，写入时已经不是原值。
          cell.numFmt = '@';
        }
      }
    }

    // ---- 填写说明表 ----
    const helpWs = wb.addWorksheet('填写说明');
    helpWs.getColumn(1).width = 110;
    const notes: string[] = [
      `【${spec.moduleName}】填写模板`,
      '',
      '1. 第 1 行为表头（* 开头为必填列），请勿修改表头结构与顺序；',
      '2. 第 2 行为示例数据行，仅作填写格式参考，导入时自动忽略，不会写入数据库；',
      '3. 请从第 3 行开始填写数据，单次导入最多 5000 行；',
      '4. 下拉列请从下拉列表中选择（支持在系统字典中扩展选项）；',
      '5. 日期列格式为 YYYY-MM-DD（如 2026-09-09）；数字列请填写有效数字；',
      '6. 导入时默认为新增数据，不覆盖已有数据；全部行校验通过后方可入库。',
      '',
      '各列说明：',
    ];
    spec.columns.forEach((c) => {
      const parts = [`${c.required ? '*' : ''}${c.label}`];
      if (c.desc) parts.push(c.desc);
      else if (c.type === 'select') parts.push(`下拉选择：${(c.options || []).slice(0, 8).join(' / ')}${(c.options || []).length > 8 ? ' 等' : ''}`);
      else if (c.type === 'cascader') parts.push(`级联下拉：先选「${spec.columns.find((x) => x.key === c.cascadeFrom)?.label || c.cascadeFrom}」，本列选项随父级联动`);
      else if (c.type === 'date') parts.push('日期，格式 YYYY-MM-DD');
      notes.push(`    ${parts.join(' —— ')}`);
    });
    (spec.extraNotes || []).forEach((n) => notes.push('', n));
    notes.forEach((n, i) => {
      const cell = helpWs.getRow(i + 1).getCell(1);
      cell.value = n;
      if (i === 0) cell.font = { bold: true, size: 13, name: '微软雅黑' };
    });

    // 打印设置
    ws.pageSetup = {
      paperSize: 9,
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '1:1',
    };

    const buf = await wb.xlsx.writeBuffer();
    const date = new Date();
    const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
    return { buffer: Buffer.from(buf), filename: `【${spec.moduleName}】填写模板_${ymd}.xlsx` };
  }
}

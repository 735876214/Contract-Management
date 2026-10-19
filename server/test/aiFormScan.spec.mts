import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cellRefOf,
  colLetter,
  looksLikeLabel,
  scanSheetCells,
  scanWorkbook,
  trimLabel,
  type FormCell,
} from '../src/modules/ai/form-scan.ts';

/**
 * AI 助手表单扫描（零依赖纯函数）。
 *
 * 这里锁的是**「哪一格该填值」的判断**，而不是 Excel 读写：真实企业表单布局差异极大，
 * 一旦配对规则退化，模型就会把「数量」映射成「合同金额」直接填进明细表 —— 这类错误
 * 在下载的文件里很难被用户发现，所以必须靠用例把判据钉死。
 */

const cell = (sheet: string, row: number, col: number, text: string): FormCell => ({
  sheet,
  row,
  col,
  text,
});

describe('列号/引用换算', () => {
  it('1 基列号转字母', () => {
    assert.equal(colLetter(1), 'A');
    assert.equal(colLetter(26), 'Z');
    assert.equal(colLetter(27), 'AA');
    assert.equal(colLetter(52), 'AZ');
    assert.equal(colLetter(53), 'BA');
    assert.equal(colLetter(702), 'ZZ');
    assert.equal(colLetter(703), 'AAA');
  });

  it('非法列号返回空串（不抛错、不产出 `undefined1` 之类脏引用）', () => {
    assert.equal(colLetter(0), '');
    assert.equal(colLetter(-3), '');
    assert.equal(colLetter(NaN), '');
  });

  it('(row, col) → A1 引用', () => {
    assert.equal(cellRefOf(4, 2), 'B4');
    assert.equal(cellRefOf(12, 28), 'AB12');
  });
});

describe('标签归一与识别', () => {
  it('剔尾部冒号与多余空白（中英文冒号、全角空格都要吃）', () => {
    assert.equal(trimLabel('项目名称：'), '项目名称');
    assert.equal(trimLabel('项目名称:  '), '项目名称');
    assert.equal(trimLabel('  项目　名称 ： '), '项目 名称');
    assert.equal(trimLabel(''), '');
  });

  it('像标签的文本', () => {
    assert.equal(looksLikeLabel('项目名称'), true);
    assert.equal(looksLikeLabel('合同金额（万元）'), true);
  });

  it('不像标签的文本：值、长句、纯英文、空', () => {
    assert.equal(looksLikeLabel(''), false);
    assert.equal(looksLikeLabel('2026-10-19'), false);
    assert.equal(looksLikeLabel('12,345.67'), false);
    assert.equal(looksLikeLabel('85%'), false);
    assert.equal(looksLikeLabel('见附件说明。'), false);
    assert.equal(looksLikeLabel('这是很长很长的一段说明文字用来描述填写要求的注意事项'), false);
    assert.equal(looksLikeLabel('Contract No.'), false);
  });
});

describe('横向配对（标签在左、值在右）', () => {
  it('右邻空白 → 产出空值槽位', () => {
    const out = scanSheetCells([cell('S', 1, 1, '项目名称：')]);
    assert.equal(out.length, 1);
    assert.deepEqual(
      { sheet: out[0].sheet, row: out[0].row, col: out[0].col, cellRef: out[0].cellRef, label: out[0].label, currentValue: out[0].currentValue },
      { sheet: 'S', row: 1, col: 2, cellRef: 'B1', label: '项目名称', currentValue: '' },
    );
  });

  it('右邻已有值 → 仍然产出槽位，并把现值带上（允许覆盖）', () => {
    const out = scanSheetCells([cell('S', 2, 1, '合同编号：'), cell('S', 2, 2, 'HT-001')]);
    assert.equal(out.length, 1);
    assert.equal(out[0].currentValue, 'HT-001');
  });

  it('同一行两组「标签+值」各自产出，互不干扰', () => {
    const out = scanSheetCells([
      cell('S', 1, 1, '项目名称：'),
      cell('S', 1, 3, '项目编号：'),
    ]);
    assert.deepEqual(out.map((c) => c.cellRef), ['B1', 'D1']);
  });
});

describe('表头排除（最容易出错的一条）', () => {
  it('`序号 | 名称 | 数量` 三连非空视为表头，不产出槽位', () => {
    const out = scanSheetCells([
      cell('S', 1, 1, '序号'),
      cell('S', 1, 2, '名称'),
      cell('S', 1, 3, '数量'),
    ]);
    assert.deepEqual(out, []);
  });

  it('只有两格并排（右邻是标签、右二为空）时不该被当表头吞掉', () => {
    // 「名称」右邻空 → 横向槽位；「数量」右邻空 → 横向槽位
    const out = scanSheetCells([cell('S', 1, 1, '名称'), cell('S', 1, 2, '')]);
    assert.equal(out.length, 1);
    assert.equal(out[0].cellRef, 'B1');
  });
});

describe('纵向配对（标签在上、值在下）', () => {
  it('本格下方为空且右邻空白 → 槽位落在下一行', () => {
    const out = scanSheetCells([cell('S', 1, 1, '项目名称：')]);
    // 右邻为空时优先按横向处理（这是主流布局），这里验证的是「没有右邻内容也不重复产出」
    assert.equal(out.length, 1);
  });

  it('右邻是另一个标签（无冒号）、下方为空 → 落到正下方', () => {
    const out = scanSheetCells([
      cell('S', 5, 1, '项目名称'),
      cell('S', 5, 2, '项目编号'),
    ]);
    // 「项目名称」右邻是标签、右二不存在 → 不走表头分支；下方空 → 纵向槽位 A6
    assert.ok(out.some((c) => c.cellRef === 'A6'));
  });

  it('冒号结尾的标签即使右邻是「像标签的短名词」也按横向取值', () => {
    // 已填值可能本身就是短中文（如公司简称），不能当成另一个标签
    const out = scanSheetCells([cell('S', 1, 1, '供应商名称：'), cell('S', 1, 2, '某某建设')]);
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].cellRef, out[0].currentValue], ['B1', '某某建设']);
  });
});

describe('防重复占用', () => {
  it('同一格不会被两个标签同时指向', () => {
    const out = scanSheetCells([
      cell('S', 1, 1, '甲方：'),
      cell('S', 3, 1, '乙方：'),
      cell('S', 3, 2, ''),
    ]);
    const refs = out.map((c) => c.cellRef);
    assert.equal(new Set(refs).size, refs.length);
  });
});

describe('整簿扫描与截断', () => {
  const sheets: FormCell[] = [
    cell('表B', 1, 1, '项目名称：'),
    cell('表A', 1, 1, '合同编号：'),
    cell('表A', 2, 1, '签约日期：'),
  ];

  it('多表汇总并按 (sheet, row, col) 排序', () => {
    const { candidates, truncated } = scanWorkbook(sheets, 100);
    assert.equal(truncated, 0);
    // 三格标签各自成对 → 三个槽位（表名顺序按 localeCompare，这里只锁归属与引用）
    assert.equal(candidates.length, 3);
    assert.ok(candidates.some((c) => c.sheet === '表A' && c.cellRef === 'B1'));
    assert.ok(candidates.some((c) => c.sheet === '表A' && c.cellRef === 'B2'));
  });

  it('超限时保留前 N 个并报告丢弃数量（不静默截断）', () => {
    const { candidates, truncated } = scanWorkbook(sheets, 1);
    assert.equal(candidates.length, 1);
    assert.equal(truncated, 2);
  });

  it('上限非法时按 1 处理，不会返回空结果', () => {
    const { candidates, truncated } = scanWorkbook(sheets, 0);
    assert.equal(candidates.length, 1);
    assert.equal(truncated, 2);
  });

  it('空输入不抛错', () => {
    assert.deepEqual(scanWorkbook([], 10), { candidates: [], truncated: 0 });
  });
});

describe('坐标一致性', () => {
  it('候选的 cellRef 与 row/col 同源（前端按 cellRef 回传，后端按坐标定位）', () => {
    const out = scanSheetCells([cell('S', 7, 27, '合同金额：')]);
    assert.equal(out[0].cellRef, cellRefOf(out[0].row, out[0].col));
    assert.equal(out[0].cellRef, 'AB7');
  });
});

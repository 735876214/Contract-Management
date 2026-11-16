import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { replaceCellText, renderTemplateExcel } from '../src/modules/doc-template/doc-excel.ts';

/**
 * 单据 Excel 渲染引擎（`doc-excel.ts`）单测。
 *
 * 业务口径 2026-10-17：五类单据模板改为上传 xlsx、生成路径 Word → Excel；
 * 2026-10-18 起表格占位符（如 `{{结算明细表}}`）在**整格独占**时做**真正的行展开**
 * （插行、复制样式/行高、合并区域下移），与文字混排时才退回多行文本兜底。
 */

/** 模板构造 → 渲染 → 读回第一个 sheet（全程走真实 xlsx 序列化，能发现合并/样式的落盘问题） */
async function renderSheet(
  build: (ws: ExcelJS.Worksheet) => void,
  opts: { values?: Record<string, string>; tables?: Record<string, string[][]> } = {},
): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  build(ws);
  const tpl = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

  const out = await renderTemplateExcel({
    template: tpl,
    values: opts.values ?? {},
    tables: opts.tables ?? {},
  });

  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(out as any);
  return readBack.worksheets[0];
}

describe('单据 Excel 渲染：单值占位符', () => {
  it('替换单值与混排占位符，未取到值的原样保留', () => {
    assert.equal(
      replaceCellText('编号：{{单据编号}} / 日期：{{日期}}', { 单据编号: 'P-001' }),
      '编号：P-001 / 日期：{{日期}}',
    );
  });

  it('表格占位符与文字混排时退回多行文本（列用制表符分列）', () => {
    const text = replaceCellText('合计：{{明细}}', {}, { 明细: [['月份', '金额'], ['9月', '100']] });
    assert.equal(text, '合计：月份\t金额\n9月\t100');
  });
});

describe('单据 Excel 渲染：表格占位符行展开', () => {
  it('按二维数组写出相邻单元格，并插入行、下移下方内容', async () => {
    const ws = await renderSheet(
      (s) => {
        s.getCell('A1').value = '编号：{{单据编号}}';
        s.getCell('A3').value = '{{明细}}';
        s.getCell('A4').value = '落款';
      },
      {
        values: { 单据编号: 'P-001' },
        tables: { 明细: [['月份', '金额'], ['9月', '100'], ['10月', '200']] },
      },
    );

    assert.equal(ws.getCell('A1').value, '编号：P-001');
    // 首行（表头）落在占位符单元格及其右侧
    assert.equal(ws.getCell('A3').value, '月份');
    assert.equal(ws.getCell('B3').value, '金额');
    assert.equal(ws.getCell('A4').value, '9月');
    assert.equal(ws.getCell('B4').value, '100');
    assert.equal(ws.getCell('A5').value, '10月');
    assert.equal(ws.getCell('B5').value, '200');
    // 占位符下方的原有内容被下移 2 行
    assert.equal(ws.getCell('A6').value, '落款');
  });

  it('新行复制占位符所在行的样式与行高', async () => {
    const ws = await renderSheet(
      (s) => {
        s.getCell('A3').value = '{{明细}}';
        s.getCell('B3').style = { font: { bold: true, size: 12 }, alignment: { horizontal: 'center' } };
        s.getRow(3).height = 28;
      },
      { tables: { 明细: [['a', 'b'], ['c', 'd']] } },
    );

    assert.equal(ws.getCell('B4').value, 'd');
    assert.equal(ws.getCell('B4').font?.bold, true);
    assert.equal(ws.getCell('B4').font?.size, 12);
    assert.equal(ws.getCell('B4').alignment?.horizontal, 'center');
    assert.equal(ws.getRow(4).height, 28);
  });

  it('下方合并单元格区域随插行整体下移（ExcelJS 本身不会移动）', async () => {
    const ws = await renderSheet(
      (s) => {
        s.mergeCells('A1:B1');
        s.getCell('A1').value = '标题';
        s.getCell('A3').value = '{{明细}}';
        s.getCell('A4').value = '落款';
        s.mergeCells('A5:B5');
      },
      { tables: { 明细: [['月份', '金额'], ['9月', '100'], ['10月', '200']] } },
    );

    assert.equal(ws.getCell('A6').value, '落款');
    const merges = (ws.model.merges || []).sort();
    assert.deepEqual(merges, ['A1:B1', 'A7:B7']);
  });

  it('空表清掉占位符、不插行、样式保留', async () => {
    const ws = await renderSheet(
      (s) => {
        s.getCell('A3').value = '{{明细}}';
        s.getCell('A3').font = { bold: true };
        s.getCell('A4').value = '落款';
      },
      { tables: { 明细: [] } },
    );

    assert.equal(ws.getCell('A3').value, null);
    assert.equal(ws.getCell('A3').font?.bold, true);
    assert.equal(ws.getCell('A4').value, '落款');
  });

  it('混排的表格占位符不展开，整格替换为多行文本并开自动换行', async () => {
    const ws = await renderSheet(
      (s) => {
        s.getCell('A3').value = '合计：{{明细}}';
        s.getCell('A4').value = '落款';
      },
      { tables: { 明细: [['月份', '金额'], ['9月', '100']] } },
    );

    assert.equal(ws.getCell('A3').value, '合计：月份\t金额\n9月\t100');
    assert.equal(ws.getCell('A3').alignment?.wrapText, true);
    // 未插行：下方内容位置不变
    assert.equal(ws.getCell('A4').value, '落款');
  });
});

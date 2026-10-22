import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as ExcelJS from 'exceljs';
import { ExcelService } from '../src/common/services/excel.service.ts';
import { StyledExcelService } from '../src/common/services/styled-excel.service.ts';

/**
 * Excel 解析的口径单测（`common/services/excel.service.ts`）。
 *
 * 背景（2026-10-20 审计）：`export()` 产出的文件是「logo 表头占 1~2 行、列表头在第 3 行、
 * 数据从第 4 行起」，而 `parse()` 固定从第 1 行取表头。字典的「导出 → 原样导入」因此
 * 把品牌行当表头，每行都取不到「字典项编码」，最终静默返回 `created: 0`、不报任何错。
 *
 * 这里锁三件事：
 * 1. `detectHeaderRow()` 能在两种布局（填写模板 / 导出文件）下找到表头行；
 * 2. `parse(..., headerRowNo)` 按探测到的行号取表头、且不把表头行本身当数据；
 * 3. 导出 → 探测 → 解析 的**闭环**（真正要防的回归）。
 */

const columns = [
  { header: '字典项编码', key: 'itemCode', width: 20 },
  { header: '字典项名称', key: 'itemName', width: 24 },
];
const rows = [
  { itemCode: 'A01', itemName: '甲' },
  { itemCode: 'A02', itemName: '乙' },
];

const service = new ExcelService(new StyledExcelService());

/** 填写模板布局：第 1 行表头（必填列带 *），数据从第 2 行起 */
async function templateBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('字典项');
  ws.getRow(1).values = ['*字典项编码', '*字典项名称'];
  ws.addRow(['T01', '模板甲']);
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

describe('Excel 表头行探测', () => {
  it('导出文件（logo 占 1~2 行）识别出第 3 行为表头', async () => {
    const buf = await service.export(columns, rows, '字典项');
    assert.equal(await service.detectHeaderRow(buf, ['字典项编码', '字典项名称']), 3);
  });

  it('填写模板（表头在第 1 行、必填列带星号）识别出第 1 行', async () => {
    const buf = await templateBuffer();
    assert.equal(await service.detectHeaderRow(buf, ['字典项编码', '字典项名称']), 1);
  });

  it('列名对不上时回退第 1 行（不抛错，后续按空表处理）', async () => {
    const buf = await templateBuffer();
    assert.equal(await service.detectHeaderRow(buf, ['完全不存在的列']), 1);
  });
});

describe('Excel 解析', () => {
  it('默认按第 1 行取表头，且不把表头行当数据', async () => {
    const list = await service.parse(await templateBuffer());
    assert.deepEqual(list, [{ 字典项编码: 'T01', 字典项名称: '模板甲' }]);
  });

  it('按指定表头行解析导出文件，数据从表头下一行起', async () => {
    const buf = await service.export(columns, rows, '字典项');
    const list = await service.parse(buf, [], 3);
    assert.deepEqual(list, [
      { 字典项编码: 'A01', 字典项名称: '甲' },
      { 字典项编码: 'A02', 字典项名称: '乙' },
    ]);
  });

  it('导出 → 探测 → 解析 闭环：导出的文件能原样导回', async () => {
    const buf = await service.export(columns, rows, '字典项');
    const headerRowNo = await service.detectHeaderRow(buf, ['字典项编码', '字典项名称']);
    const list = await service.parse(buf, [], headerRowNo);
    assert.equal(list.length, rows.length);
    assert.equal(list[0]['字典项编码'], 'A01');
    assert.ok(list.every((r: any) => r['字典项编码'] && r['字典项名称']));
  });

  it('导出文件不传表头行号也能解析（表头自动探测，第 22 轮审计 P1-2）', async () => {
    const buf = await service.export(columns, rows, '字典项');
    const list = await service.parse(buf);
    // 修复前：logo/品牌行被当表头 → 每行都取不到「字典项编码」，导入端静默 0 行
    assert.equal(list.length, rows.length);
    assert.deepEqual(list[0], { 字典项编码: 'A01', 字典项名称: '甲' });
  });

  it('表头中间缺一列时后面的列不会整体左移（第 22 轮审计 P1-3）', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('数据');
    ws.getRow(1).values = ['合同编号', null, '金额']; // B 列整列没有表头
    ws.addRow(['HT-1', '备注文字', 1234.5]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const list = await service.parse(buf);
    // 修复前 `eachCell()` 只收到两个表头：'备注文字' 会被塞进「金额」，真正的金额丢掉
    assert.deepEqual(list[0], { 合同编号: 'HT-1', 金额: 1234.5 });
  });

  it('超过 15 位的长数字直接报错，不静默写入丢精度的值（第 22 轮审计 P2-7）', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('数据');
    ws.getRow(1).values = ['银行账号'];
    ws.addRow([31001234567890123456]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    await assert.rejects(() => service.parse(buf), /长数字|科学计数法/);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { itemsTotalWithTax, materialRowsFromItems, numOf } from '../src/modules/ai/register-materials.ts';

test('numOf：千分位、货币符号、百分号都能吃', () => {
  assert.equal(numOf('¥1,234.50'), 1234.5);
  assert.equal(numOf('1234.5元'), 1234.5);
  assert.equal(numOf('13%'), 13);
  assert.equal(numOf(' 12 '), 12);
  assert.equal(numOf(8.8), 8.8);
});

test('numOf：取不到时返回 null，不返回 0', () => {
  assert.equal(numOf(''), null);
  assert.equal(numOf('无'), null);
  assert.equal(numOf(null), null);
  assert.equal(numOf(undefined), null);
  // NaN 也是 null——不能把 NaN 写进 Decimal 列
  assert.equal(numOf(Number.NaN), null);
});

test('materialRowsFromItems：接受 toItems() 的 unitPriceWithTax / amountWithTax 口径', () => {
  const { rows } = materialRowsFromItems(
    [{ name: '安全帽', spec: 'ABS 白色', unit: '顶', qty: 100, unitPriceWithTax: '12.5', amountWithTax: '1250' }],
    13,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '安全帽');
  assert.equal(rows[0].unit, '顶');
  assert.equal(rows[0].qty, 100);
  assert.equal(rows[0].priceWithTax, 12.5);
  assert.equal(rows[0].totalWithTax, 1250);
  assert.equal(rows[0].taxRatePct, 13);
  // 含税 12.5 / 1.13 = 11.0619...
  assert.equal(rows[0].priceBeforeTax, 11.0619);
});

test('materialRowsFromItems：合价缺失时用数量 × 单价补齐', () => {
  const { rows, filledTotal } = materialRowsFromItems([{ name: '下颏带', qty: 20, unitPriceWithTax: 3.5 }], 13);
  assert.equal(filledTotal, 1);
  assert.equal(rows[0].totalWithTax, 70);
});

test('materialRowsFromItems：缺名称与重复行被丢弃并计数', () => {
  const { rows, skipped } = materialRowsFromItems(
    [
      { name: '', amountWithTax: 99 },
      { name: '马甲', spec: 'M', amountWithTax: 10 },
      { name: '马甲', spec: 'M', amountWithTax: 10 },
      { name: '马甲', spec: 'L', amountWithTax: 12 },
    ],
    13,
  );
  assert.equal(rows.length, 2);
  assert.equal(skipped, 2);
  assert.deepEqual(
    rows.map((r) => r.spec),
    ['M', 'L'],
  );
  // 序号连续，不受丢弃影响
  assert.deepEqual(
    rows.map((r) => r.sortOrder),
    [1, 2],
  );
});

test('materialRowsFromItems：单位缺失兜底为「项」，税率未知时税前价留空', () => {
  const { rows } = materialRowsFromItems([{ name: '吸汗带', amountWithTax: 8 }], null);
  assert.equal(rows[0].unit, '项');
  assert.equal(rows[0].priceBeforeTax, null);
  assert.equal(rows[0].taxRatePct, null);
});

test('materialRowsFromItems：非数组输入不抛错', () => {
  const { rows, skipped } = materialRowsFromItems(undefined, 13);
  assert.equal(rows.length, 0);
  assert.equal(skipped, 0);
});

test('itemsTotalWithTax：按四位小数累加', () => {
  const rows = materialRowsFromItems(
    [
      { name: 'A', amountWithTax: 0.1 },
      { name: 'B', amountWithTax: 0.2 },
    ],
    13,
  ).rows;
  assert.equal(itemsTotalWithTax(rows), 0.3);
});

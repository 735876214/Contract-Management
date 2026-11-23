import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatAmount, formatMoney, formatNumber, formatPercent } from '../../web/src/utils/money.ts';

/**
 * 前端展示格式化的**单一实现**（`web/src/utils/money.ts`）。
 *
 * 起因（2026-11-22 质量审计）：20+ 个页面各写一份 `money()`，选项组合有 7 种，导致
 * 同一笔金额在「台账」是 `¥1,234.50`、在「成本盈亏」是 `1,234.00`、在「收入分析」是 `1,234`；
 * 而无参数的 `toLocaleString('zh-CN')` 会把 `1234.5600000000001` 原样印在页面上。
 * 本 spec 锁住三条口径：空值 ≠ 0、金额固定两位、数量不补零。
 */
describe('前端金额/数量展示格式化（utils/money）', () => {
  it('空值一律显示占位符，绝不兜成 0', () => {
    for (const v of [null, undefined, '', '   ', 'abc', NaN, Infinity]) {
      assert.equal(formatAmount(v), '-', `formatAmount(${String(v)})`);
      assert.equal(formatMoney(v), '-', `formatMoney(${String(v)})`);
      assert.equal(formatNumber(v), '-', `formatNumber(${String(v)})`);
    }
    // 显式 0 是真实的 0，不能被当成「未填」
    assert.equal(formatAmount(0), '0.00');
    assert.equal(formatMoney(0), '¥0.00');
    assert.equal(formatNumber(0), '0');
  });

  it('金额固定两位小数 + 千分位（同一金额在任何页面都同形）', () => {
    assert.equal(formatAmount(1234), '1,234.00');
    assert.equal(formatAmount('1234.5'), '1,234.50');
    assert.equal(formatAmount(1234567.005), '1,234,567.01');
    assert.equal(formatMoney(1234.5), '¥1,234.50');
    // 负数（退货/冲减）保留符号
    assert.equal(formatAmount(-1234.5), '-1,234.50');
    assert.equal(formatMoney(-0.5), '¥-0.50');
  });

  it('浮点尾数被吃掉（后端 Number(Decimal) 求和后的 1234.5600000000001）', () => {
    assert.equal(formatAmount(1234.5600000000001), '1,234.56');
    assert.equal(formatNumber(0.1 + 0.2), '0.3');
  });

  it('数量最多 N 位小数、不补零（1.5 吨不显示成 1.5000）', () => {
    assert.equal(formatNumber(1.5), '1.5');
    assert.equal(formatNumber(1.5, 4), '1.5');
    assert.equal(formatNumber(1.23456, 4), '1.2346');
    assert.equal(formatNumber(1234567, 2), '1,234,567');
    assert.equal(formatNumber(0.00004, 2), '0');
  });

  it('占位符可覆盖（HTML 表格里用空串、分析面板用长横线）', () => {
    assert.equal(formatNumber(null, 2, ''), '');
    assert.equal(formatAmount(null, 2, '—'), '—');
    assert.equal(formatMoney(undefined, 2, '—'), '—');
  });

  it('比率 0~1 → 百分数（含非法值）', () => {
    assert.equal(formatPercent(0.65), '65.00%');
    assert.equal(formatPercent(1), '100.00%');
    assert.equal(formatPercent(0), '0.00%');
    assert.equal(formatPercent(null), '-');
    assert.equal(formatPercent('abc'), '-');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportDate, pickDictCode } from '../src/common/utils/import-parse.ts';
import { isSafeFileUrl, checkFileUrl } from '../src/common/utils/safe-url.ts';
import { assertSettlementProgress, SETTLEMENT_STATUS } from '../src/constants/workflowGuards.ts';

/**
 * 第 8/9 轮审计新增的三个纯函数守卫：
 * ① 导入行的日期/字典解析不能静默写错值；
 * ② 附件地址必须过协议白名单（否则 `javascript:` 就是存储型 XSS）；
 * ③ 结算状态只能沿链路前进（回退必须走驳回）。
 */

describe('parseImportDate：导入日期解析', () => {
  it('标准写法与常见变体都能解析成同一天', () => {
    const expect = new Date(2026, 0, 31);
    for (const raw of ['2026-01-31', '2026/1/31', '2026.1.31', '2026年1月31日', '2026-01-31 12:30']) {
      const r = parseImportDate(raw, '开票日期');
      assert.equal(r.error, undefined, `${raw} 不应报错`);
      assert.deepEqual(r.date, expect, `${raw} 应解析为 2026-01-31`);
    }
  });

  it('空值/占位符返回 null 而不是 1970 或 Invalid Date', () => {
    for (const raw of [null, undefined, '', '   ', '-', '—']) {
      assert.deepEqual(parseImportDate(raw), { date: null });
    }
  });

  it('不存在的日期被识破（2026-02-30 不会被 Date 顺延成 3-2）', () => {
    const r = parseImportDate('2026-02-30', '签订日期');
    assert.equal(r.date, null);
    assert.match(String(r.error), /不是真实存在的日期/);
  });

  it('Excel 序列号按 1899-12-30 基准换算（45000 → 2023-03-15）', () => {
    const r = parseImportDate(45000, '开票日期');
    assert.equal(r.error, undefined);
    assert.equal(r.date?.getFullYear(), 2023);
    assert.equal(r.date?.getMonth(), 2);
    assert.equal(r.date?.getDate(), 15);
  });

  it('乱写的中文/超范围年份给出带列名的错误', () => {
    assert.match(String(parseImportDate('去年三月', '进场日期').error), /「进场日期」不是有效日期/);
    assert.match(String(parseImportDate('1899-01-01').error), /超出范围/);
  });
});

describe('pickDictCode：导入字典项', () => {
  const items = [
    { itemCode: 'PURCHASE', itemName: '采购合同' },
    { itemCode: 'yes', itemName: '是' },
  ];

  it('按名称或编码都能命中', () => {
    assert.equal(pickDictCode(items, '采购合同'), 'PURCHASE');
    assert.equal(pickDictCode(items, 'PURCHASE'), 'PURCHASE');
  });

  it('空单元格允许留空', () => {
    assert.equal(pickDictCode(items, ''), null);
    assert.equal(pickDictCode(items, null), null);
  });

  it('非空但没命中返回 null，由调用方报行级错误（不能静默写 NULL）', () => {
    assert.equal(pickDictCode(items, '采购合'), null);
  });
});

describe('附件地址的协议白名单', () => {
  it('站内路径与 http(s) 放行', () => {
    for (const url of ['/api/files/2026-10-abc.pdf', 'https://example.com/a.pdf', 'http://1.2.3.4/b.xlsx']) {
      assert.equal(isSafeFileUrl(url), true, url);
    }
  });

  it('javascript:/data:/协议相对地址一律拒绝', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:fetch("/api/auth/profile")', 'data:text/html,<script>1</script>', '//evil.example.com/x.pdf', 'vbscript:msgbox', 'file:///etc/passwd']) {
      assert.equal(isSafeFileUrl(url), false, url);
    }
  });

  it('checkFileUrl 区分「没填」「非法」「合法」', () => {
    assert.deepEqual(checkFileUrl(''), { url: null });
    assert.match(String(checkFileUrl('javascript:alert(1)', '第 1 个附件的地址').error), /只能填站内路径/);
    assert.deepEqual(checkFileUrl('/api/files/a.pdf'), { url: '/api/files/a.pdf' });
  });
});

describe('结算状态只能沿链路前进', () => {
  it('不变或前进都放行', () => {
    assert.doesNotThrow(() => assertSettlementProgress(SETTLEMENT_STATUS.DRAFT, SETTLEMENT_STATUS.PENDING));
    assert.doesNotThrow(() => assertSettlementProgress(SETTLEMENT_STATUS.PENDING, SETTLEMENT_STATUS.CONFIRMED));
    assert.doesNotThrow(() => assertSettlementProgress(SETTLEMENT_STATUS.DONE, SETTLEMENT_STATUS.DONE));
  });

  it('回退到草稿必须走驳回', () => {
    assert.throws(
      () => assertSettlementProgress(SETTLEMENT_STATUS.DONE, SETTLEMENT_STATUS.DRAFT),
      /不能把结算单直接改回「草稿」/,
    );
  });

  it('其他回退方向被拒并提示用驳回', () => {
    assert.throws(
      () => assertSettlementProgress(SETTLEMENT_STATUS.CONFIRMED, SETTLEMENT_STATUS.PENDING),
      /回退到/,
    );
  });

  it('未知状态直接判非法', () => {
    assert.throws(() => assertSettlementProgress(SETTLEMENT_STATUS.PENDING, 'NOT_A_STATUS'), /取值非法/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRANCH_ABBR_RE,
  normalizeBranchAbbr,
  formatFinalSettlementDocNumber,
} from '../src/modules/final-settlement/final-settlement-doc-number.ts';

/**
 * 总结算书编号纯函数（业务口径 2026-11-21）：
 * `<分公司简称>-<项目编号>-WZZJS-<结算年份>-<流水号>`。
 * 这些是导出时最容易出错的纯计算——跨年零点、流水号夹取、补零位数、前缀兜底。
 */
describe('总结算书编号 formatFinalSettlementDocNumber', () => {
  it('按口径拼出编号，流水号两位补零', () => {
    assert.equal(
      formatFinalSettlementDocNumber({ branchPrefix: 'TMHB', projectCode: 'BJWSZX', year: 2026, seq: 1 }),
      'TMHB-BJWSZX-WZZJS-2026-01',
    );
    assert.equal(
      formatFinalSettlementDocNumber({ branchPrefix: 'TMHB', projectCode: 'BJWSZX', year: 2026, seq: 9 }),
      'TMHB-BJWSZX-WZZJS-2026-09',
    );
  });

  it('流水号超过两位不截断', () => {
    assert.equal(
      formatFinalSettlementDocNumber({ branchPrefix: 'TMHB', projectCode: 'P', year: 2026, seq: 100 }),
      'TMHB-P-WZZJS-2026-100',
    );
  });

  it('流水号 <=0 / 非数 一律按 1（不出 "00"）', () => {
    assert.equal(formatFinalSettlementDocNumber({ branchPrefix: '', projectCode: 'P', year: 2026, seq: 0 }), 'TMHB-P-WZZJS-2026-01');
    assert.equal(formatFinalSettlementDocNumber({ branchPrefix: '', projectCode: 'P', year: 2026, seq: -5 }), 'TMHB-P-WZZJS-2026-01');
    assert.equal(
      formatFinalSettlementDocNumber({ branchPrefix: '', projectCode: 'P', year: 2026, seq: NaN }),
      'TMHB-P-WZZJS-2026-01',
    );
  });

  it('分公司简称为空兜底 TMHB，项目编号为空留空段', () => {
    assert.equal(formatFinalSettlementDocNumber({ branchPrefix: null, projectCode: null, year: 2026, seq: 2 }), 'TMHB--WZZJS-2026-02');
  });

  it('前缀与项目编号统一转大写并去空格', () => {
    assert.equal(
      formatFinalSettlementDocNumber({ branchPrefix: ' tmhb ', projectCode: ' bjwszx ', year: 2026, seq: 3 }),
      'TMHB-BJWSZX-WZZJS-2026-03',
    );
  });
});

describe('分公司简称归一与校验', () => {
  it('normalizeBranchAbbr 转大写去空格，空串归 null', () => {
    assert.equal(normalizeBranchAbbr(' tmhb '), 'TMHB');
    assert.equal(normalizeBranchAbbr(''), null);
    assert.equal(normalizeBranchAbbr(null), null);
    assert.equal(normalizeBranchAbbr(undefined), null);
  });

  it('BRANCH_ABBR_RE 只放行大写字母数字、最多 20 位', () => {
    assert.ok(BRANCH_ABBR_RE.test('TMHB'));
    assert.ok(BRANCH_ABBR_RE.test('A1'));
    assert.ok(!BRANCH_ABBR_RE.test('tmhb'), '小写应先归一，不直接通过');
    assert.ok(!BRANCH_ABBR_RE.test('TM-HB'));
    assert.ok(!BRANCH_ABBR_RE.test(''));
    assert.ok(!BRANCH_ABBR_RE.test('A'.repeat(21)));
    assert.ok(BRANCH_ABBR_RE.test('A'.repeat(20)));
  });
});

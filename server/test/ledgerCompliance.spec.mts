import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcLedgerCompliance,
  LEDGER_COMPLIANCE,
  LEDGER_EXEC_CONTRACT_TYPES,
} from '../src/modules/ledger/ledger-compliance.ts';

/**
 * 合同台账「合规性问题」判定单测（P3：金额/口径补测，见 TODO.md P3-2）。
 *
 * 该判定**不落库**（列表实时算），此前是 `ledger.service` 的私有方法、无法单测；
 * 现已抽到零依赖模块 `ledger-compliance.ts`。本测试锁定 4 条规则与优先级，
 * 尤其"执行类合同只看进场 vs 签订""进场等于节点不算问题"两组边界。
 */

const { OK, INCOMPLETE, ENTRY_BEFORE_BID, ENTRY_BEFORE_WIN, ENTRY_BEFORE_SIGN, ENTRY_BEFORE_SIGN_EXEC } =
  LEDGER_COMPLIANCE;

const D = (s: string) => new Date(`${s}T00:00:00`);

describe('台账合规判定 · 执行类合同（只看进场 vs 签订）', () => {
  it('执行类合同清单与字典编码一致（PURCHASE_EXEC / LEASE_EXEC）', () => {
    assert.deepEqual([...LEDGER_EXEC_CONTRACT_TYPES], ['PURCHASE_EXEC', 'LEASE_EXEC']);
  });

  it('未填进场日期 → 不判定（返回空串）', () => {
    assert.equal(calcLedgerCompliance('PURCHASE_EXEC', null, null, null, D('2026-01-01')), '');
    assert.equal(calcLedgerCompliance('LEASE_EXEC', null, D('2026-01-01'), D('2026-01-02'), D('2026-01-03')), '');
  });

  it('有进场但缺签订日期 → 时间数据不完整', () => {
    assert.equal(calcLedgerCompliance('PURCHASE_EXEC', D('2026-02-01'), null, null, null), INCOMPLETE);
  });

  it('进场早于签订 → 未签合同先进场；等于或晚于签订 → 无问题', () => {
    const sign = D('2026-03-01');
    assert.equal(calcLedgerCompliance('PURCHASE_EXEC', D('2026-02-28'), null, null, sign), ENTRY_BEFORE_SIGN_EXEC);
    assert.equal(calcLedgerCompliance('PURCHASE_EXEC', sign, null, null, sign), OK); // 同日不算问题
    assert.equal(calcLedgerCompliance('PURCHASE_EXEC', D('2026-03-02'), null, null, sign), OK);
  });

  it('执行类**不看**招标/定标：招标晚于进场也不报"未招标进场"', () => {
    // 进场 2026-02-01，招标 2026-02-10（晚于进场），签订 2026-01-20（早于进场）
    assert.equal(
      calcLedgerCompliance('LEASE_EXEC', D('2026-02-01'), D('2026-02-10'), D('2026-02-20'), D('2026-01-20')),
      OK,
    );
  });
});

describe('台账合规判定 · 非执行类合同（招标 → 定标 → 签订）', () => {
  it('缺进场日期，或三个节点日期全缺 → 时间数据不完整', () => {
    assert.equal(calcLedgerCompliance('PURCHASE', null, D('2026-01-01'), null, null), INCOMPLETE);
    assert.equal(calcLedgerCompliance('PURCHASE', D('2026-02-01'), null, null, null), INCOMPLETE);
    assert.equal(calcLedgerCompliance('', D('2026-02-01'), null, null, null), INCOMPLETE); // 类型缺失走非执行分支
  });

  it('进场早于招标 → 未招标进场（优先于定标/签订）', () => {
    assert.equal(
      calcLedgerCompliance('PURCHASE', D('2026-01-01'), D('2026-01-10'), D('2026-01-20'), D('2026-02-01')),
      ENTRY_BEFORE_BID,
    );
  });

  it('招标缺失时，进场早于定标 → 未定标进场', () => {
    assert.equal(calcLedgerCompliance('PURCHASE', D('2026-01-05'), null, D('2026-01-10'), null), ENTRY_BEFORE_WIN);
  });

  it('只有签订日期时，进场早于签订 → 未签合同进场', () => {
    assert.equal(calcLedgerCompliance('PURCHASE', D('2026-01-05'), null, null, D('2026-01-10')), ENTRY_BEFORE_SIGN);
    assert.equal(calcLedgerCompliance('PURCHASE', D('2026-01-10'), null, null, D('2026-01-10')), OK); // 同日不算
  });

  it('进场等于招标日不报问题（严格小于才报），继续看后续节点', () => {
    assert.equal(
      calcLedgerCompliance('PURCHASE', D('2026-01-10'), D('2026-01-10'), D('2026-01-05'), D('2026-01-01')),
      OK,
    );
  });

  it('节点日期为数据库空值 / 空串 / 非法串时视为缺失（不抛错）', () => {
    assert.equal(calcLedgerCompliance('PURCHASE', D('2026-01-05'), '', 'not-a-date', null), INCOMPLETE);
    assert.equal(calcLedgerCompliance('PURCHASE', D('2026-01-05'), '', '', D('2026-01-01')), OK);
  });

  it('接受前端传来的 "YYYY-MM-DD" 字符串日期', () => {
    assert.equal(calcLedgerCompliance('PURCHASE', '2026-01-05', '2026-01-10', null, null), ENTRY_BEFORE_BID);
  });
});

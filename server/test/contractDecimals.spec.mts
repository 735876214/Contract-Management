import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContractDecimals } from '../src/modules/contract/contract-decimals.ts';

/**
 * 合同行 **Decimal → number** 的单一实现（2026-11-24 收口）。
 *
 * 背景：`/contracts` 原本把 Prisma `Decimal` 原样下发，JSON 里是 **string**（`"500000"`），
 * 而台账 `/ledger/contracts` 过 `num()` 给 number —— 同一系统同一类字段两种类型，
 * 前端每个用合同金额的地方都得 `Number()`，漏一处就是字符串相加式的隐性 bug。
 *
 * 三条口径锁在这里：
 * 1. **null 保持 null**（未填 ≠ 0），不能被 num() 兜成 0；
 * 2. **只转已知金额/比率列**（`amount/taxRatePct/changeAmount/changeQty/monthlyRate/interestCapRatio`
 *    + ext 的两个比例），不动其它字段；
 * 3. **幂等**：已经是 number 的行再转一次结果不变。
 */
describe('normalizeContractDecimals：合同金额 JSON 口径', () => {
  it('Decimal 字符串 → number', () => {
    const out = normalizeContractDecimals({ amount: '500000.00', taxRatePct: '13.0000', changeAmount: '-500.50' });
    assert.equal(out.amount, 500000);
    assert.equal(out.taxRatePct, 13);
    assert.equal(out.changeAmount, -500.5);
  });

  it('null 保持 null（未填 ≠ 0）', () => {
    const out = normalizeContractDecimals({ amount: null, changeQty: null, interestCapRatio: null });
    assert.equal(out.amount, null);
    assert.equal(out.changeQty, null);
    assert.equal(out.interestCapRatio, null);
  });

  it('只动已知金额列，其它字段原样保留', () => {
    const row = { id: 'c1', code: 'HT-1', name: '合同', amount: '1.00', formData: '{"a":1}', remark: '123' };
    const out = normalizeContractDecimals(row);
    assert.equal(out.amount, 1);
    assert.equal(out.formData, '{"a":1}', 'formData 是 JSON 文本，不能当成金额被转');
    assert.equal(out.remark, '123', '看起来像数字的 remark 也不许动');
    assert.equal(out.code, 'HT-1');
  });

  it('ext 里的两个比例列同口径（且不改其它 ext 字段）', () => {
    const out = normalizeContractDecimals({
      amount: 1,
      ext: { id: 'e1', currentPayRatio: '0.6500', settlementPayRatio: null, financeCode: '123' },
    });
    assert.equal((out.ext as any).currentPayRatio, 0.65);
    assert.equal((out.ext as any).settlementPayRatio, null);
    assert.equal((out.ext as any).financeCode, '123');
  });

  it('幂等：number 再转一次不变', () => {
    const once = normalizeContractDecimals({ amount: '1234.56', taxRatePct: 13 });
    const twice = normalizeContractDecimals(once);
    assert.deepEqual(twice, once);
  });
});

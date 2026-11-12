import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countCountedInvoices,
  isCountedInvoice,
  sumCountedInvoices,
} from '../src/modules/ai/common/invoice-facts.ts';
import {
  chainRowCountByRoot,
  indexContractRows,
  resolveChainRoot,
} from '../src/modules/ai/common/contract-roots.ts';

/**
 * AI 事实层的两个共享原语：
 * - 有效发票（作废/红冲不计入；NULL 状态的历史票计入）；
 * - 合同链根（上溯、断链、成环都按同一口径判）。
 */
describe('AI 经营数据助手 · 有效发票口径', () => {
  it('作废/红冲不计入；NULL 与其它状态计入', () => {
    assert.equal(isCountedInvoice({ statusCode: 'VERIFIED' }), true);
    assert.equal(isCountedInvoice({ statusCode: null }), true);
    assert.equal(isCountedInvoice({}), true);
    assert.equal(isCountedInvoice({ statusCode: 'RED' }), false);
    assert.equal(isCountedInvoice({ statusCode: 'CANCELLED' }), false);
  });

  it('金额合计排除两态、跳过空金额，全程整数分', () => {
    const rows = [
      { statusCode: 'VERIFIED', amountWithTax: '100.10' },
      { statusCode: 'RED', amountWithTax: '500.00' },
      { statusCode: null, amountWithTax: '200.05' },
      { statusCode: 'CANCELLED', amountWithTax: '300.00' },
      { statusCode: 'WAIT_VERIFY', amountWithTax: '1,000.00' },
      { statusCode: 'VERIFIED', amountWithTax: null },
    ];
    assert.equal(sumCountedInvoices(rows), 1300.15);
    // 张数只看状态（金额为空的有效票仍算一张），与金额合计的口径分工不同
    assert.equal(countCountedInvoices(rows), 4);
  });
});

describe('AI 经营数据助手 · 合同链根', () => {
  const rows = [
    { id: 'r' },
    { id: 'c1', parentContractId: 'r' },
    { id: 'c2', parentContractId: 'c1' },
    { id: 'orphan', parentContractId: 'missing' },
    { id: 'a', parentContractId: 'b' },
    { id: 'b', parentContractId: 'a' },
  ];

  it('多级上溯到链根；父级缺失判为断链（不猜）', () => {
    const index = indexContractRows(rows);
    assert.deepEqual(resolveChainRoot(index, 'c2'), { rootId: 'r', broken: false });
    assert.deepEqual(resolveChainRoot(index, 'orphan'), { rootId: 'orphan', broken: true });
  });

  it('成环按断链处理（深度上限内无法到根）', () => {
    const index = indexContractRows(rows);
    assert.equal(resolveChainRoot(index, 'a').broken, true);
  });

  it('链行数按链根归集（链根 + 补充协议）', () => {
    const counts = chainRowCountByRoot(rows);
    assert.equal(counts.get('r'), 3);
    assert.equal(counts.has('orphan'), false);
    assert.equal(counts.has('a'), false);
  });
});

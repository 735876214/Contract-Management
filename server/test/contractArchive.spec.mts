import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectArchiveBlockers } from '../src/common/utils/contract-archive.ts';

/**
 * 合同归档完整性校验（业务口径 2026-10-18：单向归档）。
 * 阻断项必须挡住归档；提示项只展示、不阻断（发票/付款允许事后补录）。
 */
describe('合同归档检查', () => {
  const clean = {
    signed: true,
    execStatus: 'DONE_SETTLED',
    hasAnyDownstream: true,
    draftSettlementCodes: [] as string[],
    pendingFinalSettlementCodes: [] as string[],
    unsettledReceiptCount: 0,
    dailyRowsWithoutSettlement: 0,
    pendingInvoiceCount: 0,
    unpaidAmount: 0,
  };

  it('下游收口后可归档', () => {
    const r = collectArchiveBlockers(clean);
    assert.equal(r.canArchive, true);
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(r.warnings, []);
  });

  it('未签章 / 草稿结算 / 未完成总结算都阻断', () => {
    const r = collectArchiveBlockers({
      ...clean,
      signed: false,
      draftSettlementCodes: ['JS-A', 'JS-B'],
      pendingFinalSettlementCodes: ['ZJS-1'],
    });
    assert.equal(r.canArchive, false);
    assert.ok(r.blockers.some((b) => b.includes('尚未签章')));
    assert.ok(r.blockers.some((b) => b.includes('草稿结算单') && b.includes('JS-A')));
    assert.ok(r.blockers.some((b) => b.includes('总结算单') && b.includes('ZJS-1')));
  });

  it('未挂结算的收领单 / 未纳入结算的日报行阻断', () => {
    const r = collectArchiveBlockers({
      ...clean,
      unsettledReceiptCount: 2,
      dailyRowsWithoutSettlement: 3,
    });
    assert.equal(r.canArchive, false);
    assert.ok(r.blockers.some((b) => b.includes('2 张未挂结算单的收领单')));
    assert.ok(r.blockers.some((b) => b.includes('3 条未纳入结算的总日报行')));
  });

  it('有下游但未「已完已结」→ 阻断；无任何下游的已签章合同 → 允许', () => {
    const busy = collectArchiveBlockers({ ...clean, execStatus: 'EXECUTING' });
    assert.equal(busy.canArchive, false);
    assert.ok(busy.blockers.some((b) => b.includes('已完已结')));

    const unused = collectArchiveBlockers({ ...clean, hasAnyDownstream: false, execStatus: 'UNUSED' });
    assert.equal(unused.canArchive, true);
  });

  it('待查验发票 / 未付款只提示，不阻断', () => {
    const r = collectArchiveBlockers({ ...clean, pendingInvoiceCount: 2, unpaidAmount: 1234.56 });
    assert.equal(r.canArchive, true);
    assert.equal(r.warnings.length, 2);
    assert.ok(r.warnings.some((w) => w.includes('2 张发票待查验')));
    assert.ok(r.warnings.some((w) => w.includes('1234.56')));
  });
});

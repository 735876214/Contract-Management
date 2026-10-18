import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assetDirectionOf,
  summarizeAssetFlow,
  ASSET_FLOW_DIRECTION,
} from '../src/common/utils/asset-flow.ts';

/** 物资进出场（业务口径 2026-10-18：只做物资；不建新表；费用行不混入数量） */
describe('物资进出场方向与汇总', () => {
  it('来源 → 方向映射', () => {
    assert.equal(assetDirectionOf('PURCHASE'), ASSET_FLOW_DIRECTION.IN);
    assert.equal(assetDirectionOf('TRANSFER_IN'), ASSET_FLOW_DIRECTION.IN);
    assert.equal(assetDirectionOf('TRANSFER_OUT'), ASSET_FLOW_DIRECTION.OUT);
    assert.equal(assetDirectionOf('DISPOSE_SALE'), ASSET_FLOW_DIRECTION.OUT);
    assert.equal(assetDirectionOf('DISPOSE_RENT'), ASSET_FLOW_DIRECTION.OUT);
    assert.equal(assetDirectionOf('TRANSFER_IN_FEE'), ASSET_FLOW_DIRECTION.FEE);
    assert.equal(assetDirectionOf('MAINTENANCE'), ASSET_FLOW_DIRECTION.FEE);
    assert.equal(assetDirectionOf('SOMETHING'), ASSET_FLOW_DIRECTION.UNKNOWN);
    assert.equal(assetDirectionOf(null), ASSET_FLOW_DIRECTION.UNKNOWN);
  });

  it('按方向汇总数量与金额；费用只计金额、未知来源单列', () => {
    const s = summarizeAssetFlow([
      { sourceCode: 'PURCHASE', qty: 10, totalAmount: 1000 },
      { sourceCode: 'TRANSFER_IN', qty: 5, totalAmount: 500 },
      { sourceCode: 'TRANSFER_OUT', qty: 3, totalAmount: 300 },
      { sourceCode: 'DISPOSE_SALE', qty: 2, totalAmount: 200 },
      { sourceCode: 'TRANSFER_IN_FEE', qty: null, totalAmount: 88 },
      { sourceCode: 'MAINTENANCE', qty: null, totalAmount: 12 },
      { sourceCode: 'LEGACY_X', qty: 1, totalAmount: 9 },
    ]);
    assert.equal(s.inQty, 15);
    assert.equal(s.inAmount, 1500);
    assert.equal(s.outQty, 5);
    assert.equal(s.outAmount, 500);
    assert.equal(s.feeAmount, 100);
    assert.equal(s.unknownQty, 1);
    assert.equal(s.unknownAmount, 9);
    assert.equal(s.bySource.length, 7);
  });

  it('空数据返回 null（未知 ≠ 0）', () => {
    const s = summarizeAssetFlow([]);
    assert.equal(s.inQty, null);
    assert.equal(s.outAmount, null);
    assert.equal(s.feeAmount, null);
    assert.deepEqual(s.bySource, []);
  });
});

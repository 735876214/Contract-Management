import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_FIELD_CATALOG,
  SCOPE_READ_PERMISSION,
  aiFieldByKey,
  availableFields,
  filterFieldsByPermission,
} from '../src/modules/ai/field-catalog.ts';

/**
 * AI 填表字段目录 · 期间/跨项目作用域（Phase 4）：
 * - 跨项目填报只提供 period.* / cross.* 与项目基础字段，不提供 contract.* / supplier.*；
 * - 权限：period 与合同同源（contract:view），cross 走 dashboard:view；
 * - 金额类标签必须带单位（模型靠标签猜类型）。
 */
describe('AI 字段目录 · 期间/跨项目/业务域标量', () => {
  it('字段键唯一；period/cross 字段齐备', () => {
    const keys = AI_FIELD_CATALOG.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of [
      'period.contractSignedCount',
      'period.contractSignedAmount',
      'period.settlementAmount',
      'period.paymentAmount',
      'period.invoiceAmount',
      'period.dailyReportCount',
      'cross.projectCount',
      'cross.contractCount',
      'cross.signedAmount',
      'cross.settlementAmount',
      'cross.paymentAmount',
      'cross.invoiceAmount',
      'cross.unpaidAmount',
      'cross.uninvoicedAmount',
      'ledger.settleMonthCount',
      'ledger.cumPurchaseAmount',
      'cost.profitLossCount',
      'cost.sixSavingsAmount',
      'procurement.taskCount',
      'asset.originalTotalAmount',
      'asset.inQty',
      'daily.reportCount',
      'daily.confirmedReportCount',
    ]) {
      assert.ok(aiFieldByKey(key), `缺少字段 ${key}`);
    }
  });

  it('金额字段标签带单位（元/万元/%）', () => {
    for (const f of AI_FIELD_CATALOG) {
      if (f.type === 'money') assert.match(f.label, /\((元|万元)\)$/, `${f.key} 金额标签缺单位`);
      if (f.type === 'percent') assert.match(f.label, /\(%\)$/, `${f.key} 比例标签缺单位`);
    }
  });

  it('跨项目上下文：不出现 contract.* / supplier.*，但有 period.* / cross.*', () => {
    const fields = availableFields({ hasContract: true, hasSupplier: true, crossProject: true });
    assert.ok(fields.every((f) => f.scope !== 'contract' && f.scope !== 'supplier'));
    assert.ok(fields.some((f) => f.scope === 'period'));
    assert.ok(fields.some((f) => f.scope === 'cross'));
    assert.ok(fields.some((f) => f.scope === 'project'));
  });

  it('单项目上下文：保留 contract/supplier，不出现 cross.*；period.* 仍可用', () => {
    const fields = availableFields({ hasContract: true, hasSupplier: true });
    assert.ok(fields.some((f) => f.scope === 'contract'));
    assert.ok(fields.some((f) => f.scope === 'supplier'));
    assert.ok(fields.some((f) => f.scope === 'period'));
    assert.ok(fields.every((f) => f.scope !== 'cross'));
  });

  it('权限映射：period 同合同、cross 同统计报表；无权限时进 denied', () => {
    assert.equal(SCOPE_READ_PERMISSION.period, 'contract:view');
    assert.equal(SCOPE_READ_PERMISSION.cross, 'dashboard:view');
    assert.equal(SCOPE_READ_PERMISSION.ledger, 'ledger:view');
    assert.equal(SCOPE_READ_PERMISSION.cost, 'cost:view');
    assert.equal(SCOPE_READ_PERMISSION.asset, 'asset:view');
    assert.equal(SCOPE_READ_PERMISSION.daily, 'daily:view');
    const crossFields = AI_FIELD_CATALOG.filter((f) => f.scope === 'cross');
    const can = (code: string) => code === 'contract:view';
    const { fields, denied } = filterFieldsByPermission(crossFields, can);
    assert.equal(fields.length, 0);
    assert.equal(denied.length, crossFields.length);
  });
});

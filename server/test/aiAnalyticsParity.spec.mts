import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AI_DATASETS } from '../src/modules/ai/analytics/dataset-registry.ts';
import { DATASET_COLUMNS, datasetColumnsOf } from '../src/modules/ai/analytics/dataset-columns.ts';

/**
 * 注册表 ↔ 列定义 parity（Phase 5 收口）：
 * 两个文件的 key 集合必须完全相等；列名不重复、不含空串。
 * 防止「注册表新增了域、工作簿/行级填充却空表」这类静默缺失。
 */
describe('AI 经营数据助手 · 注册表与列定义 parity', () => {
  it('key 集合完全相等（无遗漏、无孤儿）', () => {
    const registry = new Set(AI_DATASETS.map((d) => d.key));
    const columns = new Set(Object.keys(DATASET_COLUMNS));
    assert.equal(registry.size, columns.size);
    for (const key of registry) assert.ok(columns.has(key), `列定义缺少 ${key}`);
    for (const key of columns) assert.ok(registry.has(key), `列定义存在孤儿 key ${key}`);
  });

  it('每个域列名非空且不重复', () => {
    for (const d of AI_DATASETS) {
      const cols = datasetColumnsOf(d.key);
      assert.ok(cols.length > 0, `${d.key} 列为空`);
      assert.ok(cols.every((c) => String(c).trim().length > 0), `${d.key} 存在空列名`);
      assert.equal(new Set(cols).size, cols.length, `${d.key} 列名重复`);
    }
  });

  it('金额/日期类列名口径稳定（抽查关键列）', () => {
    assert.ok(datasetColumnsOf('settlement.ledger').includes('本月开票额'));
    assert.ok(datasetColumnsOf('contract.fulfillment').includes('开票比例(%)'));
    assert.ok(datasetColumnsOf('repayment.agreement').includes('逾期未付'));
    assert.ok(datasetColumnsOf('procurement.documents').includes('文件类型'));
  });
});

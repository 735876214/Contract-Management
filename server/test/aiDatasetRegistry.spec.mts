import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_DATASETS,
  DEFAULT_DATASET_KEYS,
  IMPLEMENTED_DATASET_KEYS,
  MAX_DATASETS,
  datasetByKey,
  filterDatasets,
  limitDatasets,
} from '../src/modules/ai/analytics/dataset-registry.ts';
import { datasetColumnsOf } from '../src/modules/ai/analytics/dataset-columns.ts';
import { AI_REPORT_SECTIONS } from '../src/modules/ai/analytics/analytics.types.ts';

/**
 * 注册表漂移锁（2026-11-12 评审确认的形态）：
 * 27 个业务单据域一次登记；`implemented: false` 的不对用户暴露；
 * 默认选中必须是已实现条目；权限码只复用既有 `*:view`。
 */
describe('AI 经营数据助手 · 数据集注册表', () => {
  it('27 个业务单据域全部登记，key 唯一', () => {
    assert.equal(AI_DATASETS.length, 27);
    const keys = AI_DATASETS.map((d) => d.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('每条都有中文名/说明/权限/报告章节，章节必须在稳定 ID 集合内', () => {
    const sections = new Set(AI_REPORT_SECTIONS);
    for (const d of AI_DATASETS) {
      assert.ok(d.key.includes('.'), `key 形态应为 <域>.<对象>：${d.key}`);
      assert.ok(d.label.trim(), `${d.key} 缺中文名`);
      assert.ok(d.desc.trim(), `${d.key} 缺说明`);
      assert.match(d.permission, /^[a-z_]+:view$/, `${d.key} 权限码应复用既有 *:view`);
      assert.ok(sections.has(d.reportSection), `${d.key} 报告章节未知：${d.reportSection}`);
    }
  });

  it('Phase 5 收口：27 个域全部已实现，且每个域都有 Excel 列定义', () => {
    assert.equal(IMPLEMENTED_DATASET_KEYS.size, 27);
    assert.equal(AI_DATASETS.filter((d) => !d.implemented).length, 0);
    for (const d of AI_DATASETS) {
      const cols = datasetColumnsOf(d.key);
      assert.ok(cols.length > 0, `${d.key} 缺 Excel 列定义（工作簿/行级填充会空表）`);
      assert.equal(new Set(cols).size, cols.length, `${d.key} 列名重复`);
    }
  });

  it('默认选中 4 个，且全部是已实现条目', () => {
    assert.equal(DEFAULT_DATASET_KEYS.length, 4);
    assert.deepEqual(DEFAULT_DATASET_KEYS, [
      'contract.summary',
      'settlement.summary',
      'payment.records',
      'invoice.records',
    ]);
    for (const key of DEFAULT_DATASET_KEYS) assert.ok(IMPLEMENTED_DATASET_KEYS.has(key));
  });

  it('权限过滤：全部已实现；无权限的进 denied 而不是静默消失', () => {
    const all = filterDatasets(() => true);
    assert.equal(all.visible.length, 27);
    assert.equal(all.denied.length, 0);

    const none = filterDatasets(() => false);
    assert.equal(none.visible.length, 0);
    assert.equal(none.denied.length, 27);

    const onlyContract = filterDatasets((code) => code === 'contract:view');
    assert.ok(onlyContract.visible.every((d) => d.permission === 'contract:view'));
    assert.ok(onlyContract.denied.length > 0);
    for (const d of onlyContract.visible) assert.ok(d.implemented);
  });

  it('最多 8 个数据集：去重后截断并回报截断数', () => {
    const many = [...AI_DATASETS.map((d) => d.key), 'contract.summary'];
    const { keys, truncated } = limitDatasets(many, MAX_DATASETS);
    assert.equal(keys.length, 8);
    assert.equal(new Set(keys).size, 8);
    assert.equal(truncated, many.length - 1 - 8);
  });
});

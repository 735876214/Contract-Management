import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PERIOD_PRESETS,
  AI_REPORT_KINDS,
} from '../src/modules/ai/analytics/analytics.types.ts';
import {
  KIND_OPTIONS,
  PRESET_OPTIONS,
} from '../../web/src/components/ai/analytics/constants.ts';

/**
 * 前端下拉 ↔ 后端枚举 parity：
 * 前端只是「展示 + 提交」的镜像，取值集合必须与后端完全一致，
 * 否则会出现「界面能选、服务端归一掉」的静默降级。
 */
describe('AI 经营数据助手 · 前端选项与后端枚举 parity', () => {
  const values = (options: ReadonlyArray<{ value: string }>): string[] =>
    options.map((o) => o.value);

  it('期间预设集合一致，且无重复、无空文案', () => {
    assert.deepEqual(new Set(values(PRESET_OPTIONS)), new Set(AI_PERIOD_PRESETS));
    assert.equal(new Set(values(PRESET_OPTIONS)).size, PRESET_OPTIONS.length);
    assert.ok(PRESET_OPTIONS.every((o) => o.label.trim().length > 0));
  });

  it('报告类型集合一致，且无重复、无空文案', () => {
    assert.deepEqual(new Set(values(KIND_OPTIONS)), new Set(AI_REPORT_KINDS));
    assert.equal(new Set(values(KIND_OPTIONS)).size, KIND_OPTIONS.length);
    assert.ok(KIND_OPTIONS.every((o) => o.label.trim().length > 0));
  });
});

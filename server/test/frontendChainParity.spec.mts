import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_TYPES,
  TASK_STATUS_LABELS as BE_TASK_STATUS_LABELS,
  stageChain,
} from '../src/constants/procurementFlow.ts';
import {
  PROCUREMENT_TASK_TYPES,
  TASK_STATUS_LABELS as FE_TASK_STATUS_LABELS,
  buildStageChain,
} from '../../web/src/constants/procurementWorkflow.ts';

/**
 * 优化点 2：前后端阶段链/状态定义「漂移锁」。
 * 后端 stageChain（gating 唯一事实源）与前端 buildStageChain（列表/详情本地兜底展示）
 * 对同一采购类型必须产出完全一致的阶段序列；任一侧改动未同步，本测试立即失败。
 *
 * 说明：本文件用 .mts 由 Node 原生（类型擦除）加载，从而能跨包引用 web/ 下的 ESM 常量
 * （web/package.json 为 "type": "module"，ts-node 的 CJS require 钩子无法加载）。
 */
describe('前后端阶段链一致性（漂移锁）', () => {
  const combos: Array<{ type: string; preMeeting: boolean }> = [
    { type: 'SINGLE', preMeeting: true },
    { type: 'SINGLE', preMeeting: false },
    { type: 'FRAMEWORK', preMeeting: false },
    { type: 'EMERGENCY', preMeeting: false },
  ];

  for (const { type, preMeeting } of combos) {
    it(`${type}（${preMeeting ? '≥100万' : '<100万'}）：前端展示链与后端 gating 链一致`, () => {
      const backend = stageChain(type, preMeeting).map((s) => ({ key: s.key, label: s.label }));
      const frontendFull = buildStageChain(type, preMeeting).map((s) => ({ key: s.key, label: s.label }));
      // 后端 stageChain 不含末态 CONTRACT（由 buildStages 追加）；前端展示链显式含 CONTRACT
      const frontend = frontendFull.filter((s) => s.key !== 'CONTRACT');

      assert.deepEqual(frontend, backend, `${type} 阶段序列漂移`);
      assert.equal(frontendFull[frontendFull.length - 1]?.key, 'CONTRACT', `${type} 末端应为生成合同`);
    });
  }

  it('采购类型列表一致（含紧急采购）', () => {
    assert.deepEqual(
      PROCUREMENT_TASK_TYPES.map((t) => t.value),
      [...TASK_TYPES],
    );
    assert.ok(PROCUREMENT_TASK_TYPES.some((t) => t.value === 'EMERGENCY'));
  });

  it('任务状态展示名一致', () => {
    assert.deepEqual(FE_TASK_STATUS_LABELS, BE_TASK_STATUS_LABELS);
  });

  it('<100万 单项采购：两端都不含采前会，但都保留采购公告与采购文件', () => {
    const keys = stageChain('SINGLE', false).map((s) => s.key);
    assert.ok(!keys.includes('PRE_MEETING'));
    assert.ok(keys.includes('NOTICE'));
    assert.ok(keys.includes('DOCUMENT'));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_TYPES,
  TASK_STATUS_LABELS as BE_TASK_STATUS_LABELS,
  stageChain,
  CONTRACT_STATUS_TO_TASK_STATUS,
  contractStageTaskStatus,
} from '../src/constants/procurementFlow.ts';
import {
  PROCUREMENT_TASK_TYPES,
  TASK_STATUS_LABELS as FE_TASK_STATUS_LABELS,
  CONTRACT_STAGE_STATUSES,
  buildStageChain,
} from '../../web/src/constants/procurementWorkflow.ts';
import { amountToChineseCapital as feAmountToChineseCapital } from '../src/common/calc/money.ts';
import {
  calcAmount as feCalcAmount,
  round2 as feRound2,
} from '../../web/src/utils/procurementPriceCompare.ts';
import { amountToChineseCapital, round2 } from '../src/common/calc/money.ts';
import { calcAmount } from '../src/common/calc/amounts.ts';
import {
  defaultFinalPrice as sharedDefaultFinalPrice,
  calcIncomeWan as sharedCalcIncomeWan,
  calcCostWan as sharedCalcCostWan,
  summarizeCost as sharedSummarizeCost,
  lowestPriceSuppliers as sharedLowestPriceSuppliers,
} from '../src/common/calc/procurement.ts';
import { defaultFinalPrice as feDefaultFinalPrice } from '../../web/src/utils/procurementResultReport.ts';
import {
  calcIncomeWan as feCalcIncomeWan,
  calcCostWan as feCalcCostWan,
  summarizeCost as feSummarizeCost,
} from '../../web/src/utils/preMeetingMinutes.ts';

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

  describe('合同阶段子状态映射（合同状态 → 采购任务状态）', () => {
    it('映射目标必须正是前端已准备展示的合同阶段状态集合', () => {
      assert.deepEqual(
        Object.values(CONTRACT_STATUS_TO_TASK_STATUS).sort(),
        [...CONTRACT_STAGE_STATUSES].sort(),
        '后端映射出的状态与前端 CONTRACT_STAGE_STATUSES 不一致（前端将无法展示标签/颜色）',
      );
    });

    it('每个映射目标都有前端中文标签', () => {
      const missing = Object.values(CONTRACT_STATUS_TO_TASK_STATUS).filter(
        (st) => !FE_TASK_STATUS_LABELS[st],
      );
      assert.deepEqual(missing, [], `前端缺少状态标签：${missing.join(', ')}`);
    });

    it('草稿/未知/空值回退「合同编制中」，待签章→待签章，已签章→已完成', () => {
      assert.equal(contractStageTaskStatus('DRAFT'), 'CONTRACT_EDITING');
      assert.equal(contractStageTaskStatus(null), 'CONTRACT_EDITING');
      assert.equal(contractStageTaskStatus(undefined), 'CONTRACT_EDITING');
      assert.equal(contractStageTaskStatus('未知状态'), 'CONTRACT_EDITING');
      assert.equal(contractStageTaskStatus('APPROVING'), 'CONTRACT_APPROVING');
      assert.equal(contractStageTaskStatus('SIGNED'), 'COMPLETED');
    });
  });

  it('<100万 单项采购：两端都不含采前会，但都保留采购公告与采购文件', () => {
    const keys = stageChain('SINGLE', false).map((s) => s.key);
    assert.ok(!keys.includes('PRE_MEETING'));
    assert.ok(keys.includes('NOTICE'));
    assert.ok(keys.includes('DOCUMENT'));
  });
});

/**
 * 金额口径漂移锁：web 侧的工具必须直接复用 server/src/common/calc，
 * 不允许再出现「前端一份 EPSILON 旧公式、后端一份字符串位移新公式」。
 */
describe('前后端计算原语一致性（漂移锁）', () => {
  it('中文大写金额逐值相等', () => {
    for (const v of [0, 8.165, 1234.56, 100005, 100000001, -1.01]) {
      assert.equal(feAmountToChineseCapital(v), amountToChineseCapital(v), `大写金额漂移：${v}`);
    }
  });

  it('round2 与合价逐值相等（含半值边界与字符串 Decimal）', () => {
    for (const v of [8.165, 1.005, -2.5, 1234567.005, 0.1 + 0.2]) {
      assert.equal(feRound2(v), round2(v), `round2 漂移：${v}`);
    }
    assert.equal(feCalcAmount('1.005', 3), calcAmount('1.005', 3));
    assert.equal(calcAmount('1.005', 3), 3.02, '整数分精确乘法须得 3.02（与 Excel ROUND 一致）');
    assert.equal(feCalcAmount(10, 13), calcAmount(10, 13));
  });

  it('采购派生规则前后端同源：最终价回退 / 万元换算 / 成本汇总 / 最低价', () => {
    // 最终确认价：通过第一轮取第二轮，否则回退第一轮
    for (const s of [
      { passedFirst: '是', firstPreTaxTotal: 100, secondPreTaxTotal: 90 },
      { passedFirst: '否', firstPreTaxTotal: 100, secondPreTaxTotal: 90 },
      { passedFirst: '是', firstPreTaxTotal: 100, secondPreTaxTotal: null },
      { passedFirst: 'Y', firstPreTaxTotal: 100, secondPreTaxTotal: 88 },
    ]) {
      assert.equal(feDefaultFinalPrice(s), sharedDefaultFinalPrice(s), `最终价漂移：${JSON.stringify(s)}`);
    }
    assert.equal(sharedDefaultFinalPrice({ passedFirst: '是', firstPreTaxTotal: 100, secondPreTaxTotal: 90 }), 90);
    assert.equal(sharedDefaultFinalPrice({ passedFirst: '否', firstPreTaxTotal: 100, secondPreTaxTotal: 90 }), 100);
    // 万元换算（含 1.005 类浮点边界，整数分口径）
    for (const [p, q] of [[100, 10], [1.005, 3], [1234.56, 7]]) {
      assert.equal(feCalcIncomeWan(p, q), sharedCalcIncomeWan(p, q), `清单收入漂移：${p}×${q}`);
      assert.equal(feCalcCostWan(p, q), sharedCalcCostWan(p, q), `预计成本漂移：${p}×${q}`);
    }
    // 成本汇总
    const rows = [{ income: 10, cost: 9 }, { income: 20, cost: 15 }];
    assert.deepEqual(feSummarizeCost(rows), sharedSummarizeCost(rows));
    // 询价最低价（并列保留、过滤空行）
    const inquiry = [
      { unit: 'A', totalPrice: 100 },
      { unit: 'B', totalPrice: 80 },
      { unit: 'C', totalPrice: 80 },
      { unit: '', totalPrice: 10 },
      { unit: 'D', totalPrice: null },
    ];
    assert.deepEqual(sharedLowestPriceSuppliers(inquiry), [
      { supplier: 'B', amount: 80 },
      { supplier: 'C', amount: 80 },
    ]);
  });
});

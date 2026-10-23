/**
 * 履约偏差预警（课题 4-9）配置层 + 措辞层单测。
 *
 * 守的是三条最容易被“优化”掉的护栏：
 * 1. **参数写错不许 500**——回落默认值并在 `problems` 里留人话；
 * 2. **模型不许编数字**——措辞里出现 facts 之外的数字必须被对账拦下（合同编号里的数字除外）；
 * 3. **模板兜底永不空窗**——0 命中 / 有命中 / 有未判定规则三种情形都要有话说。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FULFILLMENT_PARAM_DEFAULTS,
  FULFILLMENT_PARAM_KEYS,
  fulfillmentParamHints,
  fulfillmentToleranceText,
  parseFulfillmentConfig,
} from '../src/modules/ai/fulfillment/fulfillment-config.ts';
import {
  auditFulfillmentNarrative,
  buildFulfillmentMessages,
  fallbackFulfillmentNarrative,
} from '../src/modules/ai/fulfillment/fulfillment-prompt.ts';
import {
  DEFAULT_FULFILLMENT_TOLERANCES,
  FULFILLMENT_CODES,
  type FulfillmentFinding,
} from '../src/modules/ai/fulfillment/fulfillment-types.ts';
import type { FulfillmentEvaluation } from '../src/modules/ai/fulfillment/rules-fulfillment.ts';

function finding(over: Partial<FulfillmentFinding> = {}): FulfillmentFinding {
  return {
    code: FULFILLMENT_CODES.C1_OVERDUE,
    level: 'HIGH',
    entity: 'milestone',
    entityId: 'm-1',
    title: 'HT-2026-102 完工 逾期 238 天未完成（计划 2026-02-28）',
    facts: ['计划日期：2026-02-28', '逾期天数：238 天', '合同：HT-2026-102（装饰装修工程）'],
    amountDiff: null,
    ...over,
  };
}

function evaluation(findings: FulfillmentFinding[], notEvaluated: string[] = []): FulfillmentEvaluation {
  const byCode: Record<string, number> = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  return {
    findings,
    summary: {
      total: findings.length,
      high: findings.filter((f) => f.level === 'HIGH').length,
      medium: findings.filter((f) => f.level === 'MEDIUM').length,
      byCode,
    },
    notEvaluated,
  };
}

describe('履约偏差 · 阈值配置', () => {
  it('缺省时全部用默认值，且不产生 problem', () => {
    const cfg = parseFulfillmentConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.narrative, true);
    assert.deepEqual(cfg.tolerances, DEFAULT_FULFILLMENT_TOLERANCES);
    assert.deepEqual(cfg.problems, []);
  });

  it('默认值与参数提示一一对应（管理界面抄默认值不会抄错）', () => {
    const hints = fulfillmentParamHints();
    for (const h of hints) {
      assert.equal(FULFILLMENT_PARAM_DEFAULTS[h.key], h.def, `${h.key} 默认值不一致`);
    }
    assert.equal(hints.length, Object.keys(FULFILLMENT_PARAM_KEYS).length);
  });

  it('开关支持 1/0/true/off 等写法', () => {
    assert.equal(parseFulfillmentConfig({ [FULFILLMENT_PARAM_KEYS.enabled]: '0' }).enabled, false);
    assert.equal(parseFulfillmentConfig({ [FULFILLMENT_PARAM_KEYS.enabled]: 'off' }).enabled, false);
    assert.equal(parseFulfillmentConfig({ [FULFILLMENT_PARAM_KEYS.narrative]: 'no' }).narrative, false);
    assert.equal(parseFulfillmentConfig({ [FULFILLMENT_PARAM_KEYS.narrative]: 'true' }).narrative, true);
  });

  it('非法值回落默认并留一句人话（不 500）', () => {
    const cfg = parseFulfillmentConfig({
      [FULFILLMENT_PARAM_KEYS.graceDays]: '七天',
      [FULFILLMENT_PARAM_KEYS.progressGapPct]: '',
      [FULFILLMENT_PARAM_KEYS.enabled]: 'maybe',
    });
    assert.equal(cfg.tolerances.graceDays, DEFAULT_FULFILLMENT_TOLERANCES.graceDays);
    assert.equal(cfg.tolerances.progressGapPct, DEFAULT_FULFILLMENT_TOLERANCES.progressGapPct);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.problems.length, 2); // 空串不算非法，只有 graceDays 与 enabled 各一条
    assert.ok(cfg.problems.some((p) => p.includes('ai.fulfillment.graceDays')));
    assert.ok(cfg.problems.some((p) => p.includes('ai.fulfillment.enabled')));
  });

  it('超范围夹逼到边界（填 10000 天等于关规则，必须拦住）', () => {
    const cfg = parseFulfillmentConfig({
      [FULFILLMENT_PARAM_KEYS.graceDays]: '10000',
      [FULFILLMENT_PARAM_KEYS.progressGapPct]: '150',
      [FULFILLMENT_PARAM_KEYS.lateFinishDays]: '-5',
    });
    assert.equal(cfg.tolerances.graceDays, 365);
    assert.equal(cfg.tolerances.progressGapPct, 100);
    assert.equal(cfg.tolerances.lateFinishDays, 0);
    assert.equal(cfg.problems.length, 3);
  });

  it('阈值文案把四个阈值都说清楚（面板与提示词共用）', () => {
    const text = fulfillmentToleranceText(DEFAULT_FULFILLMENT_TOLERANCES);
    assert.ok(text.includes('逾期宽限 7 天'));
    assert.ok(text.includes('完成滞后容忍 7 天'));
    assert.ok(text.includes('30 个百分点'));
  });
});

describe('履约偏差 · 提示词', () => {
  it('提示词带齐范围/样本/阈值/命中/未判定五段', () => {
    const ev = evaluation([finding()], ['C6 因合同金额未填未判定']);
    const messages = buildFulfillmentMessages({
      scope: '本项目全部在履行合同（3 份）',
      sample: { 合同: 3, 履约节点: 7 },
      toleranceText: fulfillmentToleranceText(DEFAULT_FULFILLMENT_TOLERANCES),
      evaluation: ev,
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    const user = String(messages[1].content);
    assert.ok(user.includes('本项目全部在履行合同（3 份）'));
    assert.ok(user.includes('合同 3，履约节点 7'));
    assert.ok(user.includes('逾期宽限 7 天'));
    assert.ok(user.includes('HT-2026-102'));
    assert.ok(user.includes('C6 因合同金额未填未判定'));
  });

  it('system 里保留了「不得计算新数字」「不得法律定性」「未判定必须说明」三条铁律', () => {
    const sys = String(
      buildFulfillmentMessages({
        scope: 'x',
        sample: {},
        toleranceText: 'y',
        evaluation: evaluation([finding()]),
      })[0].content,
    );
    assert.ok(sys.includes('不得计算任何新的数字'));
    assert.ok(sys.includes('不得给出法律定性结论'));
    assert.ok(sys.includes('未覆盖范围'));
  });

  it('命中清单不截断（截断即漏报）', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      finding({ entityId: `m-${i}`, title: `HT-2026-2${i.toString().padStart(2, '0')} 节点 逾期 9 天未完成` }),
    );
    const user = String(
      buildFulfillmentMessages({
        scope: 'x',
        sample: {},
        toleranceText: 'y',
        evaluation: evaluation(many),
      })[1].content,
    );
    assert.equal((user.match(/^- \[/gm) ?? []).length, 40);
  });

  it('0 命中时提示词明确写「（无）」而不是省略该段', () => {
    const user = String(
      buildFulfillmentMessages({
        scope: 'x',
        sample: {},
        toleranceText: 'y',
        evaluation: evaluation([]),
      })[1].content,
    );
    assert.ok(user.includes('【命中清单】\n（无）'));
    assert.ok(user.includes('（无，全部规则已判定）'));
  });
});

describe('履约偏差 · 措辞对账', () => {
  it('只抄 facts 里的数字 → 放行', () => {
    const ev = evaluation([finding()]);
    const unknown = auditFulfillmentNarrative(
      {
        conclusion: 'HT-2026-102 的「完工」节点计划日期 2026-02-28，已逾期 238 天未完成，属高风险。',
        actions: ['联系责任人核实实际进度', '在系统里重新排计划或登记延期原因'],
      },
      ev,
    );
    assert.deepEqual(unknown, []);
  });

  it('模型自己算出来的数字（facts 里没有）→ 拦截', () => {
    const ev = evaluation([finding()]);
    const unknown = auditFulfillmentNarrative(
      {
        conclusion: 'HT-2026-102 逾期 238 天，估计影响工期 33 个百分点。',
        actions: ['核实'],
      },
      ev,
    );
    assert.ok(unknown.includes('33'));
  });

  it('合同编号里的数字不算编造（否则老实抄编号反被判违规）', () => {
    const ev = evaluation([finding({ facts: ['逾期天数：238 天'], title: 'HT-2026-102 完工 逾期 238 天未完成' })]);
    const unknown = auditFulfillmentNarrative(
      { conclusion: 'HT-2026-102 逾期 238 天未完成。', actions: ['核实'] },
      ev,
    );
    assert.deepEqual(unknown, []);
  });

  it('计数词 0~10 无条件放行，11 以上必须来自 facts', () => {
    const ev = evaluation([finding({ facts: ['逾期天数：238 天'], title: 'HT-2026-102' })]);
    assert.deepEqual(auditFulfillmentNarrative({ conclusion: '共 2 项需复核。', actions: ['核实'] }, ev), []);
    assert.deepEqual(auditFulfillmentNarrative({ conclusion: '共 12 项需复核。', actions: ['核实'] }, ev), ['12']);
  });
});

describe('履约偏差 · 模板兜底', () => {
  it('0 命中：说明扫过什么，不留空白', () => {
    const n = fallbackFulfillmentNarrative(evaluation([]));
    assert.ok(n.conclusion.includes('未命中履约偏差'));
    assert.equal(n.actions.length, 1);
  });

  it('0 命中但有未判定规则：必须点出覆盖范围不足', () => {
    const n = fallbackFulfillmentNarrative(evaluation([], ['C6 因合同金额未填未判定']));
    assert.ok(n.conclusion.includes('未参与判定'));
  });

  it('有命中：条数/等级/类型/优先处理齐全，动作可执行', () => {
    const ev = evaluation([
      finding(),
      finding({ code: FULFILLMENT_CODES.C6_PROGRESS_PAYMENT_GAP, level: 'MEDIUM', entityId: 'c-1' }),
    ]);
    const n = fallbackFulfillmentNarrative(ev);
    assert.ok(n.conclusion.includes('2 项履约偏差'));
    assert.ok(n.conclusion.includes('高风险 1 项'));
    assert.ok(n.conclusion.includes('节点逾期未完成'));
    assert.ok(n.actions.length >= 4);
    assert.ok(n.actions.some((a) => a.includes('暂缓后续付款审批')));
  });
});

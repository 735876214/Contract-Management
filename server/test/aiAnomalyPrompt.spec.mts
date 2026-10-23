import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANOMALY_PARAM_DEFAULTS,
  ANOMALY_PARAM_KEYS,
  ANOMALY_PARAM_KEY_LIST,
  parseAnomalyConfig,
} from '../src/modules/ai/anomaly/anomaly-config.ts';
import {
  auditNarrative,
  buildAnomalyMessages,
  collectFactNumbers,
  extractNumbers,
  fallbackNarrative,
  normalizeNumberToken,
} from '../src/modules/ai/anomaly/anomaly-prompt.ts';
import {
  ANOMALY_CODES,
  ANOMALY_LEVEL,
  type AnomalyEvaluation,
  type Finding,
} from '../src/modules/ai/anomaly/anomaly-types.ts';
import { summarizeFindings } from '../src/modules/ai/anomaly/rules-payment.ts';

/**
 * AI 预警 · 配置解析与措辞层的测试。
 *
 * 锁三件在财务场景「错一次就没人再信」的事：
 * ① **阈值解析**：非法/越界参数必须回落并留痕，不能静默变成「永远不报」或「永远报」；
 * ② **数字对账**：模型结论里出现 `facts` 之外的数字必须被挑出来（编造即丢弃）；
 * ③ **兜底文案**：0 命中与「有规则没跑」必须能被区分，不能被读成「账没问题」。
 */

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    code: ANOMALY_CODES.R2_OVERPAY,
    level: ANOMALY_LEVEL.HIGH,
    entity: 'payment',
    entityId: 'pay_1',
    title: '合同 HT-2026-001 累计付款 150,000.00 元，超过应付上限 145,000.00 元',
    facts: { 已付: '150,000.00', 应付上限: '145,000.00', 付款比例: '0.8' },
    amountDiff: '5,000.00',
    ...over,
  };
}

function mkEvaluation(findings: Finding[], notEvaluated: string[] = []): AnomalyEvaluation {
  return { findings, summary: summarizeFindings(findings), notEvaluated };
}

describe('anomaly-config · 阈值与开关解析', () => {
  it('全空时取默认值：开启、模型措辞开启、容差 1 元 / 2% / 0.8', () => {
    const cfg = parseAnomalyConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.narrative, true);
    assert.equal(cfg.tolerances.amount, 100n);
    assert.equal(cfg.tolerances.qtyPct, 2);
    assert.equal(cfg.tolerances.jaccard, 0.8);
    assert.deepEqual(cfg.problems, []);
  });

  it('开关认得 0/false/off，非法值回落并留痕', () => {
    assert.equal(parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.enabled]: '0' }).enabled, false);
    assert.equal(parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.enabled]: 'false' }).enabled, false);
    assert.equal(parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.enabled]: 'off' }).enabled, false);
    assert.equal(parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.narrative]: '0' }).narrative, false);
    const bad = parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.enabled]: 'maybe' });
    assert.equal(bad.enabled, true);
    assert.equal(bad.problems.length, 1);
    assert.match(bad.problems[0], /ai\.anomaly\.enabled=maybe/);
  });

  it('金额容差按「元 → 分」解析：0 允许（严格相等），非法回落 1 元', () => {
    assert.equal(parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.amountTolerance]: '0' }).tolerances.amount, 0n);
    assert.equal(parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.amountTolerance]: '2.50' }).tolerances.amount, 250n);
    const neg = parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.amountTolerance]: '-1' });
    assert.equal(neg.tolerances.amount, 100n);
    assert.equal(neg.problems.length, 1);
    const nan = parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.amountTolerance]: 'abc' });
    assert.equal(nan.tolerances.amount, 100n);
    assert.equal(nan.problems.length, 1);
  });

  it('数量容差夹在 0~100，越界记 problem', () => {
    assert.equal(parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.qtyTolerancePct]: '3.5' }).tolerances.qtyPct, 3.5);
    const over = parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.qtyTolerancePct]: '250' });
    assert.equal(over.tolerances.qtyPct, 100);
    assert.equal(over.problems.length, 1);
    const neg = parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.qtyTolerancePct]: '-5' });
    assert.equal(neg.tolerances.qtyPct, 0);
    assert.equal(neg.problems.length, 1);
  });

  it('明细重合度夹在 0~1', () => {
    assert.equal(parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.jaccard]: '0.5' }).tolerances.jaccard, 0.5);
    const over = parseAnomalyConfig({ [ANOMALY_PARAM_KEYS.jaccard]: '1.5' });
    assert.equal(over.tolerances.jaccard, 1);
    assert.equal(over.problems.length, 1);
  });

  it('默认值表覆盖全部参数键（漏键会让 service 静默走默认值）', () => {
    assert.deepEqual(ANOMALY_PARAM_KEY_LIST, Object.values(ANOMALY_PARAM_KEYS));
    for (const key of ANOMALY_PARAM_KEY_LIST) {
      assert.ok(key in ANOMALY_PARAM_DEFAULTS, `缺少默认值：${key}`);
    }
  });
});

describe('anomaly-prompt · 数字提取与对账', () => {
  it('数字归一：千分位与尾部 0 视为同一个数', () => {
    assert.equal(normalizeNumberToken('1,234.50'), '1234.5');
    assert.equal(normalizeNumberToken('100.00'), '100');
    assert.equal(normalizeNumberToken('5,000.00'), '5000');
  });

  it('从中文句子里抽数字（含负数、小数、百分比）', () => {
    assert.deepEqual(extractNumbers('差额 5,000.00 元，占 1.5%'), ['5000', '1.5']);
    assert.deepEqual(extractNumbers('未发现异常'), []);
  });

  it('fact 数字全集包含 facts 值、标题与差额', () => {
    const allowed = collectFactNumbers(mkEvaluation([mkFinding()]));
    assert.ok(allowed.has('150000'));
    assert.ok(allowed.has('145000'));
    assert.ok(allowed.has('5000'));
    assert.ok(allowed.has('2026'));
  });

  it('结论只引用 facts 数字时对账通过', () => {
    const ev = mkEvaluation([mkFinding()]);
    const unknown = auditNarrative(
      {
        conclusion: '合同 HT-2026-001 累计付款 150,000.00 元，已超应付上限 145,000.00 元，差额 5,000.00 元。',
        actions: ['暂停合同 HT-2026-001 的后续付款，核对付款比例 0.8 是否已变更。'],
      },
      ev,
    );
    assert.deepEqual(unknown, []);
  });

  it('出现 facts 之外的金额一律判为编造', () => {
    const ev = mkEvaluation([mkFinding()]);
    const unknown = auditNarrative(
      { conclusion: '本次重复支付约 9,999.99 元，需立即追回。', actions: ['联系供应商退款。'] },
      ev,
    );
    assert.deepEqual(unknown, ['9999.99']);
  });

  it('允许 0~10 的计数词，不误判为编造', () => {
    const ev = mkEvaluation([mkFinding()]);
    const unknown = auditNarrative(
      { conclusion: '共 3 项疑点，其中高风险 1 项，建议按 2 个批次核查。', actions: ['先查高风险那条。'] },
      ev,
    );
    assert.deepEqual(unknown, []);
  });
});

describe('anomaly-prompt · 兜底文案与提示词', () => {
  it('0 命中时明确说明「未覆盖未判定规则」，不写成已核查无风险', () => {
    const ev = mkEvaluation([], ['合同 HT-2026-001 没有付款比例，超付规则未判定']);
    const text = fallbackNarrative(ev);
    assert.match(text.conclusion, /未发现疑点/);
    assert.match(text.conclusion, /1 条规则因口径缺失/);
    assert.match(text.conclusion, /不代表原始凭证一定合规/);
    assert.ok(text.actions.length >= 1);
  });

  it('有命中时结论含总数与高/中风险数，动作条数为 3~5', () => {
    const ev = mkEvaluation([
      mkFinding(),
      mkFinding({ code: ANOMALY_CODES.R3_PAY_WITHOUT_CONTRACT, level: ANOMALY_LEVEL.MEDIUM, entityId: 'pay_2' }),
    ]);
    const text = fallbackNarrative(ev);
    assert.match(text.conclusion, /共命中 2 项疑点/);
    assert.match(text.conclusion, /高风险 1 项/);
    assert.match(text.conclusion, /中风险 1 项/);
    assert.ok(text.actions.length >= 3 && text.actions.length <= 5);
  });

  it('提示词分 system/user 两段，铁律与每条命中都在里面', () => {
    const ev = mkEvaluation([mkFinding()], ['收领单缺失，结算早于验收规则未判定']);
    const messages = buildAnomalyMessages({
      period: { from: '2026-01-01', to: '2026-06-30' },
      sample: { 合同: 2, 结算单: 4 },
      toleranceText: '金额容差 1.00 元；数量容差 +2%；明细重合度 0.8',
      evaluation: ev,
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /不得计算任何新的数字/);
    assert.match(messages[0].content, /不得给出法律、税务定性结论/);
    assert.equal(messages[1].role, 'user');
    const user = messages[1].content;
    assert.match(user, /2026-01-01 ~ 2026-06-30/);
    assert.match(user, /合同 2/);
    assert.match(user, /金额容差 1\.00 元/);
    assert.match(user, /HT-2026-001/);
    assert.match(user, /收领单缺失/);
    assert.match(user, /共 1 项/);
  });

  it('未限期间与 0 命中时，提示词如实写「全部历史数据」「（无）」', () => {
    const messages = buildAnomalyMessages({
      period: { from: null, to: null },
      sample: {},
      toleranceText: '金额容差 1.00 元',
      evaluation: mkEvaluation([]),
    });
    assert.match(messages[1].content, /全部历史数据/);
    assert.match(messages[1].content, /（无）/);
    assert.match(messages[1].content, /全部规则已判定/);
  });
});

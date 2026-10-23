import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  QUOTE_PARAM_KEYS,
  parseQuoteConfig,
  quoteToleranceText,
} from '../src/modules/ai/quote/quote-config.ts';
import {
  auditQuoteNarrative,
  buildQuoteMessages,
  fallbackQuoteNarrative,
} from '../src/modules/ai/quote/quote-prompt.ts';
import {
  DEFAULT_QUOTE_TOLERANCES,
  QUOTE_CODES,
  type QuoteEvaluation,
  type QuoteFinding,
} from '../src/modules/ai/quote/quote-types.ts';

/** 造一条命中：facts 里的数字就是「允许模型引用」的全集 */
function finding(over: Partial<QuoteFinding> = {}): QuoteFinding {
  return {
    code: QUOTE_CODES.B1_DROP_EXCESS,
    level: 'HIGH',
    entity: 'bidder',
    entityId: 'bid-1',
    taskId: 'task-1',
    taskNo: 'PROC-20261001-001',
    title: '二轮降幅 25.00% 超阈值（第一轮 1000000.00 元 → 第二轮 750000.00 元）',
    facts: ['第一轮不含税 1000000.00 元', '第二轮不含税 750000.00 元', '降幅 25.00%（阈值 20%）'],
    amountDiff: '250000.00',
    ...over,
  };
}

function evaluation(findings: QuoteFinding[], notEvaluated: string[] = []): QuoteEvaluation {
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

describe('报价预警阈值配置（ai.quote.*）', () => {
  it('参数全缺省时用默认阈值，且不报问题', () => {
    const cfg = parseQuoteConfig({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.narrative, true);
    assert.deepEqual(cfg.tolerances, DEFAULT_QUOTE_TOLERANCES);
    assert.deepEqual(cfg.problems, []);
  });

  it('正常值按填写生效（含金额容差 2.50 元与税率容差 30 基点）', () => {
    const cfg = parseQuoteConfig({
      [QUOTE_PARAM_KEYS.enabled]: '0',
      [QUOTE_PARAM_KEYS.narrative]: 'false',
      [QUOTE_PARAM_KEYS.amountTolerance]: '2.50',
      [QUOTE_PARAM_KEYS.dropPct]: '15',
      [QUOTE_PARAM_KEYS.spreadPct]: '2.5',
      [QUOTE_PARAM_KEYS.underBudgetPct]: '60',
      [QUOTE_PARAM_KEYS.priceDevPct]: '10',
      [QUOTE_PARAM_KEYS.taxRateToleranceBp]: '30',
      [QUOTE_PARAM_KEYS.minBidders]: '4',
    });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.narrative, false);
    assert.equal(cfg.tolerances.amount, 250n);
    assert.equal(cfg.tolerances.dropPct, 15);
    assert.equal(cfg.tolerances.spreadPct, 2.5);
    assert.equal(cfg.tolerances.underBudgetPct, 60);
    assert.equal(cfg.tolerances.priceDevPct, 10);
    assert.equal(cfg.tolerances.taxRateToleranceBp, 30);
    assert.equal(cfg.tolerances.minBidders, 4);
    assert.deepEqual(cfg.problems, []);
  });

  it('脏数据一律回落默认值并留下人话，绝不抛错', () => {
    const cfg = parseQuoteConfig({
      [QUOTE_PARAM_KEYS.enabled]: '开吧',
      [QUOTE_PARAM_KEYS.amountTolerance]: '一块钱',
      [QUOTE_PARAM_KEYS.dropPct]: 'abc',
      [QUOTE_PARAM_KEYS.minBidders]: '很多',
    });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.tolerances.amount, DEFAULT_QUOTE_TOLERANCES.amount);
    assert.equal(cfg.tolerances.dropPct, DEFAULT_QUOTE_TOLERANCES.dropPct);
    assert.equal(cfg.tolerances.minBidders, DEFAULT_QUOTE_TOLERANCES.minBidders);
    assert.equal(cfg.problems.length, 4);
    assert.ok(cfg.problems.every((p) => p.includes('按默认')));
  });

  it('越界值夹到边界并说明（降幅 300% → 100%，家数 99 → 20）', () => {
    const cfg = parseQuoteConfig({
      [QUOTE_PARAM_KEYS.dropPct]: '300',
      [QUOTE_PARAM_KEYS.minBidders]: '99',
    });
    assert.equal(cfg.tolerances.dropPct, 100);
    assert.equal(cfg.tolerances.minBidders, 20);
    assert.equal(cfg.problems.length, 2);
    assert.ok(cfg.problems[0].includes('超出可设范围'));
  });

  it('负金额容差回落默认（容差不能为负）', () => {
    const cfg = parseQuoteConfig({ [QUOTE_PARAM_KEYS.amountTolerance]: '-5' });
    assert.equal(cfg.tolerances.amount, DEFAULT_QUOTE_TOLERANCES.amount);
    assert.equal(cfg.problems.length, 1);
  });

  it('阈值文案把每个阈值都写成人话（面板与提示词共用）', () => {
    const text = quoteToleranceText(DEFAULT_QUOTE_TOLERANCES);
    assert.ok(text.includes('金额容差 1.00 元'));
    assert.ok(text.includes('二轮降幅 > 20%'));
    assert.ok(text.includes('首轮离散系数 < 3%'));
    assert.ok(text.includes('成交价 < 控制价 70%'));
    assert.ok(text.includes('单价偏离市场价 ±15%'));
    assert.ok(text.includes('0.30 个百分点'));
    assert.ok(text.includes('有效报价 < 3 家'));
  });
});

describe('报价预警措辞对账（模型不许编数字）', () => {
  it('照抄 facts 里的数字与编号 → 通过', () => {
    const ev = evaluation([finding()]);
    const unknown = auditQuoteNarrative(
      {
        conclusion:
          '采购任务 PROC-20261001-001 出现二轮降幅 25.00% 的情况，第一轮 1000000.00 元降到第二轮 750000.00 元，需要复核议价依据。',
        actions: ['核对第二轮降价的书面记录，确认 250000.00 元差额的构成。'],
      },
      ev,
    );
    assert.deepEqual(unknown, []);
  });

  it('凭空多出来的数字被挑出来（合计/占比这类模型自己算的）', () => {
    const ev = evaluation([finding()]);
    const unknown = auditQuoteNarrative(
      {
        conclusion: '本轮共 3 个任务存在异常，累计涉及金额 3000000.00 元，平均降幅 25.00%。',
        actions: ['复核。'],
      },
      ev,
    );
    // 3 是放行的计数词；3000000.00 不在 facts 里 → 必须被挑出
    assert.deepEqual(unknown, ['3000000']);
  });

  it('单据编号里的数字不会被误判（PROC-20261001-001 不算编造）', () => {
    const ev = evaluation([finding()]);
    const unknown = auditQuoteNarrative(
      { conclusion: '采购任务 PROC-20261001-001 存在异常。', actions: ['复核。'] },
      ev,
    );
    assert.deepEqual(unknown, []);
  });

  it('0~10 的计数词放行，11 及以上要能对上 facts', () => {
    const ev = evaluation([finding()]);
    assert.deepEqual(auditQuoteNarrative({ conclusion: '共 2 项存疑，另有 10 家参与。', actions: ['复核。'] }, ev), []);
    assert.deepEqual(auditQuoteNarrative({ conclusion: '共 12 项存疑。', actions: ['复核。'] }, ev), ['12']);
  });
});

describe('报价预警模板兜底（面板永不空窗）', () => {
  it('0 命中时明确写出「未命中」，而不是含糊其辞', () => {
    const n = fallbackQuoteNarrative(evaluation([]));
    assert.ok(n.conclusion.includes('未命中'));
    assert.equal(n.actions.length, 1);
  });

  it('有命中时按等级与类型汇总，并列出优先处理项', () => {
    const n = fallbackQuoteNarrative(
      evaluation([
        finding(),
        finding({ code: QUOTE_CODES.B6_NOT_LOWEST, level: 'MEDIUM', title: '成交价非最低有效报价（高于最低价 50000.00 元）' }),
      ]),
    );
    assert.ok(n.conclusion.includes('命中 2 项'));
    assert.ok(n.conclusion.includes('高风险 1 项'));
    assert.ok(n.conclusion.includes('需复核 1 项'));
    assert.ok(n.conclusion.includes('二轮降幅超阈值 1 项'));
    assert.ok(n.conclusion.includes('成交价非最低有效报价 1 项'));
    assert.ok(n.conclusion.includes('优先处理'));
    assert.ok(n.actions.length >= 3);
  });

  it('有未判定规则时必须在结论里说明覆盖范围', () => {
    const n = fallbackQuoteNarrative(evaluation([finding()], ['B2 未判定：任务 PROC-20261001-001 有效报价不足 2 家']));
    assert.ok(n.conclusion.includes('1 条规则因口径缺失未参与判定'));
  });
});

describe('报价预警提示词拼装', () => {
  it('包含范围、样本、阈值、命中清单与未判定清单，且命中不截断', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      finding({ entityId: `bid-${i}`, title: `响应单位 ${i} 二轮降幅 25.00% 超阈值` }),
    );
    const messages = buildQuoteMessages({
      scope: '本项目全部采购任务（2 个）',
      sample: { 采购任务: 2, 响应单位: 6 },
      toleranceText: quoteToleranceText(DEFAULT_QUOTE_TOLERANCES),
      evaluation: evaluation(many, ['B4 未判定：价格对比表未发布']),
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    const user = messages[1].content as string;
    assert.ok(user.includes('本项目全部采购任务（2 个）'));
    assert.ok(user.includes('采购任务 2，响应单位 6'));
    assert.ok(user.includes('二轮降幅 > 20%'));
    assert.ok(user.includes('共 12 项（高风险 12，需复核 0）'));
    // 12 行命中（`- [高风险]`）+ 1 行未判定（`- B4 …`），全部保留、不截断
    assert.equal(user.split('\n').filter((l) => l.startsWith('- ')).length, 13);
    assert.ok(user.includes('B4 未判定：价格对比表未发布'));
    assert.ok(!user.includes('（无，全部规则已判定）'));
  });

  it('0 命中时提示词仍说明「已判定全部规则」，避免模型误以为没跑', () => {
    const messages = buildQuoteMessages({
      scope: '采购任务 PROC-20261001-002',
      sample: { 采购任务: 1 },
      toleranceText: quoteToleranceText(DEFAULT_QUOTE_TOLERANCES),
      evaluation: evaluation([]),
    });
    const user = messages[1].content as string;
    assert.ok(user.includes('（无，全部规则已判定）'));
    assert.ok(user.includes('共 0 项'));
  });

  it('system 里写着不许算数、不许法律定性、不许声称核对原始单据', () => {
    const messages = buildQuoteMessages({
      scope: 'x',
      sample: {},
      toleranceText: 'y',
      evaluation: evaluation([]),
    });
    const sys = messages[0].content as string;
    assert.ok(sys.includes('不得计算任何新的数字'));
    assert.ok(sys.includes('不得给出法律定性结论'));
    assert.ok(sys.includes('不得声称已核对原始报价单'));
    assert.ok(sys.includes('"conclusion"'));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  centsToYuan,
  moneyToCents,
  parseScaled,
  qtyToUnits,
  ratioToBp,
  resolveTolerances,
  unitsToQty,
  ANOMALY_CODES,
  DEFAULT_TOLERANCES,
  type PaymentAnomalyInput,
} from '../src/modules/ai/anomaly/anomaly-types.ts';
import {
  evaluatePaymentAnomalies,
  r1aDuplicateAcrossPeriod,
  r1bDuplicateMaterialQty,
  r2Overpay,
  summarizeFindings,
} from '../src/modules/ai/anomaly/rules-payment.ts';
import { cleanPaymentFixture, paymentAnomalyFixture } from './fixtures/ai-anomaly-payment.fixture.mts';

/**
 * AI 预警 · 结算/付款异常（矩阵课题 6-9）的**规则真值测试**。
 *
 * 这里锁的是四类最容易反复退化的东西：
 * ① **金额不走浮点**：`Decimal(18,2)` 的边界（恰好等于上限、分位四舍五入、千分位、负数）；
 * ② **8 条规则各自该命中/不该命中**：靠夹具里「脏数据 10 命中 / 净数据 0 命中」双向对锁，
 *    只锁一边（比如只测命中）会让调阈值的人悄悄放大误报；
 * ③ **缺口径必须显式说出来**（`notEvaluated`）——「0 命中」不等于「账没问题」；
 * ④ **输出确定性**：同输入两次跑结果逐字相同（面板/通知/快照测试都依赖它）。
 */

// ---------------------------------------------------------------------------
// 一、金额与数量原语
// ---------------------------------------------------------------------------

describe('anomaly · 金额原语（分，不经浮点）', () => {
  it('Decimal 字符串 / number / 千分位 / 空值', () => {
    assert.equal(moneyToCents('100000.00'), 10_000_000n);
    assert.equal(moneyToCents(100000), 10_000_000n);
    assert.equal(moneyToCents('1,234.50'), 123_450n);
    assert.equal(moneyToCents({ toString: () => '12.30' }), 1_230n);
    // 未填 ≠ 0：三态必须保住
    assert.equal(moneyToCents(null), null);
    assert.equal(moneyToCents(undefined), null);
    assert.equal(moneyToCents(''), null);
    assert.equal(moneyToCents('abc'), null);
  });

  it('超过 2^53 的金额不丢精度（这是必须用 bigint 的理由）', () => {
    // 9999999999999999.99 → 分 = 999999999999999999，远超 Number.MAX_SAFE_INTEGER
    assert.equal(moneyToCents('9999999999999999.99'), 999_999_999_999_999_999n);
    assert.equal(centsToYuan(999_999_999_999_999_999n), '9999999999999999.99');
  });

  it('分位半进位（≥5 进一），负数保留符号', () => {
    assert.equal(parseScaled('0.005', 2), 1n);
    assert.equal(parseScaled('0.004', 2), 0n);
    assert.equal(parseScaled('-0.005', 2), -1n);
    assert.equal(centsToYuan(-1_230n), '-12.30');
    assert.equal(centsToYuan(0n), '0.00');
  });

  it('数量按 1e-4 单位，字符串输出去尾零但不丢位', () => {
    assert.equal(qtyToUnits('100.0000'), 1_000_000n);
    assert.equal(qtyToUnits('0.0001'), 1n);
    assert.equal(unitsToQty(1_000_000n), '100');
    assert.equal(unitsToQty(1_234_500n), '123.45');
    assert.equal(unitsToQty(1n), '0.0001');
  });

  it('付款比例只接受 0~1 小数，越界/空值一律 null（宁可漏报）', () => {
    assert.equal(ratioToBp('0.8'), 8_000);
    assert.equal(ratioToBp(0.65), 6_500);
    assert.equal(ratioToBp('1'), 10_000);
    assert.equal(ratioToBp(null), null);
    assert.equal(ratioToBp('0'), null);
    // 13 是「13%」的常见误填：绝不能当 13 倍比例用
    assert.equal(ratioToBp(13), null);
    assert.equal(ratioToBp('1.3'), null);
  });

  it('默认阈值可被局部覆盖', () => {
    assert.equal(resolveTolerances().amount, DEFAULT_TOLERANCES.amount);
    assert.equal(resolveTolerances({ amount: 0n }).amount, 0n);
    assert.equal(resolveTolerances({ qtyPct: 0 }).qtyPct, 0);
  });
});

// ---------------------------------------------------------------------------
// 二、夹具全量：脏数据 10 命中、净数据 0 命中
// ---------------------------------------------------------------------------

describe('anomaly · 8 条规则（夹具真值）', () => {
  it('脏数据：命中数与分规则计数、等级分布与预期一致', () => {
    const { input, expected } = paymentAnomalyFixture();
    const evaluation = evaluatePaymentAnomalies(input);
    assert.equal(evaluation.summary.total, expected.total);
    assert.equal(evaluation.summary.high, expected.high);
    assert.equal(evaluation.summary.medium, expected.medium);
    assert.deepEqual(evaluation.summary.byCode, expected.byCode);
  });

  it('脏数据：缺口径必须进 notEvaluated（草稿合同没有付款比例）', () => {
    const { input, expected } = paymentAnomalyFixture();
    const { notEvaluated } = evaluatePaymentAnomalies(input);
    for (const fragment of expected.notEvaluatedIncludes) {
      assert.ok(
        notEvaluated.some((msg) => msg.includes(fragment)),
        `notEvaluated 应包含「${fragment}」，实际：${JSON.stringify(notEvaluated)}`,
      );
    }
  });

  it('净数据：账、票、手续全对时 0 命中（防误报）', () => {
    const { input, expected } = cleanPaymentFixture();
    const evaluation = evaluatePaymentAnomalies(input);
    assert.equal(evaluation.summary.total, expected.total);
    assert.deepEqual(evaluation.findings, []);
    assert.deepEqual(evaluation.notEvaluated, []);
  });

  it('输出确定性：两次调用逐字相同，且高风险排在前面', () => {
    const { input } = paymentAnomalyFixture();
    const first = evaluatePaymentAnomalies(input);
    const second = evaluatePaymentAnomalies(input);
    assert.deepEqual(first, second);
    const levels = first.findings.map((f) => f.level);
    const lastHigh = levels.lastIndexOf('HIGH');
    const firstMedium = levels.indexOf('MEDIUM');
    assert.ok(lastHigh === -1 || firstMedium === -1 || lastHigh < firstMedium, 'HIGH 必须全部排在 MEDIUM 之前');
  });

  it('每条命中都有非空标题与 facts，且金额口径为元字符串', () => {
    const { input } = paymentAnomalyFixture();
    const { findings } = evaluatePaymentAnomalies(input);
    for (const finding of findings) {
      assert.ok(finding.title.length > 0, `${finding.code} 缺标题`);
      assert.ok(Object.keys(finding.facts).length > 0, `${finding.code} 缺 facts`);
      for (const [label, value] of Object.entries(finding.facts)) {
        assert.equal(typeof value, 'string', `${finding.code}.${label} 必须是字符串`);
        assert.ok(!/NaN|Infinity|undefined/.test(value), `${finding.code}.${label} 出现异常值：${value}`);
      }
      if (finding.amountDiff !== null) {
        assert.match(finding.amountDiff, /^-?\d+\.\d{2}$/, `${finding.code}.amountDiff 必须是两位小数的元字符串`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 三、逐规则定向（避免某条规则被整体计数掩盖）
// ---------------------------------------------------------------------------

describe('anomaly · 逐规则定向', () => {
  it('R1-a：同金额 + 明细重合才报；仅金额相同不算', () => {
    const ctx = { tol: resolveTolerances(), notEvaluated: [] as string[] };
    const base = {
      id: 'A',
      contractId: 'C1',
      code: 'A',
      actualAmount: '100000.00',
      settleDate: new Date(2026, 2, 31),
      statusCode: 'CONFIRMED',
      items: [
        { materialBaseId: 'M1', qty: '10.0000' },
        { materialBaseId: 'M2', qty: '10.0000' },
      ],
    };
    const sameFingerprint = { ...base, id: 'B', code: 'B', settleDate: new Date(2026, 3, 30) };
    const otherMaterials = {
      ...base,
      id: 'D',
      code: 'D',
      settleDate: new Date(2026, 4, 31),
      items: [{ materialBaseId: 'M9', qty: '10.0000' }],
    };
    const onlyDuplicate = r1aDuplicateAcrossPeriod([base, sameFingerprint], ctx).findings;
    assert.equal(onlyDuplicate.length, 1);
    // 报「后一张」：核查动作发生在最新单据上
    assert.equal(onlyDuplicate[0].entityId, 'B');

    const noOverlap = r1aDuplicateAcrossPeriod([base, otherMaterials], ctx).findings;
    assert.equal(noOverlap.length, 0, '明细完全不重合不应判重复');

    // 草稿单不参与
    const withDraft = r1aDuplicateAcrossPeriod(
      [base, { ...sameFingerprint, statusCode: 'DRAFT' }],
      ctx,
    ).findings;
    assert.equal(withDraft.length, 0);
  });

  it('R1-b：跨单累计超清单量才报，容差内不报', () => {
    const ctx = { tol: resolveTolerances(), notEvaluated: [] as string[] };
    const materials = [{ contractId: 'C1', materialBaseId: 'M1', qty: '100.0000', name: '螺纹钢' }];
    const two = (qty: string) =>
      ['S1', 'S2'].map((id, index) => ({
        id,
        contractId: 'C1',
        code: id,
        actualAmount: '1000.00',
        settleDate: new Date(2026, 2 + index, 28),
        statusCode: 'CONFIRMED',
        items: [{ materialBaseId: 'M1', qty }],
      }));
    // 60 + 60 = 120 > 102 → 报
    const over = r1bDuplicateMaterialQty(two('60.0000'), materials, ctx).findings;
    assert.equal(over.length, 1);
    assert.equal(over[0].facts['累计已结量'], '120');
    assert.equal(over[0].facts['合同链清单量'], '100');
    // 50 + 50 = 100 ≤ 102 → 不报（等于清单量是正常的）
    const ok = r1bDuplicateMaterialQty(two('50.0000'), materials, ctx).findings;
    assert.equal(ok.length, 0);

    // 没有清单量口径 → 不判，并且必须说出来
    const ctx2 = { tol: resolveTolerances(), notEvaluated: [] as string[] };
    assert.equal(r1bDuplicateMaterialQty(two('60.0000'), undefined, ctx2).findings.length, 0);
    assert.ok(ctx2.notEvaluated.some((m) => m.startsWith('R1-b')));
  });

  it('R2：等于比例上限不算超付，超出容差即报', () => {
    const input = (paid: string): PaymentAnomalyInput => ({
      contracts: [{ id: 'C1', code: 'HT-1', status: 'SIGNED', currentPayRatio: '0.8' }],
      settlements: [
        {
          id: 'S1',
          contractId: 'C1',
          actualAmount: '100000.00',
          settleDate: new Date(2026, 2, 31),
          statusCode: 'CONFIRMED',
        },
      ],
      payments: [{ id: 'P1', contractId: 'C1', amount: paid, payDate: new Date(2026, 3, 10), statusCode: 'PAID' }],
      invoices: [],
    });
    const exact = r2Overpay(input('80000.00'), { tol: resolveTolerances(), notEvaluated: [] });
    assert.equal(exact.findings.length, 0, '付款恰好等于上限不应判超付');

    // 容差 1 元内的分位差视为四舍五入噪声，超出才报
    const withinTolerance = r2Overpay(input('80000.01'), { tol: resolveTolerances(), notEvaluated: [] });
    assert.equal(withinTolerance.findings.length, 0);

    const over = r2Overpay(input('80001.01'), { tol: resolveTolerances(), notEvaluated: [] });
    assert.equal(over.findings.length, 1);
    assert.equal(over.findings[0].facts['应付上限'], '80000.00');
    assert.equal(over.findings[0].amountDiff, '1.01');

    // 失败付款不计入累计
    const failed = r2Overpay(
      {
        ...input('80000.00'),
        payments: [{ id: 'P1', contractId: 'C1', amount: '999999.00', payDate: new Date(2026, 3, 10), statusCode: 'FAILED' }],
      },
      { tol: resolveTolerances(), notEvaluated: [] },
    );
    assert.equal(failed.findings.length, 0);
  });

  it('汇总：按等级与规则码计数', () => {
    const { input } = paymentAnomalyFixture();
    const { findings, summary } = evaluatePaymentAnomalies(input);
    assert.equal(summary.total, findings.length);
    assert.equal(summary.high + summary.medium, findings.length);
    const rebuilt = summarizeFindings(findings);
    assert.deepEqual(rebuilt, summary);
    assert.equal(summary.byCode[ANOMALY_CODES.R3_PAY_WITHOUT_CONTRACT], 3);
  });
});

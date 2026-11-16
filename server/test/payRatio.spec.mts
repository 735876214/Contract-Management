import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYMENT_MODES,
  CUSTOM_PAYMENT_MODE,
  modeTranchesOf,
  monthlyRatioOfMode,
  resolveEffectivePayRatio,
  EXEC_STATUS_DONE_SETTLED,
} from '../src/common/utils/pay-ratio.ts';
import { PAYMENT_MODE_OPTIONS, CUSTOM_PAYMENT_MODE as WEB_CUSTOM } from '../../web/src/constants/paymentModes.ts';

/**
 * **付款安排与「当前生效比例」的锁**（业务口径 2026-10-16）。
 *
 * 三件事容易悄悄坏掉，所以都钉住：
 * ① 新增的两种月度安排的**分期与比例**（`M65_1` 次月 30 日 65%；`M65_3` 次月/次次月/次次次月 20/20/25）；
 * ② 「当前生效比例」的四条规则（已完已结 → 100%；按安排；自定义取手填；推不出 → `null` 不覆盖）；
 * ③ **前后端镜像**：下拉里的文案就是这里定义的 label，两边不一致会出现"同一种安排两个名字"。
 */

describe('付款安排：分期与月度比例', () => {
  it('存量的 100 / 3382 保持不变（改了会连带改动已算出的逾期利息）', () => {
    assert.deepEqual(modeTranchesOf('100'), [{ ratio: 1, plusMonths: 1, day: 25 }]);
    assert.deepEqual(modeTranchesOf('3382'), [
      { ratio: 0.8, plusMonths: 3, day: 25 },
      { ratio: 0.2, plusMonths: 6, day: 25 },
    ]);
    assert.equal(monthlyRatioOfMode('100'), 1);
    assert.equal(monthlyRatioOfMode('3382'), 1);
  });

  it('M65_1：当月结算后次月 30 日前付 65%', () => {
    assert.deepEqual(modeTranchesOf('M65_1'), [{ ratio: 0.65, plusMonths: 1, day: 30 }]);
    assert.equal(monthlyRatioOfMode('M65_1'), 0.65);
  });

  it('M65_3：次月 20% + 次次月 20% + 次次次月 25%（合计 65%）', () => {
    const t = modeTranchesOf('M65_3')!;
    assert.equal(t.length, 3);
    assert.deepEqual(
      t.map((x) => [x.ratio, x.plusMonths]),
      [
        [0.2, 1],
        [0.2, 2],
        [0.25, 3],
      ],
    );
    assert.equal(monthlyRatioOfMode('M65_3'), 0.65, '0.2+0.2+0.25 的浮点求和必须回到 0.65');
  });

  it('自定义 / 未知 / 空 → null（不是 0：0 会被下游当成"一分钱都不用付"）', () => {
    assert.equal(modeTranchesOf(CUSTOM_PAYMENT_MODE), null);
    assert.equal(monthlyRatioOfMode(CUSTOM_PAYMENT_MODE), null);
    assert.equal(monthlyRatioOfMode(null), null);
    assert.equal(monthlyRatioOfMode(undefined), null);
    assert.equal(monthlyRatioOfMode('不存在的模式'), null);
  });
});

describe('当前生效比例（派生列）', () => {
  it('已完已结 → 100%（总结算节点），压过月度安排', () => {
    assert.equal(resolveEffectivePayRatio({ execStatus: EXEC_STATUS_DONE_SETTLED, paymentMode: 'M65_1' }), 1);
    assert.equal(resolveEffectivePayRatio({ execStatus: EXEC_STATUS_DONE_SETTLED, paymentMode: null }), 1);
  });

  it('未办理总结算 → 按付款安排', () => {
    assert.equal(resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: 'M65_1' }), 0.65);
    assert.equal(resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: 'M65_3' }), 0.65);
    assert.equal(resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: '100' }), 1);
  });

  it('自定义安排 → 用手填的月度结算办理比例', () => {
    assert.equal(
      resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: CUSTOM_PAYMENT_MODE, customRatio: 0.7 }),
      0.7,
    );
    // 字面量形式的比例（来自 Decimal 字段的字符串）也要认
    assert.equal(
      resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: CUSTOM_PAYMENT_MODE, customRatio: '0.55' }),
      0.55,
    );
  });

  it('推不出来 → null（调用方保持原值不动，"未知"不该被改写成某个数）', () => {
    assert.equal(resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: null }), null);
    assert.equal(resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: '自定义乱填' }), null);
    assert.equal(
      resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: CUSTOM_PAYMENT_MODE, customRatio: null }),
      null,
    );
    // 手填 0 只可能是没填或填错（比例 0 = 永不付款）→ 一并按"推不出"处理
    assert.equal(
      resolveEffectivePayRatio({ execStatus: 'IN_PROGRESS', paymentMode: CUSTOM_PAYMENT_MODE, customRatio: 0 }),
      null,
    );
  });
});

describe('前后端镜像：付款安排选项', () => {
  it('取值集合完全一致（后端少了 → 前端能选但服务端 400；后端多了 → 前端选不到）', () => {
    const backend = Object.keys(PAYMENT_MODES).sort();
    const front = PAYMENT_MODE_OPTIONS.map((o) => o.value)
      .filter((v) => v !== CUSTOM_PAYMENT_MODE)
      .sort();
    assert.deepEqual(front, backend, 'web/src/constants/paymentModes.ts 与 pay-ratio.ts 的取值必须一致');
  });

  it('label 逐条相等（下拉里显示的就是它，不一致会出现"同一安排两个名字"）', () => {
    for (const [value, def] of Object.entries(PAYMENT_MODES)) {
      const hit = PAYMENT_MODE_OPTIONS.find((o) => o.value === value);
      assert.ok(hit, `前端缺少付款安排 ${value}`);
      assert.equal(hit!.label, def.label, `付款安排 ${value} 的说明文案前后端不一致`);
    }
  });

  it('自定义的常量名两侧同值', () => {
    assert.equal(WEB_CUSTOM, CUSTOM_PAYMENT_MODE);
    assert.ok(PAYMENT_MODE_OPTIONS.some((o) => o.value === CUSTOM_PAYMENT_MODE), '自定义选项必须在下拉里');
  });
});

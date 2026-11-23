import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANOMALY_WINDOW_BOUNDS,
  ANOMALY_WINDOW_DEFAULTS,
  countWindowMonths,
  defaultWindowStart,
  overLimitMessage,
  resolveAnomalyWindow,
  resolveWindowLimits,
  type ResolvedAnomalyWindow,
} from '../src/modules/ai-insight/anomaly/anomaly-window.ts';

/**
 * AI 预警 · **取数区间口径**的锁（P1-4 第三阶段）。
 *
 * 这些断言守的是「成本闸门 + 诚实性」两件容易被无声改坏的事：
 * ① **默认近 12 个自然月**：不给区间时不能悄悄变成「全史扫描」（那是 20,000 份合同级别的取数）；
 * ② **超上限必须拒绝**（除非人工 force）：截断会让结论看起来完整、实际少算单据，财务场景里比报错危险；
 * ③ **自然月计数含首尾**：按天数算会在月末/闰年上把「近 12 个月」算成 13 个月；
 * ④ **日期按本地零点解析**：`new Date('2026-01-01')` 是 UTC，容器 TZ=Asia/Shanghai 下会漏掉首日 0–8 点。
 *
 * 固定 `now` = 2026-11-22 10:30（本地），所有期望值可手算复核。
 */
const NOW = new Date(2026, 10, 22, 10, 30, 0, 0);

/** 取成功分支（失败分支直接 assert.ok 报错，不用非空断言糊过去） */
function okWindow(outcome: ReturnType<typeof resolveAnomalyWindow>): ResolvedAnomalyWindow {
  assert.equal(outcome.ok, true, `期望解析成功，实际被拒：${JSON.stringify(outcome)}`);
  return (outcome as { ok: true; window: ResolvedAnomalyWindow }).window;
}

describe('anomaly-window · 默认区间与自然月计数', () => {
  it('不给区间：默认近 12 个自然月（含本月，末端到今天收尾）', () => {
    const w = okWindow(resolveAnomalyWindow({}, NOW));
    assert.equal(w.fromDay, '2025-12-01');
    assert.equal(w.toDay, '2026-11-22');
    assert.equal(w.months, 12);
    assert.equal(w.defaulted, true);
    assert.equal(w.overLimit, false);
    assert.equal(w.forced, false);
    assert.equal(w.maxMonths, ANOMALY_WINDOW_DEFAULTS.maxMonths);
    // 末端必须是当日末刻：库里 settleDate/payDate 带时分秒，比 00:00:00 会漏掉末日单据
    assert.equal(w.to.getHours(), 23);
    assert.equal(w.to.getMinutes(), 59);
  });

  it('只给 to：起点按默认跨度以 to 为锚回推；只给 from：终点取今天收尾', () => {
    const onlyTo = okWindow(resolveAnomalyWindow({ to: '2026-06-30' }, NOW));
    assert.equal(onlyTo.fromDay, '2025-07-01');
    assert.equal(onlyTo.toDay, '2026-06-30');
    assert.equal(onlyTo.months, 12);
    assert.equal(onlyTo.defaulted, false, '只补了一端不算「系统默认区间」');

    const onlyFrom = okWindow(resolveAnomalyWindow({ from: '2026-09-01' }, NOW));
    assert.equal(onlyFrom.fromDay, '2026-09-01');
    assert.equal(onlyFrom.toDay, '2026-11-22');
    assert.equal(onlyFrom.months, 3);
  });

  it('自然月计数含首尾（只看年月差）', () => {
    const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);
    assert.equal(countWindowMonths(d(2026, 11, 1), d(2026, 11, 30)), 1);
    assert.equal(countWindowMonths(d(2026, 1, 1), d(2026, 12, 31)), 12);
    assert.equal(countWindowMonths(d(2026, 1, 20), d(2026, 2, 3)), 2, '跨月即两月：不能按天数折算');
    assert.equal(countWindowMonths(d(2025, 1, 1), d(2026, 12, 31)), 24);
  });

  it('默认起点的锚点语义：往回数 N-1 个月的首日', () => {
    assert.equal(defaultWindowStart(new Date(2026, 10, 22), 12).getDate(), 1);
    assert.equal(defaultWindowStart(new Date(2026, 10, 22), 12).getMonth(), 11, '11 月往回数 12 个月 = 去年 12 月');
    assert.equal(defaultWindowStart(new Date(2026, 10, 22), 12).getFullYear(), 2025);
    assert.equal(defaultWindowStart(new Date(2026, 0, 5), 1).getTime(), new Date(2026, 0, 1).getTime());
  });
});

describe('anomaly-window · 日期解析与硬错误', () => {
  it('日期按本地零点解析（不按 UTC 解析后再偏移）', () => {
    const w = okWindow(resolveAnomalyWindow({ from: '2026-01-01', to: '2026-01-31' }, NOW));
    assert.equal(w.from.getFullYear(), 2026);
    assert.equal(w.from.getMonth(), 0);
    assert.equal(w.from.getDate(), 1, 'new Date("2026-01-01") 会按 UTC 落到 2025-12-31 16:00（本地）');
    assert.equal(w.from.getHours(), 0);
    assert.equal(w.months, 1);
  });

  it('非法日期 / 起止颠倒 → 拒绝，且文案带上原值', () => {
    const badFrom = resolveAnomalyWindow({ from: '2026/01/01' }, NOW);
    assert.equal(badFrom.ok, false);
    assert.equal((badFrom as any).reason, 'invalidFrom');
    assert.ok((badFrom as any).message.includes('2026/01/01'));

    const badTo = resolveAnomalyWindow({ to: '2026-13-01' }, NOW);
    assert.equal(badTo.ok, false);
    assert.equal((badTo as any).reason, 'invalidTo');

    const reversed = resolveAnomalyWindow({ from: '2026-07-01', to: '2026-06-30' }, NOW);
    assert.equal(reversed.ok, false);
    assert.equal((reversed as any).reason, 'reversed');
    assert.ok((reversed as any).message.includes('2026-07-01'));
  });

  it('硬错误不因 force=1 而放行（force 只解上限，不解参数错）', () => {
    for (const q of [{ from: 'bad', force: true }, { to: '2026-13-01', force: true }]) {
      assert.equal(resolveAnomalyWindow(q, NOW).ok, false);
    }
  });
});

describe('anomaly-window · 上限判定与人工确认', () => {
  it('正好等于上限不超；超一个月就超', () => {
    const atLimit = okWindow(resolveAnomalyWindow({ from: '2025-01-01', to: '2026-12-31' }, NOW));
    assert.equal(atLimit.months, 24);
    assert.equal(atLimit.overLimit, false, '恰好等于上限不算超（与金额上限同口径）');

    const over = okWindow(resolveAnomalyWindow({ from: '2024-12-01', to: '2026-12-31' }, NOW));
    assert.equal(over.months, 25);
    assert.equal(over.overLimit, true);
    assert.equal(over.forced, false, '没带 force 就是未确认，调用方据此 400');
  });

  it('带 force=1：放行但标记 forced（调用方要写进 warnings）', () => {
    const forced = okWindow(resolveAnomalyWindow({ from: '2020-01-01', to: '2026-12-31', force: true }, NOW));
    assert.equal(forced.months, 84);
    assert.equal(forced.overLimit, true);
    assert.equal(forced.forced, true);

    // 未超限时 force=1 不应被标成「确认过」：面板据此区分「本来就没超」与「超了但放行」
    assert.equal(okWindow(resolveAnomalyWindow({ from: '2026-01-01', to: '2026-06-30', force: true }, NOW)).forced, false);
  });

  it('上限文案说全三件事：超了多少 / 上限多少 / 怎么继续', () => {
    const msg = overLimitMessage(36, 24);
    assert.ok(msg.includes('36'), `缺「超了多少」：${msg}`);
    assert.ok(msg.includes('24'), `缺「上限多少」：${msg}`);
    assert.ok(msg.includes('force=1'), `缺「怎么继续」：${msg}`);
  });
});

describe('anomaly-window · 参数夹逼（系统参数写错不能把接口搞死）', () => {
  it('缺省取 12 / 24；非法值回落默认', () => {
    assert.deepEqual(resolveWindowLimits(), { defaultMonths: 12, maxMonths: 24 });
    assert.deepEqual(resolveWindowLimits({ defaultMonths: NaN, maxMonths: NaN }), { defaultMonths: 12, maxMonths: 24 });
  });

  it('越界夹到 [minMonths, maxMonthsUpper]，小数四舍五入', () => {
    assert.equal(resolveWindowLimits({ defaultMonths: 0 }).defaultMonths, ANOMALY_WINDOW_BOUNDS.minMonths);
    assert.equal(resolveWindowLimits({ maxMonths: 9999 }).maxMonths, ANOMALY_WINDOW_BOUNDS.maxMonthsUpper);
    assert.equal(resolveWindowLimits({ defaultMonths: 6.4 }).defaultMonths, 6);
  });

  it('上限小于默认 → 抬到默认（否则默认一开就超限，配置没有可执行语义）', () => {
    const lim = resolveWindowLimits({ defaultMonths: 12, maxMonths: 3 });
    assert.equal(lim.maxMonths, 12);
    // 抬完之后默认区间本身必须能通过（不 overLimit）
    const w = okWindow(resolveAnomalyWindow({}, NOW, lim));
    assert.equal(w.overLimit, false);
  });

  it('夹逼后的上限参与判定：默认 12 / 上限 6 被抬成 12/12，默认区间才刚好不超', () => {
    const w = okWindow(resolveAnomalyWindow({}, NOW, { defaultMonths: 12, maxMonths: 6 }));
    // 夹逼把 max 抬到 12（见上一条），所以这里不会超限 —— 锁住这个「自洽修正」而不是它被悄悄去掉
    assert.equal(w.maxMonths, 12);
    assert.equal(w.overLimit, false);

    const tighter = okWindow(resolveAnomalyWindow({}, NOW, { defaultMonths: 3, maxMonths: 3 }));
    assert.equal(tighter.months, 3);
    assert.equal(tighter.maxMonths, 3);
    assert.equal(tighter.overLimit, false);
  });
});

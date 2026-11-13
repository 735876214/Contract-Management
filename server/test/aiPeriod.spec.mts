import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareRange,
  endOfDay,
  inRange,
  localDayKey,
  parseLocalDay,
  rangeLabel,
  resolvePresetPeriod,
} from '../src/modules/ai/common/period.ts';

/** 固定「现在」= 2026-11-12 09:30（本地），保证预设期间断言可复算 */
const NOW = new Date(2026, 10, 12, 9, 30, 0, 0);

describe('AI 经营数据助手 · 期间原语', () => {
  it('本月 / 上月 / 本季度 / 今年 / 年初至今', () => {
    const thisMonth = resolvePresetPeriod('this_month', NOW)!;
    assert.equal(localDayKey(thisMonth.from!), '2026-11-01');
    assert.equal(localDayKey(thisMonth.to), '2026-11-12');

    const lastMonth = resolvePresetPeriod('last_month', NOW)!;
    assert.equal(localDayKey(lastMonth.from!), '2026-10-01');
    assert.equal(localDayKey(lastMonth.to), '2026-10-31');

    const quarter = resolvePresetPeriod('this_quarter', NOW)!;
    assert.equal(localDayKey(quarter.from!), '2026-10-01');

    for (const preset of ['this_year', 'ytd'] as const) {
      const r = resolvePresetPeriod(preset, NOW)!;
      assert.equal(localDayKey(r.from!), '2026-01-01');
    }
  });

  it('近 30 / 90 天按本地日回退（含今天）', () => {
    const d30 = resolvePresetPeriod('last_30_days', NOW)!;
    assert.equal(localDayKey(d30.from!), '2026-10-14');
    const d90 = resolvePresetPeriod('last_90_days', NOW)!;
    assert.equal(localDayKey(d90.from!), '2026-08-15');
    assert.equal(d30.to.getTime(), endOfDay(NOW).getTime());
  });

  it('累计至今没有起点；自定义期间按本地零点并含结束日', () => {
    const all = resolvePresetPeriod('all', NOW)!;
    assert.equal(all.from, null);

    const custom = resolvePresetPeriod('custom', NOW, { from: '2026-01-01', to: '2026-06-30' })!;
    assert.equal(localDayKey(custom.from!), '2026-01-01');
    assert.equal(localDayKey(custom.to), '2026-06-30');
    assert.equal(custom.to.getHours(), 23);

    assert.equal(resolvePresetPeriod('custom', NOW, { from: '2026-01-01' }), null);
    assert.equal(resolvePresetPeriod('custom', NOW, { from: '2026-07-01', to: '2026-06-30' }), null);
  });

  it('环比 = 紧邻本期之前、等长；同比 = 起止各回退一年', () => {
    const range = resolvePresetPeriod('this_month', NOW)!;
    const mom = compareRange(range, 'mom')!;
    assert.equal(mom.to.getTime(), range.from!.getTime() - 1);
    assert.equal(
      mom.to.getTime() - mom.from!.getTime(),
      range.to.getTime() - range.from!.getTime(),
    );

    const yoy = compareRange(range, 'yoy')!;
    assert.equal(localDayKey(yoy.from!), '2025-11-01');
    assert.equal(localDayKey(yoy.to), '2025-11-12');
  });

  it('无参照期：none / 累计至今 → null（展示为 -，不当作下降 100%）', () => {
    const range = resolvePresetPeriod('this_month', NOW)!;
    assert.equal(compareRange(range, 'none'), null);
    assert.equal(compareRange(resolvePresetPeriod('all', NOW)!, 'mom'), null);
    assert.equal(compareRange(resolvePresetPeriod('all', NOW)!, 'yoy'), null);
  });

  it('标签与区间判断：空日期不落任何区间', () => {
    assert.ok(rangeLabel(resolvePresetPeriod('all', NOW)!).includes('累计至今'));
    const range = resolvePresetPeriod('this_month', NOW)!;
    assert.ok(rangeLabel(range).includes('2026-11-01 ~ 2026-11-12'));
    assert.equal(inRange(null, range), false);
    assert.equal(inRange(new Date(2026, 10, 12, 23, 59), range), true);
    assert.equal(inRange(new Date(2026, 9, 31), range), false);
    // 累计至今（无起点）：空日期也计入；限定期间则不计——与采集器的历史行口径一致
    const all = resolvePresetPeriod('all', NOW)!;
    assert.equal(inRange(null, all), true);
    assert.equal(inRange(new Date(2020, 0, 1), all), true);
  });

  it('日期串解析：必须是 YYYY-MM-DD，非法返回 null', () => {
    assert.equal(localDayKey(parseLocalDay('2026-02-03')!), '2026-02-03');
    assert.equal(parseLocalDay('2026/02/03'), null);
    assert.equal(parseLocalDay('2026-13-01'), null);
    assert.equal(parseLocalDay(''), null);
  });
});

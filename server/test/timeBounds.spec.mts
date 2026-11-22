import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startOfDay, endOfDay, nextDayStart, formatDay } from '../src/common/calc/time.ts';

/**
 * 列表筛选的日期区间边界（`startOfDay` / `endOfDay` / `nextDayStart`）。
 *
 * 起因（2026-11-22 质量审计）：同一个「结束日期」在全仓有三种写法 ——
 * `new Date(query.endDate)`（7 处）、手拼 `T23:59:59`（asset）、就地 `setHours`（system）。
 * 前一种走 **UTC** 解析（本地 08:00），库里若存的是本地 00:00 的记录，当天 00:00–08:00 会被漏掉；
 * 后两种虽然对，但各自为政、改一处漏两处。本 spec 锁住「本地日」这一单一实现。
 *
 * 断言全部用**本地时间**取值（`getHours/getDate`），因此在任何 TZ 下都成立。
 */
describe('日期区间边界（本地日原语）', () => {
  it('纯日期串按本地零点解析（不是 UTC 零点）', () => {
    const d = startOfDay('2026-11-22')!;
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 10);
    assert.equal(d.getDate(), 22);
    assert.equal(d.getHours(), 0);
    assert.equal(d.getMinutes(), 0);
    assert.equal(d.getSeconds(), 0);
    assert.equal(d.getMilliseconds(), 0);
  });

  it('endOfDay 含当天最后一毫秒（当天记录不会被漏掉）', () => {
    const d = endOfDay('2026-11-22')!;
    assert.equal(formatDay(d), '2026-11-22');
    assert.equal(d.getHours(), 23);
    assert.equal(d.getMinutes(), 59);
    assert.equal(d.getSeconds(), 59);
    assert.equal(d.getMilliseconds(), 999);
    // 同一天的任意时刻都落在 [startOfDay, endOfDay] 内
    const noon = new Date(2026, 10, 22, 12, 30, 0, 0);
    assert.ok(startOfDay('2026-11-22')!.getTime() <= noon.getTime());
    assert.ok(noon.getTime() <= d.getTime());
  });

  it('nextDayStart 是开区间上界：跨月跨年自动进位', () => {
    assert.equal(formatDay(nextDayStart('2026-11-22')!), '2026-11-23');
    assert.equal(formatDay(nextDayStart('2026-11-30')!), '2026-12-01');
    assert.equal(formatDay(nextDayStart('2026-12-31')!), '2027-01-01');
    assert.equal(formatDay(nextDayStart('2028-02-28')!), '2028-02-29'); // 闰年
    assert.equal(nextDayStart('2026-11-22')!.getHours(), 0);
  });

  it('Date 入参取当天零点（带时分秒的输入也被归一，不跨日偏一天）', () => {
    const at = new Date(2026, 10, 22, 18, 45, 30, 500);
    assert.equal(formatDay(startOfDay(at)!), '2026-11-22');
    assert.equal(startOfDay(at)!.getHours(), 0);
    assert.equal(formatDay(endOfDay(at)!), '2026-11-22');
    assert.equal(endOfDay(at)!.getHours(), 23);
    assert.equal(formatDay(nextDayStart(at)!), '2026-11-23');
  });

  it('带时分的日期时间串不会把区间挪到别的天', () => {
    assert.equal(formatDay(endOfDay('2026-11-22T23:30:00')!), '2026-11-22');
    assert.equal(formatDay(startOfDay('2026-11-22T23:30:00')!), '2026-11-22');
  });

  it('空值/非法值一律返回 null（调用方跳过该条件，而不是把 null 写进 where）', () => {
    for (const bad of [null, undefined, '', '   ', 'not-a-date', '2026-13-01', '2026-02-30']) {
      assert.equal(startOfDay(bad), null, `startOfDay(${String(bad)}) 应为 null`);
      assert.equal(endOfDay(bad), null, `endOfDay(${String(bad)}) 应为 null`);
      assert.equal(nextDayStart(bad), null, `nextDayStart(${String(bad)}) 应为 null`);
    }
  });

  it('不修改入参 Date（纯函数）', () => {
    const at = new Date(2026, 10, 22, 18, 0, 0, 0);
    endOfDay(at);
    nextDayStart(at);
    assert.equal(at.getHours(), 18);
    assert.equal(formatDay(at), '2026-11-22');
  });
});

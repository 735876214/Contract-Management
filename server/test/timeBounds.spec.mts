import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startOfDay, endOfDay, nextDayStart, formatDay } from '../src/common/calc/time.ts';
import { dateRange, keywordWhere } from '../src/common/utils/list-where.ts';

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

/**
 * 列表查询的公共 where 片段（`common/utils/list-where.ts`）：
 * 日期区间到底还是"每个 service 各写一份 8 行"，20 个 findAll 里有 7 种写法；
 * 收敛后只剩这一处实现，这里锁住它的**边界语义**与"空值不落 where"的约定。
 */
describe('列表查询公共片段（list-where）', () => {
  it('两端都给：左闭右闭（含当天），且用的是本地日原语', () => {
    const r = dateRange('2026-11-01', '2026-11-22')!;
    assert.equal(formatDay(r.gte!), '2026-11-01');
    assert.equal(r.gte!.getHours(), 0);
    assert.equal(formatDay(r.lte!), '2026-11-22');
    assert.equal(r.lte!.getHours(), 23);
  });

  it('只给一端：另一端不出现在条件里（不是 null 占位）', () => {
    const onlyStart = dateRange('2026-11-01', '')!;
    assert.ok('gte' in onlyStart);
    assert.ok(!('lte' in onlyStart), '右端未给时不得出现 lte，否则 Prisma 会把 null 当条件');
    const onlyEnd = dateRange(undefined, '2026-11-22')!;
    assert.ok('lte' in onlyEnd);
    assert.ok(!('gte' in onlyEnd));
  });

  it('两端都为空/非法 → null（调用方跳过该条件）', () => {
    assert.equal(dateRange(undefined, undefined), null);
    assert.equal(dateRange('', ''), null);
    assert.equal(dateRange('not-a-date', '2026-02-30'), null);
  });

  it('关键字：空关键字返回 null，否则按给定字段展开 contains（不猜字段）', () => {
    assert.equal(keywordWhere(['name', 'code'], ''), null);
    assert.equal(keywordWhere(['name', 'code'], '   '), null);
    assert.equal(keywordWhere([], '钢筋'), null);
    assert.deepEqual(keywordWhere(['name', 'code'], ' 钢筋 '), {
      OR: [{ name: { contains: '钢筋' } }, { code: { contains: '钢筋' } }],
    });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthKey,
  periodMonthKey,
  startDayOf,
  currentSettlementPeriod,
  previousSettlementPeriod,
  periodKeyOf,
  formatDay,
} from '../src/common/utils/settlement-period.ts';
import { assertYearMonth } from '../src/common/utils/helpers.ts';

/**
 * **月度结算期**纯函数的锁（业务口径 2026-10-16）。
 *
 * 期 = 起始日 → 下月同日的前一日；自动生成结算抓**上一期**。
 * 本文件的重点是三处「日历边界」——起始日跨月（26 日）、小月缺日（31 日）、跨年（1 月往前）。
 *
 * ⚠️ 日期一律用**本地**构造（`new Date(2026, 8, 15)`），不要用 `new Date('2026-09-15')`：
 * 后者按 UTC 解析，在负时区会落到前一天，测试会随运行机器的时区飘。
 */

/** 只比日期部分（避免受时分秒影响） */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('monthKey：日期 → YYYY-MM', () => {
  it('本地日期取当月', () => {
    assert.equal(monthKey(new Date(2026, 8, 15)), '2026-09');
    assert.equal(monthKey(new Date(2026, 0, 1)), '2026-01');
  });

  it('空值 / 非法值 → null（不是空串）', () => {
    assert.equal(monthKey(null), null);
    assert.equal(monthKey(undefined), null);
    assert.equal(monthKey(''), null);
    assert.equal(monthKey('不是日期'), null);
  });
});

describe('periodMonthKey：结算账期文本 → YYYY-MM（容错解析）', () => {
  it('常见写法都能认出来', () => {
    assert.equal(periodMonthKey('2026-09'), '2026-09');
    assert.equal(periodMonthKey('2026/9'), '2026-09');
    assert.equal(periodMonthKey('2026.09'), '2026-09');
    assert.equal(periodMonthKey('2026年9月'), '2026-09');
    assert.equal(periodMonthKey('202609'), '2026-09');
    assert.equal(periodMonthKey('2026-09-01'), '2026-09');
    assert.equal(periodMonthKey(' 2026年10月 结算'), '2026-10');
  });

  it('认不出的 → null（调用方回落到开票日期）', () => {
    assert.equal(periodMonthKey(null), null);
    assert.equal(periodMonthKey(''), null);
    assert.equal(periodMonthKey('第一期'), null);
    assert.equal(periodMonthKey('2026-13'), null); // 月份越界
    assert.equal(periodMonthKey('2026-00'), null);
  });
});

describe('currentSettlementPeriod：所在期', () => {
  it('起始日 1 日：期初与期末同月', () => {
    const p = currentSettlementPeriod(1, new Date(2026, 8, 15));
    assert.equal(ymd(p.start), '2026-09-01');
    assert.equal(ymd(p.end), '2026-09-30');
    assert.equal(ymd(p.endExclusive), '2026-10-01');
    assert.equal(p.month, '2026-09');
  });

  it('起始日 26 日：跨月，期标签取期末所在月', () => {
    // 10/15 还没到 10/26 → 本期是 9/26–10/25
    const before = currentSettlementPeriod(26, new Date(2026, 9, 15));
    assert.equal(ymd(before.start), '2026-09-26');
    assert.equal(ymd(before.end), '2026-10-25');
    assert.equal(before.month, '2026-10', '跨月期的标签 = 期末月份（业务反例未给，已在工具文件头写明）');
    // 10/26 起进入下一期
    const after = currentSettlementPeriod(26, new Date(2026, 9, 26));
    assert.equal(ymd(after.start), '2026-10-26');
    assert.equal(ymd(after.end), '2026-11-25');
  });

  it('起始日 31 日：小月取月末（1/31 的下期起始 = 2/28）', () => {
    const p = currentSettlementPeriod(31, new Date(2026, 1, 10));
    assert.equal(ymd(p.start), '2026-01-31');
    assert.equal(ymd(p.end), '2026-02-27');
    const next = currentSettlementPeriod(31, new Date(2026, 1, 28));
    assert.equal(ymd(next.start), '2026-02-28');
    assert.equal(ymd(next.end), '2026-03-30');
  });

  it('起始日非法（0 / 空）按 1 日处理', () => {
    assert.equal(ymd(currentSettlementPeriod(0, new Date(2026, 8, 15)).start), '2026-09-01');
    assert.equal(startDayOf(null), 1);
    assert.equal(startDayOf(new Date(2026, 8, 26)), 26);
  });

  it('相邻两期首尾相接（上一期的 endExclusive 就是本期 start）', () => {
    const cur = currentSettlementPeriod(1, new Date(2026, 9, 2));
    const prev = previousSettlementPeriod(1, new Date(2026, 9, 2));
    assert.equal(prev.endExclusive.getTime(), cur.start.getTime());
  });
});

describe('previousSettlementPeriod：自动生成抓的那一期', () => {
  it('业务原例：起始日 1 日、10/2 运行 → 抓 9/1–9/30（9 月结算）', () => {
    const p = previousSettlementPeriod(1, new Date(2026, 9, 2));
    assert.equal(ymd(p.start), '2026-09-01');
    assert.equal(ymd(p.end), '2026-09-30');
    assert.equal(p.month, '2026-09');
  });

  it('期内任意一天运行结果相同（不会因为"还没到月底"而抓半截）', () => {
    for (const day of [2, 10, 28]) {
      const p = previousSettlementPeriod(1, new Date(2026, 9, day));
      assert.equal(ymd(p.start), '2026-09-01', `10/${day} 运行`);
      assert.equal(ymd(p.end), '2026-09-30', `10/${day} 运行`);
    }
  });

  it('跨年：1 月运行 → 上期是上一年 12 月', () => {
    const p = previousSettlementPeriod(1, new Date(2026, 0, 5));
    assert.equal(ymd(p.start), '2025-12-01');
    assert.equal(ymd(p.end), '2025-12-31');
    assert.equal(p.month, '2025-12');
  });

  it('起始日 26 日：10/26 运行 → 上期 9/26–10/25', () => {
    const p = previousSettlementPeriod(26, new Date(2026, 9, 26));
    assert.equal(ymd(p.start), '2026-09-26');
    assert.equal(ymd(p.end), '2026-10-25');
    assert.equal(p.month, '2026-10');
  });
});

describe('periodKeyOf：日期落在哪一期（发票/收领单归属结算单的口径）', () => {
  it('起始日 1 日时与自然月等价', () => {
    assert.equal(periodKeyOf(1, new Date(2026, 8, 28)), '2026-09');
    assert.equal(periodKeyOf(1, new Date(2026, 9, 1)), '2026-10');
  });

  it('起始日 26 日：9/28 属于 9/26–10/25 那一期（标签取期末月 2026-10）', () => {
    // 与期末 10/25 的结算单同期 —— 用自然月判会误判成 2026-09 而拒绝关联
    assert.equal(periodKeyOf(26, new Date(2026, 8, 28)), '2026-10');
    assert.equal(periodKeyOf(26, new Date(2026, 9, 25)), '2026-10', '期末当天仍属本期');
    // 期初前一天属于上一期；期初当天进入下一期（期末 11/25 → 标签 2026-11）
    assert.equal(periodKeyOf(26, new Date(2026, 8, 25)), '2026-09');
    assert.equal(periodKeyOf(26, new Date(2026, 9, 26)), '2026-11');
  });

  it('非法日期 → null（调用方据此跳过关联判断）', () => {
    assert.equal(periodKeyOf(1, null), null);
    assert.equal(periodKeyOf(1, ''), null);
    assert.equal(periodKeyOf(1, '不是日期'), null);
  });
});

describe('formatDay：接口边界上的日期串（防"差一天"）', () => {
  /**
   * 真事故（2026-10-16 真渲染验收）：期边界原本返回 `Date`，容器 TZ 是 CST 时
   * `new Date(2026, 8, 1)` 序列化成 ISO 变成 `2026-08-31T16:00:00.000Z`，
   * 前端按全站惯例 `String(v).slice(0,10)` 显示成 **2026-08-31**（应为 09-01）。
   * 故接口一律输出 `YYYY-MM-DD` 字符串，本锁保证它**恰好 10 个字符且不经过 UTC**。
   */
  it('本地日期 → 当天，不经过 UTC 转换', () => {
    assert.equal(formatDay(new Date(2026, 8, 1)), '2026-09-01');
    assert.equal(formatDay(new Date(2026, 8, 30)), '2026-09-30');
    assert.equal(formatDay(new Date(2026, 0, 1)), '2026-01-01');
  });

  it('恰好 10 个字符：前端 slice(0,10) 显示后与自身一致', () => {
    const s = formatDay(new Date(2026, 11, 31))!;
    assert.equal(s.length, 10);
    assert.equal(s.slice(0, 10), s);
  });

  it('空值 / 非法值 → null', () => {
    assert.equal(formatDay(null), null);
    assert.equal(formatDay(undefined), null);
    assert.equal(formatDay(''), null);
    assert.equal(formatDay('不是日期'), null);
  });
});

/**
 * 账期字段格式锁（2026-10-20 前端审查发现的静默漏算）。
 *
 * `payMonth` / `settleMonth` 在台账与看板里是**字符串精确匹配**的键，
 * 写成 `2026-9` / `2026/09` 也能存进库，但任何一个月份统计都命中不到它——
 * 界面上「保存成功」，当月金额却少一块。校验放在写入口（create/update）。
 */
describe('assertYearMonth：账期必须是 YYYY-MM', () => {
  it('合法年月通过', () => {
    for (const v of ['2026-09', '2026-01', '2026-12', '1999-10']) {
      assert.doesNotThrow(() => assertYearMonth(v), `${v} 应通过`);
    }
  });

  it('月份不补零 / 越界 / 分隔符错 / 带日 一律拒绝', () => {
    for (const v of ['2026-9', '2026-00', '2026-13', '2026/09', '2026.09', '2026-9-1', '202609', '二〇二六年九月']) {
      assert.throws(() => assertYearMonth(v), `${v} 应被拒绝`);
    }
  });

  it('空值放行（更新时未改该字段）', () => {
    for (const v of [undefined, null, '']) assert.doesNotThrow(() => assertYearMonth(v));
  });

  it('报错里带字段名与原始值，用户能自己改对', () => {
    assert.throws(
      () => assertYearMonth('2026-9', '付款月份'),
      (e: any) => String(e.message).includes('付款月份') && String(e.message).includes('2026-9') && String(e.message).includes('YYYY-MM'),
    );
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveProcedureAmounts, procedureCodeCandidates } from '../src/modules/payment-procedure/amounts.ts';
import { parseOtherProjectStatus } from '../src/modules/other-project/status.ts';
import { notificationListWhere } from '../src/modules/notification/where.ts';

/**
 * 三个此前**零测试覆盖**的小模块的纯函数层（2026-11-22 质量审计）。
 *
 * 为什么是这三个：`notification` / `other-project` / `payment-procedure` 在 `server/test` 与
 * `test-integration` 里一条引用都没有，而 `payment-procedure` 直接决定单据上的「开累结算/开累付款/未付款」。
 * 它们原先全是 Prisma 调用、跑不了单测，故把「口径」抽成纯函数（service 改为调用），这里锁住口径本身。
 */
describe('付款手续：单据上的开累三值', () => {
  it('三值都按 2 位舍入后再相减（不留浮点尾巴）', () => {
    const r = deriveProcedureAmounts(1234.5678, 1000.1111);
    assert.equal(r.settleCumAmount, 1234.57);
    assert.equal(r.paidCumAmount, 1000.11);
    assert.equal(r.unpaidAmount, 234.46);
    assert.ok(Number.isFinite(r.unpaidAmount));
  });

  it('未付款允许为负（付款超结算 = 该被看见的异常，不抹平成 0）', () => {
    const r = deriveProcedureAmounts(100, 150.005);
    assert.equal(r.unpaidAmount, -50.01);
  });

  it('空值按 0（chain 合计无数据时不至于出 NaN）', () => {
    assert.deepEqual(deriveProcedureAmounts(null, undefined), {
      settleCumAmount: 0,
      paidCumAmount: 0,
      unpaidAmount: 0,
    });
  });

  it('两边相等时未付款正好为 0（不留 -0）', () => {
    assert.equal(deriveProcedureAmounts(88.8, 88.8).unpaidAmount, 0);
    assert.ok(!Object.is(deriveProcedureAmounts(88.8, 88.8).unpaidAmount, -0));
  });
});

describe('付款手续：编号候选', () => {
  it('首个无后缀，其后递增 -2、-3 …，上限生效', () => {
    const list = [...procedureCodeCandidates('HT-2026-001', '20261122', 3)];
    assert.deepEqual(list, ['FK-HT-2026-001-20261122', 'FK-HT-2026-001-20261122-2', 'FK-HT-2026-001-20261122-3']);
  });

  it('合同编号缺失时回落 HT（不让编号变成 FK-undefined-…）', () => {
    assert.equal([...procedureCodeCandidates(null, '20261122', 1)][0], 'FK-HT-20261122');
  });
});

describe('其他项目库：导入状态解析', () => {
  it('停用类取值 → 0（大小写/全角空格/多余空白都不影响）', () => {
    for (const v of ['停用', ' 停用 ', '0', '禁用', '否', 'disabled', 'Disabled', 'DISABLED', '\u3000停用\u3000']) {
      assert.equal(parseOtherProjectStatus(v), 0, `「${v}」应判停用`);
    }
  });

  it('其余（含空值与未识别文案）→ 1（与原行为一致的兜底）', () => {
    for (const v of ['启用', '1', '', null, undefined, '正常', 'yes']) {
      assert.equal(parseOtherProjectStatus(v), 1, `「${String(v)}」应判启用`);
    }
  });
});

describe('通知列表 where', () => {
  it('永远带当前用户（前端传什么都覆盖不了）', () => {
    const where = notificationListWhere({}, 'u1');
    assert.equal(where.userId, 'u1');
    assert.ok(!('isRead' in where));
  });

  it('isRead 兼容 true/1/read（历史前端曾传 read/unread）', () => {
    for (const v of ['true', '1', 'read', true, 1, ' READ ']) {
      assert.equal(notificationListWhere({ isRead: v }, 'u1').isRead, true, `「${String(v)}」应判已读`);
    }
    for (const v of ['false', '0', 'unread', false, 0]) {
      assert.equal(notificationListWhere({ isRead: v }, 'u1').isRead, false, `「${String(v)}」应判未读`);
    }
  });

  it('isRead 缺省/空串不加条件（列表要同时含已读与未读）', () => {
    assert.ok(!('isRead' in notificationListWhere({ isRead: '' }, 'u1')));
    assert.ok(!('isRead' in notificationListWhere({ isRead: undefined }, 'u1')));
    assert.ok(!('isRead' in notificationListWhere({ isRead: null }, 'u1')));
  });

  it('projectId 有值才过滤（通知可能不属于任何项目）', () => {
    assert.equal(notificationListWhere({ projectId: 'p1' }, 'u1').projectId, 'p1');
    assert.ok(!('projectId' in notificationListWhere({ projectId: '  ' }, 'u1')));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkOverAmount,
  normalizePolicy,
  contractChainRootId,
  contractChainIds,
  contractChainAmount,
  chainSettledTotal,
  chainPaidTotal,
} from '../src/common/utils/amount-guard.ts';

/**
 * 防超结 / 防超付 的金额上限判定与合同链口径（docs/09 §四）。
 *
 * 说明：`chain*` 系列用**手写 mock db**验证聚合与链遍历逻辑（尤其"排除草稿"与"排除自身"）；
 * Prisma 的 where 翻译不在本测试覆盖范围，靠运行时真打请求复核（见计划 §五）。
 */

/** 最小 mock：语义与真实 where 一致（含 `statusCode != 'DRAFT'` 不误伤 NULL 的规则） */
function mockDb(contracts: any[], settlements: any[] = [], payments: any[] = []) {
  return {
    contract: {
      findUnique: async ({ where: { id } }: any) => contracts.find((c) => c.id === id) ?? null,
      findMany: async ({ where }: any) => {
        if (where?.id?.in) return contracts.filter((c) => where.id.in.includes(c.id));
        if (where?.parentContractId !== undefined) {
          return contracts.filter((c) => c.parentContractId === where.parentContractId);
        }
        return contracts;
      },
    },
    settlement: {
      findMany: async ({ where }: any) => {
        const ids: string[] = where.contractId.in;
        const exclude: string | undefined = where.id?.not;
        return settlements.filter(
          (s) =>
            ids.includes(s.contractId) &&
            s.id !== exclude &&
            s.statusCode !== 'DRAFT', // NULL / undefined 视为已提交（与 OR:[null, not DRAFT] 同义）
        );
      },
    },
    paymentRecord: {
      findMany: async ({ where }: any) => {
        const ids: string[] = where.contractId.in;
        const exclude: string | undefined = where.id?.not;
        return payments.filter((p) => ids.includes(p.contractId) && p.id !== exclude);
      },
    },
  };
}

describe('金额上限判定 checkOverAmount', () => {
  it('等于上限不算超；超出 1 分才算超并给出超出金额', () => {
    const eq = checkOverAmount({ limit: 100, used: 60, current: 40, label: '结算' });
    assert.equal(eq.exceeded, false);
    assert.equal(eq.overBy, 0);
    assert.equal(eq.total, 100);

    const over = checkOverAmount({ limit: 100, used: 60, current: 40.01, label: '结算' });
    assert.equal(over.exceeded, true);
    assert.equal(over.overBy, 0.01);
    assert.match(over.message, /超出 ¥0\.01/);
  });

  it('浮点误差不误判（0.1 + 0.2 与 0.3 等值）', () => {
    const r = checkOverAmount({ limit: 0.3, used: 0.1, current: 0.2 });
    assert.equal(r.exceeded, false);
    assert.equal(r.total, 0.3);
  });

  it('上限为空（合同未填金额）时视为无上限，不拦截', () => {
    for (const limit of [null, undefined, NaN]) {
      const r = checkOverAmount({ limit: limit as number, used: 999, current: 999 });
      assert.equal(r.exceeded, false, `limit=${String(limit)}`);
      assert.equal(r.message, '');
    }
  });

  it('空值 / 非法值按 0 处理，不产生 NaN', () => {
    const r = checkOverAmount({ limit: 10, used: null, current: 'abc' as never });
    assert.equal(r.used, 0);
    assert.equal(r.current, 0);
    assert.equal(r.total, 0);
    assert.equal(r.exceeded, false);
  });

  it('负的本次金额（冲销）不会误判为超限', () => {
    const r = checkOverAmount({ limit: 100, used: 100, current: -50 });
    assert.equal(r.exceeded, false);
    assert.equal(r.total, 50);
  });
});

describe('超限策略归一 normalizePolicy', () => {
  it('BLOCK / OFF 原样保留（大小写与空白不敏感）', () => {
    assert.equal(normalizePolicy('BLOCK'), 'BLOCK');
    assert.equal(normalizePolicy(' block '), 'BLOCK');
    assert.equal(normalizePolicy('off'), 'OFF');
  });

  it('未知 / 空值一律回退 WARN（避免配置写错把结算付款卡死）', () => {
    for (const v of ['', null, undefined, 'WHATEVER', 123]) {
      assert.equal(normalizePolicy(v), 'WARN', String(v));
    }
  });
});

describe('合同链口径（含补充协议）', () => {
  const contracts = [
    { id: 'root', parentContractId: null, amount: 100 },
    { id: 'sup1', parentContractId: 'root', amount: 20 },
    { id: 'sup2', parentContractId: 'root', amount: 30 },
    { id: 'other', parentContractId: null, amount: 999 },
  ];

  it('沿 parentContractId 上溯到链根；根返回自身；不存在返回 null', async () => {
    const db = mockDb(contracts);
    assert.equal(await contractChainRootId(db, 'sup1'), 'root');
    assert.equal(await contractChainRootId(db, 'root'), 'root');
    assert.equal(await contractChainRootId(db, 'ghost'), null);
    assert.equal(await contractChainRootId(db, ''), null);
  });

  it('链上合同 = 链根 + 其补充协议（不含无关合同）', async () => {
    const db = mockDb(contracts);
    assert.deepEqual(await contractChainIds(db, 'sup1'), ['root', 'sup1', 'sup2']);
    assert.deepEqual(await contractChainIds(db, 'ghost'), []);
  });

  it('链金额 = 主合同 + 补充协议 之和', async () => {
    const db = mockDb(contracts);
    assert.equal(await contractChainAmount(db, 'root'), 150);
    assert.equal(await contractChainAmount(db, 'sup2'), 150);
    assert.equal(await contractChainAmount(db, 'ghost'), null, '合同不存在 → null 而非 0');
  });

  it('全链都未填合同额 → 返回 null（= 无上限，防「上限 0」误判所有单据超限）', async () => {
    const noAmount = [
      { id: 'root', parentContractId: null, amount: null },
      { id: 'sup1', parentContractId: 'root', amount: null },
    ];
    assert.equal(await contractChainAmount(mockDb(noAmount), 'root'), null);
    // 有任一份填了金额就按已填部分合计
    const partial = [
      { id: 'root', parentContractId: null, amount: null },
      { id: 'sup1', parentContractId: 'root', amount: 30 },
    ];
    assert.equal(await contractChainAmount(mockDb(partial), 'root'), 30);
  });

  it('累计结算排除草稿、排除自身；NULL 状态视为已提交（计入）', async () => {
    const db = mockDb(contracts, [
      { id: 's1', contractId: 'root', actualAmount: 50, statusCode: 'CONFIRMED' },
      { id: 's2', contractId: 'root', actualAmount: 40, statusCode: 'DRAFT' }, // 草稿：不计
      { id: 's3', contractId: 'sup1', amount: 10, statusCode: null }, // 无 actualAmount → 回退 amount；NULL 计入
      { id: 's4', contractId: 'other', actualAmount: 500, statusCode: 'CONFIRMED' }, // 无关合同：不计
    ]);
    assert.equal(await chainSettledTotal(db, 'root'), 60);
    // 编辑场景：排除自身后，本次金额不重复计入
    assert.equal(await chainSettledTotal(db, 'root', 's1'), 10);
  });

  it('累计付款排除「不构成实际出资」的状态（付款失败/已退款）', async () => {
    const db = mockDb(
      contracts,
      [],
      [
        { id: 'p1', contractId: 'root', amount: 30, statusCode: 'PAID' },
        { id: 'p2', contractId: 'root', amount: 40, statusCode: 'FAILED' },
        { id: 'p3', contractId: 'root', amount: 10, statusCode: 'REFUNDED' },
      ],
    );
    // 若不排除失败/退款，会把 80 当成已付；真实出资只有 30
    assert.equal(await chainPaidTotal(db, 'root', undefined, ['FAILED', 'REFUNDED']), 30);
    assert.equal(await chainPaidTotal(db, 'root'), 80);
  });

  it('累计付款按链统计并排除自身', async () => {
    const db = mockDb(
      contracts,
      [],
      [
        { id: 'p1', contractId: 'root', amount: 30 },
        { id: 'p2', contractId: 'sup2', amount: 5 },
        { id: 'p3', contractId: 'other', amount: 700 },
      ],
    );
    assert.equal(await chainPaidTotal(db, 'root'), 35);
    assert.equal(await chainPaidTotal(db, 'root', 'p1'), 5);
  });
});

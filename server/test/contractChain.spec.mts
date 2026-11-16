import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveChainAmounts,
  contractChainRootId,
  contractChainIds,
  contractChainAmount,
  chainSettledTotal,
  chainPaidTotal,
  type ContractChainRow,
} from '../src/common/utils/contract-chain.ts';

/**
 * **合同当前金额口径锁**（2026-10-15 业务澄清）：
 * `合同当前金额 = 主合同金额 + Σ 补充协议 changeAmount`（带符号）。
 *
 * 三条必须钉住的语义：
 * 1. 参与求和的是 `changeAmount`（服务端按清单重算的**增量**），**不是** `amount`
 *    ——继续用 `amount` 会把"剩余数量的全值"重复计入；
 * 2. 主合同金额未填 → `currentAmount` 是 `null`（未知），**不是**"只算补充协议"那样给出假数；
 * 3. 只算链根的直接补充协议（孙辈不算），且防环。
 */

const rows: ContractChainRow[] = [
  { id: 'M', parentContractId: null, amount: 100000, changeAmount: null },
  // 增项 +2 万
  { id: 'S1', parentContractId: 'M', amount: 20000, changeAmount: 20000 },
  // 减项 −5000（降价）
  { id: 'S2', parentContractId: 'M', amount: 8000, changeAmount: -5000 },
  // 孙辈：挂在 S1 之下，不计入 M 的链
  { id: 'G1', parentContractId: 'S1', amount: 999, changeAmount: 999 },
];

describe('合同当前金额 = 主合同 + 补充协议（带符号增量）', () => {
  it('主合同与补充协议一增一减 → 当前金额 = 100000 + 20000 − 5000', () => {
    const c = resolveChainAmounts(rows, 'M');
    assert.equal(c.rootId, 'M');
    assert.equal(c.mainAmount, 100000);
    assert.equal(c.supplementTotal, 15000);
    assert.equal(c.supplementCount, 2);
    assert.equal(c.currentAmount, 115000);
  });

  it('从任一份补充协议出发，解析到的是同一条链、同一个当前金额', () => {
    const a = resolveChainAmounts(rows, 'M');
    const b = resolveChainAmounts(rows, 'S2');
    assert.equal(b.rootId, 'M');
    assert.deepEqual(b.chainIds, a.chainIds);
    assert.equal(b.currentAmount, a.currentAmount);
  });

  it('只算**直接**补充协议（孙辈不进链）', () => {
    const c = resolveChainAmounts(rows, 'M');
    assert.deepEqual(c.chainIds, ['M', 'S1', 'S2']);
    assert.ok(!c.chainIds.includes('G1'), '孙辈合同不该计入主合同的当前金额');
  });

  it('主合同金额未填 → currentAmount 为 null（不拿补充协议增量冒充金额）', () => {
    const c = resolveChainAmounts(
      [
        { id: 'M2', parentContractId: null, amount: null },
        { id: 'S21', parentContractId: 'M2', changeAmount: 20000 },
        { id: 'S22', parentContractId: 'M2', changeAmount: -5000 },
      ],
      'M2',
    );
    assert.equal(c.mainAmount, null);
    assert.equal(c.supplementTotal, 15000, '补充协议累计仍可算');
    assert.equal(c.currentAmount, null, '主合同金额未知 → 合同当前金额也未知（未填 ≠ 0）');
  });

  it('显式填 0 的主合同是「已知的 0」，照常相加', () => {
    const c = resolveChainAmounts([{ id: 'M3', amount: 0 }, { id: 'S3', parentContractId: 'M3', changeAmount: 500 }], 'M3');
    assert.equal(c.mainAmount, 0);
    assert.equal(c.currentAmount, 500, '0 元主合同 + 500 增量 = 500（不是 null）');
  });

  it('合同不存在 → 空结果，不抛错', () => {
    const c = resolveChainAmounts(rows, 'NOPE');
    assert.equal(c.rootId, null);
    assert.deepEqual(c.chainIds, []);
    assert.equal(c.currentAmount, null);
  });

  it('链上有环也不死循环（防环，最多上溯 8 层）', () => {
    const cyclic: ContractChainRow[] = [
      { id: 'A', parentContractId: 'B', amount: 100 },
      { id: 'B', parentContractId: 'A', amount: 200 },
    ];
    const c = resolveChainAmounts(cyclic, 'A');
    assert.ok(c.rootId, '至少要能返回一个根，不能卡死');
    assert.ok(c.chainIds.length <= 2);
  });

  it('空串金额按未填处理（表单清空会写空串）', () => {
    const c = resolveChainAmounts([{ id: 'M4', amount: '  ' }, { id: 'S4', parentContractId: 'M4', changeAmount: 100 }], 'M4');
    assert.equal(c.currentAmount, null);
  });
});

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
          (s) => ids.includes(s.contractId) && s.id !== exclude && s.statusCode !== 'DRAFT',
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

/**
 * 需要 db 的链 IO（原在 `amount-guard.spec.mts`，2026-10-15 随实现一起搬来）。
 * mock 只覆盖 `get 链 → 算金额` 的语义；Prisma 的 where 翻译不在单测范围，靠真打请求复核。
 */
describe('合同链 IO（含补充协议增量）', () => {
  const contracts = [
    { id: 'root', parentContractId: null, amount: 100 },
    // 增项 +20（changeAmount 与 amount 故意**不同**：证明求和取的是增量）
    { id: 'sup1', parentContractId: 'root', amount: 5000, changeAmount: 20 },
    // 减项 −8
    { id: 'sup2', parentContractId: 'root', amount: 30, changeAmount: -8 },
    { id: 'other', parentContractId: null, amount: 999 },
  ];

  it('沿 parentContractId 上溯到链根；根返回自身；不存在返回 null', async () => {
    const db = mockDb(contracts);
    assert.equal(await contractChainRootId(db, 'sup1'), 'root');
    assert.equal(await contractChainRootId(db, 'root'), 'root');
    assert.equal(await contractChainRootId(db, 'ghost'), null);
    assert.equal(await contractChainRootId(db, ''), null);
  });

  it('链上合同 = 链根 + 其直接补充协议（不含无关合同）', async () => {
    const db = mockDb(contracts);
    assert.deepEqual(await contractChainIds(db, 'sup1'), ['root', 'sup1', 'sup2']);
    assert.deepEqual(await contractChainIds(db, 'ghost'), []);
  });

  it('合同当前金额 = 主合同 + Σ changeAmount（**不采信手填的 amount**）', async () => {
    const db = mockDb(contracts);
    // 100 + 20 − 8 = 112；若误用手填 amount 会得到 100 + 5000 + 30 = 5130
    assert.equal(await contractChainAmount(db, 'root'), 112);
    assert.equal(await contractChainAmount(db, 'sup2'), 112, '从补充协议出发同一条链、同一个数');
    assert.equal(await contractChainAmount(db, 'ghost'), null, '合同不存在 → null 而非 0');
  });

  it('主合同未填金额 → null（无上限）；补充协议增量不能顶替主合同金额', async () => {
    const noAmount = [
      { id: 'root', parentContractId: null, amount: null },
      { id: 'sup1', parentContractId: 'root', amount: 30, changeAmount: 30 },
    ];
    assert.equal(
      await contractChainAmount(mockDb(noAmount), 'root'),
      null,
      '主合同金额未知 → 当前金额未知；此时给出 30 会变成"上限 30"的假数',
    );
  });

  it('累计结算排除草稿、排除自身；NULL 状态视为已提交（计入）', async () => {
    const db = mockDb(contracts, [
      { id: 's1', contractId: 'root', actualAmount: 50, statusCode: 'CONFIRMED' },
      { id: 's2', contractId: 'root', actualAmount: 40, statusCode: 'DRAFT' },
      { id: 's3', contractId: 'sup1', amount: 10, statusCode: null },
      { id: 's4', contractId: 'other', actualAmount: 500, statusCode: 'CONFIRMED' },
    ]);
    assert.equal(await chainSettledTotal(db, 'root'), 60);
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

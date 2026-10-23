/**
 * 履约偏差预警（课题 4-9）真值夹具。
 *
 * **这个文件的用途是「对锁」**：`aiFulfillmentRules.spec.mts` 断言的命中条数、规则码、等级
 * 全部由这里的构造注释给出（人工标好的 ground truth），规则改动若改变了判定，测试会红。
 *
 * 时间基准固定为 `2026-10-24`（本地零点）：规则层不读系统时钟，所以结果不随日期漂移。
 *
 * 5 个合同、7 个节点、3 笔付款、1 份终期结算，覆盖 C1–C8 全部 8 个规则码；
 * 另外给一份「全干净」夹具（0 命中）用来证明规则不会无中生有。
 */

import type { FulfillmentInput } from '../../src/modules/ai/fulfillment/fulfillment-types.ts';

/** 判定基准日：2026-10-24 本地零点 */
export const FIXTURE_NOW = new Date(2026, 9, 24);

export function fulfillmentFixture(): FulfillmentInput {
  return {
    now: FIXTURE_NOW,
    contracts: [
      // K1：主体完工晚 51 天（C4 高）+ 验收逾期 24 天（C1 需复核）
      {
        id: 'k1',
        code: 'HT-2026-101',
        name: '主体结构工程',
        amount: 1_000_000,
        parentContractId: null,
        signDate: '2026-03-01',
        signedDate: '2026-03-01',
        status: 'SIGNED',
      },
      // K2：开工计划早于签订 5 天（C5）+ 完工逾期 238 天（C1 高）+ 结算已完成而完工未完成（C3）
      {
        id: 'k2',
        code: 'HT-2026-102',
        name: '装饰装修工程',
        amount: 500_000,
        parentContractId: null,
        signDate: '2026-01-10',
        signedDate: '2026-01-10',
        status: 'SIGNED',
      },
      // K3：完成未填实际日期（C2）+ 验收逾期 23 天（C1）+ 付款 100% 而完成率 50%（C6 高）
      //     + 已出终期结算仍有未完成节点（C7）
      {
        id: 'k3',
        code: 'HT-2026-103',
        name: '机电安装工程',
        amount: 300_000,
        parentContractId: null,
        signDate: '2026-02-01',
        signedDate: '2026-02-01',
        status: 'SIGNED',
      },
      // K4：已签章但一个节点都没有（C8）
      {
        id: 'k4',
        code: 'HT-2026-104',
        name: '临建工程',
        amount: 80_000,
        parentContractId: null,
        signDate: '2026-05-01',
        signedDate: '2026-05-01',
        status: 'SIGNED',
      },
      // K5：未签订、节点正常完成 —— 干净对照（不应命中任何规则）
      {
        id: 'k5',
        code: 'HT-2026-105',
        name: '未签章草稿合同',
        amount: 60_000,
        parentContractId: null,
        signDate: null,
        signedDate: null,
        status: 'DRAFT',
      },
    ],
    milestones: [
      // K1
      { id: 'k1m1', contractId: 'k1', name: '进场', planDate: '2026-03-10', actualDate: '2026-03-12', statusCode: 'DONE' },
      // 晚 51 天 → C4（高风险）
      { id: 'k1m2', contractId: 'k1', name: '主体完工', planDate: '2026-06-30', actualDate: '2026-08-20', statusCode: 'DONE' },
      // 逾期 24 天 → C1（需复核）
      { id: 'k1m3', contractId: 'k1', name: '竣工验收', planDate: '2026-09-30', actualDate: null, statusCode: 'PENDING' },
      // K2：计划 2026-01-05 早于签订 2026-01-10 → C5；且此刻已完成
      { id: 'k2m1', contractId: 'k2', name: '开工', planDate: '2026-01-05', actualDate: '2026-01-06', statusCode: 'DONE' },
      // 逾期 238 天 → C1（高风险）；且后续「结算」已完成 → C3
      { id: 'k2m2', contractId: 'k2', name: '完工', planDate: '2026-02-28', actualDate: null, statusCode: 'PENDING' },
      { id: 'k2m3', contractId: 'k2', name: '结算', planDate: '2026-03-31', actualDate: '2026-04-05', statusCode: 'DONE' },
      // K3：DONE 但无实际日期 → C2；验收逾期 23 天 → C1
      { id: 'k3m1', contractId: 'k3', name: '开工', planDate: '2026-02-10', actualDate: null, statusCode: 'DONE' },
      { id: 'k3m2', contractId: 'k3', name: '验收', planDate: '2026-10-01', actualDate: null, statusCode: 'PENDING' },
      // K5：正常（计划=实际，已签章合同之外）
      { id: 'k5m1', contractId: 'k5', name: '开工', planDate: '2026-06-01', actualDate: '2026-06-01', statusCode: 'DONE' },
    ],
    payments: [
      // K3：300,000 / 300,000 = 100%，而完成率 50% → C6 高风险（差 50 个百分点）
      { id: 'k3p1', contractId: 'k3', amount: 200_000, payDate: '2026-08-01', statusCode: 'PAID' },
      { id: 'k3p2', contractId: 'k3', amount: 100_000, payDate: '2026-09-01', statusCode: 'PAID' },
      // K2：400,000 / 500,000 = 80%，完成率 66% → 差 14 个百分点，未达阈值（不命中）
      { id: 'k2p1', contractId: 'k2', amount: 400_000, payDate: '2026-04-10', statusCode: 'PAID' },
      // 已作废的付款不计入（口径同 6-9）
      { id: 'k2p2', contractId: 'k2', amount: 99_999, payDate: '2026-04-11', statusCode: 'FAILED' },
    ],
    finalSettlements: [
      // K3 已出终期结算（非草稿），但验收节点未完成 → C7
      { id: 'k3fs', contractId: 'k3', statusCode: 'CONFIRMED', settledAt: '2026-09-20' },
    ],
  };
}

/** 全干净夹具：所有节点按计划完成、没有异常付款、没有终期结算 → 必须 0 命中 */
export function cleanFulfillmentFixture(): FulfillmentInput {
  return {
    now: FIXTURE_NOW,
    contracts: [
      {
        id: 'c1',
        code: 'HT-2026-201',
        name: '干净合同',
        amount: 200_000,
        parentContractId: null,
        signDate: '2026-01-01',
        signedDate: '2026-01-01',
        status: 'SIGNED',
      },
    ],
    milestones: [
      { id: 'c1m1', contractId: 'c1', name: '进场', planDate: '2026-01-10', actualDate: '2026-01-10', statusCode: 'DONE' },
      { id: 'c1m2', contractId: 'c1', name: '完工', planDate: '2026-06-30', actualDate: '2026-06-28', statusCode: 'DONE' },
      // 计划在基准日之后，未到期
      { id: 'c1m3', contractId: 'c1', name: '结算', planDate: '2026-12-31', actualDate: null, statusCode: 'PENDING' },
    ],
    payments: [{ id: 'c1p1', contractId: 'c1', amount: 100_000, payDate: '2026-07-01', statusCode: 'PAID' }],
    finalSettlements: [],
  };
}

/** 期望命中（人工标注，逐条）：规则码 → 条数 */
export const FIXTURE_EXPECTED_BY_CODE: Record<string, number> = {
  C1_OVERDUE: 3, // k1m3(24天) / k2m2(238天) / k3m2(23天)
  C2_DONE_NO_ACTUAL: 1, // k3m1
  C3_SEQUENCE_INVERTED: 1, // k2m2 未完成而后继 k2m3 已完成
  C4_FINISH_LATE: 1, // k1m2 晚 51 天
  C5_PLAN_BEFORE_SIGN: 1, // k2m1 计划早于签订 5 天
  C6_PROGRESS_PAYMENT_GAP: 1, // k3 付款 100% vs 完成率 50%
  C7_SETTLED_UNFINISHED: 1, // k3 终期结算已出 + k3m2 未完成
  C8_NO_MILESTONE: 1, // k4
};

export const FIXTURE_EXPECTED_TOTAL = 10;
export const FIXTURE_EXPECTED_HIGH = 3; // k2m2(C1) / k1m2(C4) / k3(C6)
export const FIXTURE_EXPECTED_MEDIUM = 7;

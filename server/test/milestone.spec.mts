import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMilestoneOverdue, startOfToday, MILESTONE_STATUS_LABELS } from '../src/common/utils/milestone.ts';
import { MILESTONE_STATUS } from '../src/constants/statuses.ts';

/** 合同履约节点（四域扩展按需项 2026-10-18）：逾期是派生值，不落库 */
describe('履约节点逾期派生 isMilestoneOverdue', () => {
  const now = new Date(2026, 9, 18, 15, 0, 0); // 2026-10-18 15:00

  it('当天零点口径：到期日当天不算逾期', () => {
    assert.deepEqual(startOfToday(now), new Date(2026, 9, 18));
    assert.equal(isMilestoneOverdue({ planDate: new Date(2026, 9, 18) }, now), false, '到期日当天不逾期');
    assert.equal(isMilestoneOverdue({ planDate: new Date(2026, 9, 17) }, now), true, '昨天已过 → 逾期');
  });

  it('完成/跳过不逾期；无计划日期不逾期；无状态也照常判逾期', () => {
    const late = new Date(2026, 9, 1);
    assert.equal(isMilestoneOverdue({ planDate: late, statusCode: MILESTONE_STATUS.DONE }, now), false);
    assert.equal(isMilestoneOverdue({ planDate: late, statusCode: MILESTONE_STATUS.SKIPPED }, now), false);
    assert.equal(isMilestoneOverdue({ planDate: late, statusCode: MILESTONE_STATUS.PENDING }, now), true);
    assert.equal(isMilestoneOverdue({ planDate: late }, now), true, '无状态视为未完成');
    assert.equal(isMilestoneOverdue({ planDate: null }, now), false);
    assert.equal(isMilestoneOverdue({ planDate: 'not-a-date' }, now), false, '非法日期不逾期');
  });

  it('展示名映射齐全', () => {
    assert.deepEqual(Object.keys(MILESTONE_STATUS_LABELS), ['PENDING', 'DONE', 'SKIPPED']);
  });
});

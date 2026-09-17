import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_STATUS,
  SETTLEMENT_STATUS,
  assertContractRejectable,
  assertSettlementRejectable,
  assertResultReportRejectable,
} from '../src/constants/workflowGuards';
import { STAGE_KEYS, stageChain, stageView } from '../src/constants/procurementFlow';

/**
 * 任务 7：三处驳回（无审批流，纯状态回退）状态机单测。
 * 覆盖「合同签章→合同起草 / 结算→回填 / 成交报告→重发」的准入与拒绝分支，挡回归。
 */

/** 成交报告在单项采购（无采前会）阶段链中的下标 */
const REPORT_IDX = stageChain('SINGLE', false).findIndex((s) => s.key === STAGE_KEYS.RESULT_REPORT);

describe('驳回状态机（任务 7）', () => {
  describe('合同签章驳回 → 合同起草', () => {
    it('「审批中 / 已签章」可驳回', () => {
      assert.doesNotThrow(() => assertContractRejectable(CONTRACT_STATUS.APPROVING));
      assert.doesNotThrow(() => assertContractRejectable(CONTRACT_STATUS.SIGNED));
    });

    it('草稿 / 未知状态不可驳回（避免无效回退）', () => {
      assert.throws(() => assertContractRejectable(CONTRACT_STATUS.DRAFT), /仅「审批中 \/ 已签章」/);
      assert.throws(() => assertContractRejectable(''), /仅「审批中 \/ 已签章」/);
      assert.throws(() => assertContractRejectable(undefined as any), /仅「审批中 \/ 已签章」/);
    });
  });

  describe('结算驳回 → 回填', () => {
    it('已提交状态（待确认/已确认/已开票/已付款/已完成）可驳回回填', () => {
      for (const s of [
        SETTLEMENT_STATUS.PENDING,
        SETTLEMENT_STATUS.CONFIRMED,
        SETTLEMENT_STATUS.INVOICED,
        SETTLEMENT_STATUS.PAID,
        SETTLEMENT_STATUS.DONE,
      ]) {
        assert.doesNotThrow(() => assertSettlementRejectable(s), `${s} 应可驳回`);
      }
    });

    it('草稿不可重复驳回', () => {
      assert.throws(() => assertSettlementRejectable(SETTLEMENT_STATUS.DRAFT), /草稿无需驳回/);
      assert.throws(() => assertSettlementRejectable('UNKNOWN'), /草稿无需驳回/);
    });
  });

  describe('成交报告退回 → 重发', () => {
    it('单项采购且已发布成交报告、下游合同为草稿/不存在 → 允许退回', () => {
      assert.doesNotThrow(() =>
        assertResultReportRejectable({
          type: 'SINGLE',
          stage: REPORT_IDX + 1,
          reportStageIndex: REPORT_IDX,
          linkedContractStatus: CONTRACT_STATUS.DRAFT,
        }),
      );
      assert.doesNotThrow(() =>
        assertResultReportRejectable({
          type: 'SINGLE',
          stage: REPORT_IDX + 2,
          reportStageIndex: REPORT_IDX,
          linkedContractStatus: null,
        }),
      );
    });

    it('非单项采购不可退回（框架/紧急采购无成交报告阶段）', () => {
      assert.throws(
        () =>
          assertResultReportRejectable({
            type: 'FRAMEWORK',
            stage: 2,
            reportStageIndex: -1,
            linkedContractStatus: null,
          }),
        /仅「单项采购」/,
      );
    });

    it('成交报告尚未发布不可退回', () => {
      assert.throws(
        () =>
          assertResultReportRejectable({
            type: 'SINGLE',
            stage: REPORT_IDX - 1,
            reportStageIndex: REPORT_IDX,
            linkedContractStatus: null,
          }),
        /成交报告尚未发布/,
      );
    });

    it('下游合同已签章/审批中禁止退回（须先驳回合同，避免孤儿合同）', () => {
      for (const s of [CONTRACT_STATUS.APPROVING, CONTRACT_STATUS.SIGNED]) {
        assert.throws(
          () =>
            assertResultReportRejectable({
              type: 'SINGLE',
              stage: REPORT_IDX + 2,
              reportStageIndex: REPORT_IDX,
              linkedContractStatus: s,
            }),
          /请先驳回合同/,
          `${s} 应禁止退回`,
        );
      }
    });

    it('退回后阶段回退到成交报告编制中，价格对比表重新锁定（门禁一致）', () => {
      const chain = stageChain('SINGLE', false);
      // 退回：stage 回到成交报告下标，状态回到 RESULT_EDITING
      const stages = chain.map((s, i) => ({ key: s.key, state: stageView(chain, REPORT_IDX)[i] }));
      const byKey = (k: string) => stages.find((s) => s.key === k)!.state;
      assert.equal(byKey(STAGE_KEYS.RESULT_REPORT), 'editing');
      assert.equal(byKey(STAGE_KEYS.PRICE_COMPARE), 'locked');
      assert.equal(byKey(STAGE_KEYS.DOCUMENT), 'done');
    });
  });
});

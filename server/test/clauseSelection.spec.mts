import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUSE_TYPE_LABELS,
  SLOT_TYPE_OF,
  resolveClauseSnapshot,
  type ClauseType,
} from '../src/modules/procurement/clause-snapshot.ts';
import { CLAUSE_TYPE_OPTIONS } from '../../web/src/constants/clauseTypes.ts';

/**
 * 「条款选择」规则锁（业务口径 2026-10-16）：
 * 条款只在「基础信息管理 → 合同条款」维护，采购发起第三步 / 合同起草**只做选择**。
 *
 * 关键取舍（错了会静默毁掉下游 20+ 处消费点）：
 * - 快照写进**既有文本列**（techQuality / acceptanceMethod / paymentMethod），
 *   下游（采前会/公告/文件/成交报告/Word 导出）读的都是文本列 → 零改动；
 * - 槽位显式传 `null` = 清除 → 文本列**一并清空**（否则界面看着没选、变量却还有值）；
 * - 技术条款与质量条款**合成** techQuality 两段。
 */

const clause = (type: ClauseType, content: string) => ({ type, content });
const DB: Record<string, { type: ClauseType; content: string }> = {
  t1: clause('technical', '<p>钢筋符合 GB/T 1499.2</p>'),
  q1: clause('quality', '<p>按批次抽检，合格率 100%</p>'),
  p1: clause('payment', '<p>验收合格后 30 日内付款</p>'),
  a1: clause('acceptance', '<p>现场计量 + 见证取样</p>'),
  wrong: clause('technical', '<p>这是技术条款</p>'), // 类型放错槽位用的
};

const lookup = (id: string) => DB[id];
const missing = (id: string) => new Error(`条款不存在: ${id}`);
const mismatch = (slot: string, expected: ClauseType, actual: string | null) =>
  new Error(`类型不匹配: ${slot} 需要 ${expected} 实际 ${actual}`);

describe('条款选择：槽位 ↔ 类型映射', () => {
  it('四个槽位各对应一种条款类型，与「合同条款」页的四种类型一一对应', () => {
    assert.deepEqual(Object.values(SLOT_TYPE_OF).sort(), Object.keys(CLAUSE_TYPE_LABELS).sort());
    // 前端条款库页的类型下拉必须就是这四种（value 一致）
    assert.deepEqual(
      CLAUSE_TYPE_OPTIONS.map((o) => o.value).sort(),
      Object.keys(CLAUSE_TYPE_LABELS).sort(),
    );
    // label 也要一致（下拉里显示的就是它）
    for (const o of CLAUSE_TYPE_OPTIONS) {
      assert.equal(CLAUSE_TYPE_LABELS[o.value as ClauseType], o.label);
    }
  });
});

describe('条款选择：快照生成', () => {
  it('四个槽位各选一条 → 三个文本列正确产出（技术+质量合成 techQuality）', () => {
    const snap = resolveClauseSnapshot(
      { technicalClauseId: 't1', qualityClauseId: 'q1', acceptanceClauseId: 'a1', paymentClauseId: 'p1' },
      lookup,
      missing,
      mismatch,
    );
    assert.equal(snap.techQuality, '<p>钢筋符合 GB/T 1499.2</p>\n<p>按批次抽检，合格率 100%</p>');
    assert.equal(snap.acceptanceMethod, '<p>现场计量 + 见证取样</p>');
    assert.equal(snap.paymentMethod, '<p>验收合格后 30 日内付款</p>');
  });

  it('只选技术条款（不选质量）→ techQuality 只有技术段', () => {
    const snap = resolveClauseSnapshot({ technicalClauseId: 't1' }, lookup, missing, mismatch);
    assert.equal(snap.techQuality, '<p>钢筋符合 GB/T 1499.2</p>');
    assert.equal(snap.acceptanceMethod, undefined, '未提及的槽位不动');
    assert.equal(snap.paymentMethod, undefined, '未提及的槽位不动');
  });

  it('槽位显式传 null = 清除 → 快照一并清空（否则界面没选、变量却还有值）', () => {
    const snap = resolveClauseSnapshot({ acceptanceClauseId: null }, lookup, missing, mismatch);
    assert.equal(snap.acceptanceMethod, null);
  });

  it('清空所有槽位 → techQuality 为 null 而不是空串（保持"未填"语义）', () => {
    const snap = resolveClauseSnapshot({ technicalClauseId: null, qualityClauseId: null }, lookup, missing, mismatch);
    assert.equal(snap.techQuality, null);
  });

  it('条款不存在 → 走 onMissing（service 侧 400）', () => {
    assert.throws(
      () => resolveClauseSnapshot({ technicalClauseId: 'ghost' }, lookup, missing, mismatch),
      /条款不存在/,
    );
  });

  it('类型放错槽位（把技术条款选进付款条件）→ 走 onTypeMismatch（service 侧 400）', () => {
    assert.throws(
      () => resolveClauseSnapshot({ paymentClauseId: 'wrong' }, lookup, missing, mismatch),
      /类型不匹配/,
    );
  });

  it('条款正文为空串 → 合成后归 null（不产生只有换行的"假内容"）', () => {
    const snap = resolveClauseSnapshot(
      { technicalClauseId: 'empty', qualityClauseId: 'empty2' },
      (id) => (id === 'empty' || id === 'empty2' ? { type: id === 'empty' ? 'technical' : 'quality', content: '' } : undefined),
      missing,
      mismatch,
    );
    assert.equal(snap.techQuality, null);
  });
});

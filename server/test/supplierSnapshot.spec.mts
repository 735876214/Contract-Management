import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SUPPLIER_SNAPSHOT_FIELDS,
  pickSupplierSnapshot,
  parseSupplierSnapshot,
  mergeSupplierFields,
} from '../src/common/utils/supplier-snapshot.ts';

/**
 * 「签订时快照」的口径锁（2026-10-15 业务澄清：合同正文导出取签订时快照）。
 *
 * 最容易出错的地方不是合并策略，而是**字段清单漏项**：`generate()` 读了一个没被冻结的字段，
 * 就会静默回退到实时值 —— 看起来一切正常，只有历史合同被悄悄改写。
 * 故本文件除了行为用例，还**扫源码**把两边钉在一起。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const live = pickSupplierSnapshot({
  name: '甲公司',
  bankName: '建设银行',
  legalPerson: '张三',
  contactPhone: '13800000000',
  address: 'A 地址',
});

describe('供应商快照：KEEP / SYNC', () => {
  it('KEEP（默认）→ 快照优先：主数据改了也不影响已签订合同', () => {
    const snap = pickSupplierSnapshot({ name: '甲公司（旧名）', bankName: '工商银行' });
    const merged = mergeSupplierFields('KEEP', snap, live);
    assert.equal(merged.name, '甲公司（旧名）', '改名不应改写历史合同');
    assert.equal(merged.bankName, '工商银行', '换银行不应改写历史合同');
  });

  it('SYNC → 强制实时（参数从此名副其实）', () => {
    const snap = pickSupplierSnapshot({ name: '甲公司（旧名）', bankName: '工商银行' });
    const merged = mergeSupplierFields('SYNC', snap, live);
    assert.equal(merged.name, '甲公司');
    assert.equal(merged.bankName, '建设银行');
  });

  it('未识别 / 空值 → 按 KEEP 处理（未定即保留原值）', () => {
    const snap = pickSupplierSnapshot({ name: '旧名' });
    for (const mode of [null, undefined, '', 'whatever', 123]) {
      assert.equal(mergeSupplierFields(mode, snap, live).name, '旧名', String(mode));
    }
  });

  it('没有快照（存量合同）→ 全部回退实时，行为不变', () => {
    const merged = mergeSupplierFields('KEEP', null, live);
    assert.deepEqual(merged, live);
  });

  it('逐字段回退：快照里的**空串**视为未提供，用后来补上的实时值', () => {
    const snap = pickSupplierSnapshot({ name: '甲公司', bankAccount: '' });
    const laterLive = pickSupplierSnapshot({ name: '甲公司', bankAccount: '6217****1234' });
    const merged = mergeSupplierFields('KEEP', snap, laterLive);
    assert.equal(merged.bankAccount, '6217****1234', '签章时没开户行、后来补上了，应显示补上的');
    assert.equal(merged.name, '甲公司');
  });

  it('快照字段清单覆盖 generate() 用到的全部 sup.*（防漏项导致静默回退实时）', () => {
    const src = readFileSync(`${repoRoot}server/src/modules/template/template.service.ts`, 'utf8');
    const used = new Set([...src.matchAll(/\bsup\.(\w+)/g)].map((m) => m[1]));
    assert.ok(used.size >= 10, `只扫到 ${used.size} 个 sup.* 字段，正则或代码结构可能已变（勿让本锁空转）`);
    const missing = [...used].filter((f) => !(SUPPLIER_SNAPSHOT_FIELDS as readonly string[]).includes(f));
    assert.deepEqual(
      missing,
      [],
      `template.service 读了这些字段但快照没冻结，它们会静默回退实时值：\n  ${missing.join('\n  ')}`,
    );
  });

  it('pickSupplierSnapshot 把空值归一为空串（JSON 往返稳定）', () => {
    const snap = pickSupplierSnapshot({ name: 'X', bankName: null, legalPerson: undefined });
    assert.equal(snap.bankName, '');
    assert.equal(snap.legalPerson, '');
    assert.equal(Object.keys(snap).length, SUPPLIER_SNAPSHOT_FIELDS.length);
  });

  it('parseSupplierSnapshot 容忍脏数据（解析失败视为无快照，不抛错）', () => {
    assert.equal(parseSupplierSnapshot(null), null);
    assert.equal(parseSupplierSnapshot(''), null);
    assert.equal(parseSupplierSnapshot('{不是 JSON'), null);
    assert.equal(parseSupplierSnapshot('[1,2]'), null);
    assert.deepEqual(parseSupplierSnapshot('{"name":"甲"}'), { name: '甲' });
    assert.deepEqual(parseSupplierSnapshot({ name: '乙' }), { name: '乙' });
  });
});

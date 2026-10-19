import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFormMappingMessages,
  candidateListText,
  fieldListText,
  normalizeMapping,
  promptCandidates,
} from '../src/modules/ai/ai-prompt.ts';
import { AI_FIELD_CATALOG, aiFieldByKey, availableFields } from '../src/modules/ai/field-catalog.ts';
import type { FormCandidate } from '../src/modules/ai/form-scan.ts';

/**
 * AI 助手 prompt 构造 / 模型输出规整。
 *
 * 两条底线在这里被**锁死**（改动必须让本文件失败，而不是靠 review）：
 * 1. **prompt 里绝不出现字段值**——`currentValue` 不能进任何一条消息；
 * 2. 模型输出**不可信**：越界序号、未知字段键、重复映射必须被丢弃，不能污染回填结果。
 */

const cand = (label: string, currentValue = ''): FormCandidate => ({
  sheet: 'Sheet1',
  cellRef: 'B2',
  row: 2,
  col: 2,
  label,
  currentValue,
});

describe('候选序列化', () => {
  it('序号从 1 起（模型对 1 基更稳），空标签丢弃但**不重排序号**', () => {
    // 序号先按输入位置编号再过滤：保留 gap 是刻意的——`ai.service` 用 `i+1 → candidates[i]`
    // 的同一套口径反查坐标，若这里重排，模型给的序号会指到错的单元格。
    const out = promptCandidates([cand('项目名称'), cand(''), cand('合同编号')]);
    assert.deepEqual(out.map((c) => c.index), [1, 3]);
    assert.deepEqual(out.map((c) => c.label), ['项目名称', '合同编号']);
  });

  it('候选文本不含 currentValue', () => {
    const out = promptCandidates([cand('统一社会信用代码', '91330000ABCDEF1234')]);
    assert.equal(JSON.stringify(out).includes('91330000'), false);
  });
});

describe('字段清单文本', () => {
  it('含 key / 标签 / 类型 / 同义词', () => {
    const text = fieldListText([aiFieldByKey('project.name')!], 10);
    assert.ok(text.includes('project.name'));
    assert.ok(text.includes('项目名称'));
    assert.ok(text.includes('工程名称'));
  });

  it('超上限截断且非法上限按 1 处理', () => {
    const fields = AI_FIELD_CATALOG.slice(0, 3);
    assert.equal(fieldListText(fields, 2).split('\n').length, 2);
    assert.equal(fieldListText(fields, 0).split('\n').length, 1);
  });

  it('候选清单带工作表名（多表同名标签必须可区分）', () => {
    const text = candidateListText(
      [
        { index: 1, sheet: '封面', label: '项目名称' },
        { index: 2, sheet: '附表', label: '项目名称' },
      ],
      10,
    );
    assert.ok(text.includes('[封面]'));
    assert.ok(text.includes('[附表]'));
  });
});

describe('构造消息（安全底线）', () => {
  const messages = buildFormMappingMessages({
    fields: AI_FIELD_CATALOG.slice(0, 10),
    candidates: [cand('项目名称', '某某产业园一期'), cand('合同金额', '1234567.89')],
    maxFields: 10,
    maxCandidates: 10,
  });

  it('固定两条消息：system 规则 + user 清单', () => {
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
  });

  it('**任何字段值都不出现在 prompt 里**（最核心的一条）', () => {
    const all = messages.map((m) => m.content).join('\n');
    assert.equal(all.includes('某某产业园一期'), false, '项目名称的值被送进了 prompt');
    assert.equal(all.includes('1234567.89'), false, '合同金额的值被送进了 prompt');
  });

  it('标签与字段键确实进了 prompt（否则上一条恒真）', () => {
    const all = messages.map((m) => m.content).join('\n');
    assert.ok(all.includes('项目名称'));
    assert.ok(all.includes('project.name'));
    assert.ok(all.includes('【系统可用字段】'));
    assert.ok(all.includes('【上传表格的待填项】'));
  });
});

describe('模型输出规整（不可信输入）', () => {
  it('接受 {mapping:[]} 与裸数组两种形状', () => {
    const a = normalizeMapping({ mapping: [{ candidate: 1, field: 'project.name', confidence: 0.9 }] }, 2);
    const b = normalizeMapping([{ candidate: 1, field: 'project.name', confidence: 0.9 }], 2);
    assert.deepEqual(a, b);
    assert.equal(a[0].fieldKey, 'project.name');
  });

  it('丢弃越界序号、非整数序号、未知字段键', () => {
    const out = normalizeMapping(
      [
        { candidate: 0, field: 'project.name' },
        { candidate: 99, field: 'project.name' },
        { candidate: 1.5, field: 'project.name' },
        { candidate: 1, field: 'not.a.field' },
        { candidate: 2, field: 'project.code', confidence: 0.8 },
      ],
      3,
    );
    assert.deepEqual(out.map((s) => s.candidateIndex), [2]);
  });

  it('候选数为 0 时全部丢弃', () => {
    assert.deepEqual(normalizeMapping([{ candidate: 1, field: 'project.name' }], 0), []);
  });

  it('同一候选多条 → 只留置信度最高的一条', () => {
    const out = normalizeMapping(
      [
        { candidate: 1, field: 'project.name', confidence: 0.4 },
        { candidate: 1, field: 'project.code', confidence: 0.95 },
      ],
      2,
    );
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].fieldKey, out[0].confidence], ['project.code', 0.95]);
  });

  it('同一字段映射到两个候选 → 只保留一个（避免两格填同一个值）', () => {
    const out = normalizeMapping(
      [
        { candidate: 1, field: 'project.name', confidence: 0.5 },
        { candidate: 2, field: 'project.name', confidence: 0.9 },
      ],
      2,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].candidateIndex, 2);
  });

  it('confidence 缺省为 0、夹到 [0,1]、保留 3 位小数', () => {
    const out = normalizeMapping(
      [
        { candidate: 1, field: 'project.name', confidence: 7 },
        { candidate: 2, field: 'project.code', confidence: -3 },
        { candidate: 3, field: 'project.nameAbbr', confidence: 0.123456 },
        { candidate: 4, field: 'project.undertaker' },
      ],
      4,
    );
    const byCand = new Map(out.map((s) => [s.candidateIndex, s.confidence]));
    assert.equal(byCand.get(1), 1);
    assert.equal(byCand.get(2), 0);
    assert.equal(byCand.get(3), 0.123);
    assert.equal(byCand.get(4), 0);
  });

  it('结果按候选序号升序（回填顺序稳定，便于复现）', () => {
    const out = normalizeMapping(
      [
        { candidate: 2, field: 'project.code', confidence: 0.9 },
        { candidate: 1, field: 'project.name', confidence: 0.9 },
      ],
      2,
    );
    assert.deepEqual(out.map((s) => s.candidateIndex), [1, 2]);
  });

  it('垃圾输入不抛错', () => {
    for (const raw of [null, undefined, 'oops', 42, {}, { mapping: 'nope' }, [null, 1, 'x']]) {
      assert.deepEqual(normalizeMapping(raw, 3), []);
    }
  });
});

describe('字段目录', () => {
  it('键唯一', () => {
    const keys = AI_FIELD_CATALOG.map((f) => f.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('未关联合同时不给 contract/supplier 域字段（避免建议出填不出的值）', () => {
    const noContract = availableFields({ hasContract: false, hasSupplier: false });
    assert.equal(noContract.some((f) => f.scope === 'contract'), false);
    assert.equal(noContract.some((f) => f.scope === 'project'), true);

    const withContract = availableFields({ hasContract: true, hasSupplier: true });
    assert.equal(withContract.some((f) => f.scope === 'contract'), true);
    assert.ok(withContract.length > noContract.length);
  });

  it('敏感字段被标记（前端据此提示，值仍由服务端填）', () => {
    const bank = aiFieldByKey('supplier.bankAccount');
    assert.ok(bank);
    assert.equal(bank?.sensitive, true);
  });
});

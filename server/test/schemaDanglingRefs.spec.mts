import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * schema.prisma「悬空引用」漂移锁（源自 2026-10-13 的工作域关联审计 §6.7 / §7）。
 *
 * 背景：模型内形如 `xxxId` 的标量字段若**没有**出现在任何 `@relation(fields: [...])` 中，
 * 就是一处「有外键字段、无引用完整性」的悬空引用（审计时共 27 处）。
 * 本测试把「关联中断」变成 CI 可捕获：新增悬空字段而未登记豁免时立即失败。
 *
 * 有意豁免的弱关联（审计的 C 类，属设计取舍而非遗漏）：
 * 通用表按 `bizType + bizId` 弱关联、多态归属、全局共享等，均不适合建单值外键。
 *
 * ⚠️ 那份审计文档已按仓库惯例**落地后删除**（其余两份方案文档 08/09 同理，见 CLAUDE.md §8）——
 * 本测试与 `schema.prisma` 的模型注释就是它结论的永久落点，别再往回引用旧文档编号。
 */
const ALLOWED_DANGLING: Record<string, string[]> = {
  // 防重唯一键：收领单「修改」会整体重建明细，建 Cascade 会与资产台账 upsert 逻辑冲突（见 schema 注释）
  AssetLedger: ['receiptDetailId'],
  // 单据化冗余列（= doc.laborAuthId）：收领单聚合查询用；真 FK 是 docId（Cascade），冗余列不再重复建关联
  LaborReceivingSummary: ['laborAuthId'],
  // 操作人弱关联（用户删除不追溯历史记录）
  ContractChangeLog: ['operatorId'],
  // null = 全局共享模板/供应商（受 supplier.share.scope 等系统参数控制）
  // （Subcontractor 已删除：2026-10-17 并入 LaborAuthLedger，原白名单条目随之移除）
  ContractTemplate: ['projectId'],
  Supplier: ['projectId'],
  // 通用异步任务表：按业务类型弱关联，不绑定单一业务表
  ImportTask: ['projectId', 'userId'],
  // 通用通知 / 操作日志：按 bizType + bizId 弱关联
  Notification: ['bizId', 'projectId'],
  OperationLog: ['bizId', 'projectId'],
  // 总采购清单 ID：批次二占位，尚无可引用的实体表
  ProcurementTask: ['totalListId'],
  // 项目负责人弱关联
  Project: ['managerId'],
  // 领用单位是多态（分包商 / 本项目 / 其他项目），无法用单值外键表达
  ReceiptOrder: ['receivingUnitId'],
};

const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../prisma/schema.prisma',
);

interface ModelInfo {
  /** 模型内的字段声明行（已 trim） */
  fields: string[];
  /** 出现在 @relation(fields: [...]) 中的字段名 */
  relationFields: Set<string>;
}

/** 解析 schema.prisma 的 model 块，收集字段与外键字段 */
function parseSchema(source: string): Map<string, ModelInfo> {
  const models = new Map<string, ModelInfo>();
  let cur: ModelInfo | null = null;
  for (const line of source.split(/\r?\n/)) {
    const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelMatch) {
      cur = { fields: [], relationFields: new Set() };
      models.set(modelMatch[1], cur);
      continue;
    }
    if (!cur) continue;
    if (/^\}/.test(line)) {
      cur = null;
      continue;
    }
    const s = line.trim();
    if (!s || s.startsWith('//') || s.startsWith('@@')) continue;
    cur.fields.push(s);
    const rel = /@relation\([^)]*fields:\s*\[([^\]]*)\]/.exec(line);
    if (rel) for (const f of rel[1].split(',')) cur.relationFields.add(f.trim());
  }
  return models;
}

/** 列出「形如 xxxId 的标量字段但不在任何 @relation(fields) 中」的字段 */
function findDanglingRefs(models: Map<string, ModelInfo>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, info] of models) {
    const bad = new Set<string>();
    for (const s of info.fields) {
      const m = /^(\w+)\s+(String|Int)\??(\s|$)/.exec(s);
      if (!m) continue;
      const field = m[1];
      if (field === 'id' || !field.endsWith('Id')) continue;
      if (info.relationFields.has(field)) continue;
      bad.add(field);
    }
    if (bad.size) out[name] = [...bad].sort();
  }
  return out;
}

const models = parseSchema(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
const dangling = findDanglingRefs(models);

describe('schema 悬空引用漂移锁', () => {
  it('schema 至少解析出预期数量的模型（防止解析器失效导致测试恒真）', () => {
    assert.ok(models.size >= 50, `仅解析出 ${models.size} 个 model，解析逻辑可能已失效`);
  });

  it('未登记的悬空引用必须为零：新增 xxxId 字段要么建 @relation，要么登记进白名单', () => {
    const offenders: string[] = [];
    for (const [model, fields] of Object.entries(dangling)) {
      const allowed = ALLOWED_DANGLING[model] ?? [];
      for (const f of fields) {
        if (!allowed.includes(f)) offenders.push(`${model}.${f}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `发现未登记的悬空外键字段（应补 @relation，或确属有意弱关联则登记进 ALLOWED_DANGLING）：\n  ${offenders.join('\n  ')}`,
    );
  });

  it('白名单不得腐烂：已建立外键（或字段/模型已删除）的条目应从白名单移除', () => {
    const stale: string[] = [];
    for (const [model, fields] of Object.entries(ALLOWED_DANGLING)) {
      const actual = dangling[model] ?? [];
      for (const f of fields) {
        if (!actual.includes(f)) stale.push(`${model}.${f}`);
      }
    }
    assert.deepEqual(stale, [], `白名单中以下条目已不再是悬空引用，请移除：\n  ${stale.join('\n  ')}`);
  });

  it('本批次修复的关键外键均已落地（回归锁定）', () => {
    const expectForeignKey: Array<[string, string]> = [
      ['Contract', 'templateId'],
      ['Contract', 'technicalClauseId'],
      ['Contract', 'qualityClauseId'],
      ['Contract', 'paymentClauseId'],
      ['Contract', 'acceptanceClauseId'],
      ['ContractTemplate', 'parentId'],
      ['ProcurementTotalItem', 'materialBaseId'],
      // （Subcontractor 已删除：并入 LaborAuthLedger；subcontractId 外键移至台账表）
      ['LaborAuthLedger', 'subcontractId'],
      ['AssetLedger', 'receiptOrderId'],
      ['ReceiptOrderDetail', 'materialId'],
      ['ReceiptOrder', 'subcontractorId'],
      ['DailyReport', 'receiptOrderId'],
    ];
    const missing = expectForeignKey
      .filter(([model, field]) => !models.get(model)?.relationFields.has(field))
      .map(([model, field]) => `${model}.${field}`);
    assert.deepEqual(missing, [], `以下字段应已建立 @relation 外键：\n  ${missing.join('\n  ')}`);
  });

  it('死字段与双写字段已彻底移除（审计 §3.2、§4.1）', () => {
    assert.ok(
      !models.get('PaymentRecord')?.fields.some((f) => f.startsWith('applyId')),
      'PaymentRecord.applyId 是指向已移除 PaymentApply 的死字段，应已删除',
    );
    assert.ok(
      !models.get('ProcurementTask')?.fields.some((f) => f.startsWith('contractId')),
      'ProcurementTask.contractId 与 Contract.taskId 双写，应已移除（保留 Contract.taskId 一条）',
    );
  });
});

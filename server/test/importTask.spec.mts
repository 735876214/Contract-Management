import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPORT_ACTIVE_STATUSES,
  IMPORT_TASK_STALE_MS,
  IMPORT_TASK_STALE_MESSAGE,
  importDedupeKey,
  isImportTaskStale,
} from '../src/common/utils/import-task.ts';

/**
 * 异步导入任务的「僵尸判定」与「幂等去重键」单测。
 *
 * 背景：`ImportTaskService` 是进程内 fire-and-forget 执行（无 worker 轮询），
 * 此前只置 `RUNNING` 而无心跳 → 进程崩溃后该行**永久停在进行中**。
 * 本测试锁定回收判据（含"老数据回退"路径）与去重键的稳定性。
 * 真机验收另见：插入僵尸行 → 重启服务 → 被回收为 FAILED。
 */

const MIN = 60 * 1000;
const NOW = new Date('2026-10-14T06:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * MIN);

describe('僵尸判定 isImportTaskStale', () => {
  it('阈值与提示语符合约定（10 分钟）', () => {
    assert.equal(IMPORT_TASK_STALE_MS, 10 * MIN);
    assert.ok(IMPORT_TASK_STALE_MESSAGE.includes('请重新导入'));
    assert.deepEqual([...IMPORT_ACTIVE_STATUSES], ['PENDING', 'RUNNING']);
  });

  it('RUNNING：心跳新鲜不算僵尸；超过阈值即算', () => {
    assert.equal(isImportTaskStale({ status: 'RUNNING', lockedAt: ago(1) }, NOW), false);
    assert.equal(isImportTaskStale({ status: 'RUNNING', lockedAt: ago(11) }, NOW), true);
    // 边界：恰好等于阈值不算（用严格大于）
    assert.equal(isImportTaskStale({ status: 'RUNNING', lockedAt: ago(10) }, NOW), false);
  });

  it('RUNNING 无心跳（老数据）时依次回退 startedAt → createdAt', () => {
    assert.equal(isImportTaskStale({ status: 'RUNNING', startedAt: ago(11) }, NOW), true);
    assert.equal(isImportTaskStale({ status: 'RUNNING', createdAt: ago(11) }, NOW), true);
    assert.equal(isImportTaskStale({ status: 'RUNNING', createdAt: ago(1) }, NOW), false);
    // 三者皆空 → 无从判断，保守地不回收
    assert.equal(isImportTaskStale({ status: 'RUNNING' }, NOW), false);
  });

  it('PENDING 长时间未开始也算僵尸（进程在排队期崩溃）', () => {
    assert.equal(isImportTaskStale({ status: 'PENDING', createdAt: ago(11) }, NOW), true);
    assert.equal(isImportTaskStale({ status: 'PENDING', createdAt: ago(1) }, NOW), false);
    assert.equal(isImportTaskStale({ status: 'PENDING' }, NOW), false);
  });

  it('终态（SUCCESS / FAILED）与未知状态一律不回收', () => {
    for (const status of ['SUCCESS', 'FAILED', 'WHATEVER', '']) {
      assert.equal(isImportTaskStale({ status, lockedAt: ago(999), createdAt: ago(999) }, NOW), false, status);
    }
  });

  it('支持自定义阈值与字符串时间（跨包调用更宽容）', () => {
    assert.equal(isImportTaskStale({ status: 'RUNNING', lockedAt: ago(2) }, NOW, MIN), true);
    assert.equal(
      isImportTaskStale({ status: 'RUNNING', lockedAt: ago(11).toISOString() }, NOW),
      true,
    );
  });

  it('非法时间值按「无时间」处理（不抛错）', () => {
    assert.equal(isImportTaskStale({ status: 'RUNNING', lockedAt: 'not-a-date' as never }, NOW), false);
  });
});

describe('幂等去重键 importDedupeKey', () => {
  const rows = [{ name: 'A' }, { name: 'B' }];

  it('同一模块 + 同名 + 同内容 → 同一个键（可安全比较）', () => {
    const a = importDedupeKey({ module: 'supplier', fileName: 'f.xlsx', rows });
    const b = importDedupeKey({ module: 'supplier', fileName: 'f.xlsx', rows: [{ name: 'A' }, { name: 'B' }] });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{40}$/);
  });

  it('模块 / 文件名 / 行数 / 行内容 任一不同 → 键不同', () => {
    const base = importDedupeKey({ module: 'supplier', fileName: 'f.xlsx', rows });
    assert.notEqual(base, importDedupeKey({ module: 'contract', fileName: 'f.xlsx', rows }));
    assert.notEqual(base, importDedupeKey({ module: 'supplier', fileName: 'g.xlsx', rows }));
    assert.notEqual(base, importDedupeKey({ module: 'supplier', fileName: 'f.xlsx', rows: [{ name: 'A' }] }));
    // 同样的文件名与行数、但内容不同 → 不能误判为同一份文件
    assert.notEqual(
      base,
      importDedupeKey({ module: 'supplier', fileName: 'f.xlsx', rows: [{ name: 'A' }, { name: 'C' }] }),
    );
  });

  it('空值 / 缺省参数不抛错（rows 缺省按 0 行）', () => {
    const k = importDedupeKey({ module: 'supplier' });
    assert.match(k, /^[0-9a-f]{40}$/);
    assert.equal(k, importDedupeKey({ module: 'supplier', fileName: null, rows: [] }));
  });

  it('行内容不可序列化（循环引用）时不抛错：退化为「模块+文件名+行数」，同规模内容互相等价', () => {
    const a: any = { name: 'A' };
    a.self = a;
    const b: any = { name: 'B' };
    b.self = b;
    const k1 = importDedupeKey({ module: 'supplier', fileName: 'f.xlsx', rows: [a] });
    assert.match(k1, /^[0-9a-f]{40}$/);
    // 两份都不可序列化的内容（同模块/文件名/行数）→ 同键（退化后不再区分内容）
    assert.equal(k1, importDedupeKey({ module: 'supplier', fileName: 'f.xlsx', rows: [b] }));
    // 与可正常序列化的内容不同键（正常路径会附上内容摘要）
    assert.notEqual(k1, importDedupeKey({ module: 'supplier', fileName: 'f.xlsx', rows: [{ name: 'X' }] }));
  });
});

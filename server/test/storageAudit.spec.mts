import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageAudit } from '../src/common/utils/storage-audit.ts';

/** 本地文件审计（只读）：missing / orphans / duplicates / invalid */
describe('本地文件存储审计 buildStorageAudit', () => {
  const ref = (source: string, id: string, field: string, raw: string) => ({ source, id, field, raw });

  it('正常引用不产生问题', () => {
    const r = buildStorageAudit(
      [ref('Contract', 'c1', 'signedFilePath', 'signed/a.pdf'), ref('Invoice', 'i1', 'imageUrl', '/api/files/2026-10/b.png')],
      ['signed/a.pdf', '2026-10/b.png'],
    );
    assert.equal(r.referenceCount, 2);
    assert.equal(r.fileCount, 2);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.orphans, []);
    assert.deepEqual(r.invalid, []);
  });

  it('区分缺失引用与孤儿文件', () => {
    const r = buildStorageAudit(
      [ref('Contract', 'c1', 'signedFilePath', 'signed/missing.pdf')],
      ['signed/a.pdf', 'orphan/x.png'],
    );
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].source, 'Contract');
    assert.deepEqual(r.orphans, ['orphan/x.png', 'signed/a.pdf']);
  });

  it('同键多引用进 duplicates（信息项）', () => {
    const r = buildStorageAudit(
      [ref('A', '1', 'url', '/api/files/x.pdf'), ref('B', '2', 'url', 'x.pdf')],
      ['x.pdf'],
    );
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].key, 'x.pdf');
    assert.equal(r.duplicates[0].refs.length, 2);
    assert.deepEqual(r.missing, []);
  });

  it('越权/非法引用归入 invalid，不算 missing', () => {
    const r = buildStorageAudit(
      [ref('Bad', '1', 'url', '../secret'), ref('Bad', '2', 'url', '/etc/passwd')],
      [],
    );
    assert.equal(r.invalid.length, 2);
    assert.equal(r.missing.length, 0);
  });

  it('空引用跳过；文件键做分隔符归一', () => {
    const r = buildStorageAudit(
      [ref('X', '1', 'url', ''), ref('X', '2', 'url', '  ')],
      ['dir\\a.pdf', './dir/b.pdf'],
    );
    assert.equal(r.referenceCount, 0);
    assert.equal(r.fileCount, 2);
    assert.deepEqual(r.orphans, ['dir/a.pdf', 'dir/b.pdf']);
  });
});

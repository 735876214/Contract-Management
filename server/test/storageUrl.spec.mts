import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { storageKeyFromUrl } from '../src/common/utils/storage-url.ts';

/** 文件引用归一化（键 / `/api/files/...` / 完整 URL → 相对键） */
describe('文件引用归一化 storageKeyFromUrl', () => {
  it('相对键只做分隔符归一', () => {
    assert.equal(storageKeyFromUrl('signed/a.pdf'), 'signed/a.pdf');
    assert.equal(storageKeyFromUrl('  signed\\a.pdf  '), 'signed/a.pdf');
    assert.equal(storageKeyFromUrl('2026-10/./a.pdf'), '2026-10/a.pdf');
    assert.equal(storageKeyFromUrl('2026-10//a.pdf'), '2026-10/a.pdf');
  });

  it('公开 URL / 完整 URL / 双前缀都取到键', () => {
    assert.equal(storageKeyFromUrl('/api/files/2026-10/a.pdf'), '2026-10/a.pdf');
    assert.equal(storageKeyFromUrl('/api/files//api/files/2026-10/a.pdf'), '2026-10/a.pdf');
    assert.equal(
      storageKeyFromUrl('https://cms.example.com/api/files/2026-10/a.pdf?token=x#frag'),
      '2026-10/a.pdf',
    );
  });

  it('非 /api/files 的绝对路径保留前导斜杠（交给安全校验拒绝）', () => {
    assert.equal(storageKeyFromUrl('/etc/passwd'), '/etc/passwd');
    assert.equal(storageKeyFromUrl('C:/windows/system32'), 'C:/windows/system32');
    assert.equal(storageKeyFromUrl('../secret.txt'), '../secret.txt');
  });

  it('空值返回空串', () => {
    assert.equal(storageKeyFromUrl(null), '');
    assert.equal(storageKeyFromUrl(undefined), '');
    assert.equal(storageKeyFromUrl('   '), '');
  });
});

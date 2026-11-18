/**
 * 纯函数单测：文件名解析/清洗、去重路径。不联网、不依赖后端。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickFilename, sanitizeFilename, uniquePath } from '../dist/cms-client.js';

test('pickFilename 解析 filename*=UTF-8', () => {
  const h = "attachment; filename*=UTF-8''%E5%90%88%E5%90%8C.xlsx";
  assert.equal(pickFilename(h, 'x'), '合同.xlsx');
});

test('pickFilename 解析普通 filename 并回退', () => {
  assert.equal(pickFilename('attachment; filename="a b.xlsx"', 'x'), 'a b.xlsx');
  assert.equal(pickFilename(null, 'fallback.xlsx'), 'fallback.xlsx');
});

test('sanitizeFilename 清洗非法字符', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?.xlsx'), 'a_b_c_d_e_.xlsx');
  assert.equal(sanitizeFilename('   '), 'download');
});

test('uniquePath 同名追加序号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmsmcp-'));
  const first = uniquePath(dir, 'r.xlsx');
  writeFileSync(first, 'x');
  const second = uniquePath(dir, 'r.xlsx');
  assert.ok(second.endsWith('r-1.xlsx'), `期望 r-1.xlsx，实际 ${second}`);
});

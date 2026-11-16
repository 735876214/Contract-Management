import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeDocTemplateFileKey,
  isExcelTemplateFileName,
} from '../src/modules/doc-template/doc-template-file.ts';
import {
  toStorageKey,
  toFileUrl,
  isExcelTemplateFileName as isExcelTemplateFileNameWeb,
} from '../../web/src/utils/templateFile.ts';

/**
 * 单据模板「文件键 / 文件名」纯逻辑锁（2026-10-18）。
 *
 * 背景：上传接口返回公开 URL（`/api/files/<键>`），而数据库与 `StorageService.read()` 用相对键；
 * 前端曾把 URL 原样存进 `fileUrl`，生成单据时被安全校验当成绝对路径拒绝（400）。
 * 这里锁死「URL/键 → 相对键」的归一规则，并保证前后端两份实现逐条一致。
 *
 * 同时锁住「其它绝对路径不静默纠正」——`/etc/passwd` 必须原样保留，交给 `assertSafeStorageKey`
 * 拒绝；悄悄改成 `etc/passwd` 会削弱越权读盘的防线。
 */

describe('normalizeDocTemplateFileKey：URL / 键 → 相对键', () => {
  it('裸键原样返回（只归一分隔符与 ./）', () => {
    assert.equal(normalizeDocTemplateFileKey('2026-10/a.xlsx'), '2026-10/a.xlsx');
    assert.equal(normalizeDocTemplateFileKey('./2026-10//a.xlsx'), '2026-10/a.xlsx');
    assert.equal(normalizeDocTemplateFileKey('2026-10\\a.xlsx'), '2026-10/a.xlsx');
  });

  it('剥离 /api/files/ 前缀（含双前缀与完整 URL）', () => {
    assert.equal(normalizeDocTemplateFileKey('/api/files/2026-10/a.xlsx'), '2026-10/a.xlsx');
    assert.equal(normalizeDocTemplateFileKey('/api/files//api/files/2026-10/a.xlsx'), '2026-10/a.xlsx');
    assert.equal(
      normalizeDocTemplateFileKey('https://cms.example.com/api/files/2026-10/a.xlsx?x=1#h'),
      '2026-10/a.xlsx',
    );
  });

  it('空值返回空串', () => {
    assert.equal(normalizeDocTemplateFileKey(''), '');
    assert.equal(normalizeDocTemplateFileKey(undefined), '');
    assert.equal(normalizeDocTemplateFileKey(null), '');
  });

  it('其它绝对路径保持原样（交给 assertSafeStorageKey 拒绝，不静默纠正）', () => {
    assert.equal(normalizeDocTemplateFileKey('/etc/passwd'), '/etc/passwd');
    assert.equal(normalizeDocTemplateFileKey('C:/Windows/win.ini'), 'C:/Windows/win.ini');
  });
});

describe('isExcelTemplateFileName：只认 .xlsx', () => {
  it('.xlsx（大小写不敏感）通过', () => {
    assert.equal(isExcelTemplateFileName('模板.xlsx'), true);
    assert.equal(isExcelTemplateFileName('TEMPLATE.XLSX'), true);
    assert.equal(isExcelTemplateFileName('  模板.Xlsx  '), true);
  });

  it('.xlsm / .xls / 其他类型与空值拒绝（.xlsm 的宏会在写出时丢失）', () => {
    for (const name of ['模板.xlsm', '模板.xls', '模板.docx', '模板.csv', '', null, undefined]) {
      assert.equal(isExcelTemplateFileName(name), false, `${name} 不应被当作 Excel 模板`);
    }
  });
});

describe('前后端文件键规则一致', () => {
  const samples = [
    '2026-10/a.xlsx',
    './2026-10//a.xlsx',
    '2026-10\\a.xlsx',
    '/api/files/2026-10/a.xlsx',
    '/api/files//api/files/2026-10/a.xlsx',
    'https://cms.example.com/api/files/2026-10/a.xlsx?x=1#h',
    '/etc/passwd',
    'C:/Windows/win.ini',
    '',
  ];

  it('toStorageKey 与后端 normalizeDocTemplateFileKey 同输入同输出', () => {
    for (const s of samples) {
      assert.equal(toStorageKey(s), normalizeDocTemplateFileKey(s), `输入：${s}`);
    }
  });

  it('toFileUrl 只补一次 /api/files/（历史 URL / 双前缀都正确）', () => {
    assert.equal(toFileUrl('2026-10/a.xlsx'), '/api/files/2026-10/a.xlsx');
    assert.equal(toFileUrl('/api/files/2026-10/a.xlsx'), '/api/files/2026-10/a.xlsx');
    assert.equal(toFileUrl('/api/files//api/files/2026-10/a.xlsx'), '/api/files/2026-10/a.xlsx');
    assert.equal(toFileUrl(''), '');
    // 完整外链原样返回（不是本系统存储键）
    assert.equal(toFileUrl('https://cdn.example.com/a.xlsx'), 'https://cdn.example.com/a.xlsx');
  });

  it('Excel 文件名判定前后端一致', () => {
    for (const name of ['a.xlsx', 'A.XLSX', 'a.xlsm', 'a.xls', 'a.docx', '', null]) {
      assert.equal(isExcelTemplateFileNameWeb(name), isExcelTemplateFileName(name), `文件名：${name}`);
    }
  });
});

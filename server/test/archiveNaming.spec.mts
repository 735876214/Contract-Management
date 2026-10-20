import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_CATEGORIES } from '../src/constants/archiveCategories.ts';
import {
  PLACEHOLDER_NAME,
  businessFileName,
  businessFileNameKeepExt,
  dedupePath,
  extOf,
  imagePdfName,
  periodDirOf,
  prefixedFileName,
  placeholderText,
  projectRootOf,
  sanitizeSegment,
} from '../src/modules/archive/archive-naming.ts';

/**
 * 项目资料归档 · 命名规则锁（附件需求 2026-10-17，业务逐条确认的口径）。
 * 命名错了会让归档包「看起来对、实际对不上业务」，故逐条锁死。
 */
describe('归档命名：项目根目录', () => {
  it('目录第一段 = 项目简称（nameAbbr），为空回退 name', () => {
    assert.equal(projectRootOf('滨江商务中心', '滨江商务中心项目'), '滨江商务中心');
    assert.equal(projectRootOf('', '滨江商务中心项目'), '滨江商务中心项目');
  });
  it('都为空用「未命名项目」；非法字符清洗成 _（ZIP 路径安全）', () => {
    assert.equal(projectRootOf(null, null), '未命名项目');
    assert.equal(sanitizeSegment('CBD/项目:*2026'), 'CBD_项目__2026');
  });
});

describe('归档命名：业务化文件名（修正 2/5）', () => {
  it('收领单 = 供应商-物资-结算账期-收领单.pdf（需求原例逐字）', () => {
    assert.equal(
      businessFileName({ supplier: '高邑潜玛', material: '安全物资', period: '2026.1', docName: '收领单' }, true),
      '高邑潜玛-安全物资-2026.1-收领单.pdf',
    );
  });
  it('发票 = 供应商-物资-结算账期-发票汇总.pdf（账期取 Invoice.settlePeriod）', () => {
    assert.equal(
      imagePdfName({ supplier: '高邑潜玛', material: '安全物资', period: '2026.1', docName: '发票汇总' }),
      '高邑潜玛-安全物资-2026.1-发票汇总.pdf',
    );
  });
  it('图片统一转 PDF：即使原文件是 png/jpg，扩展名也固定 .pdf（修正 5）', () => {
    const name = businessFileName({ supplier: 'S', material: 'M', period: '2026.1', docName: '收领单' }, true);
    assert.ok(name.endsWith('.pdf'), name);
  });
  it('不能转 PDF 的附件（docx/gif/webp）按真实扩展名命名，不能叫 .pdf', () => {
    const parts = { supplier: '高邑潜玛', material: '安全物资', period: '2026.1', docName: '收领单' };
    assert.equal(businessFileNameKeepExt(parts, '2026-01/ab12cd.docx'), '高邑潜玛-安全物资-2026.1-收领单.docx');
    assert.equal(businessFileNameKeepExt(parts, 'x.gif'), '高邑潜玛-安全物资-2026.1-收领单.gif');
    assert.equal(businessFileNameKeepExt(parts, 'noext'), '高邑潜玛-安全物资-2026.1-收领单.bin');
  });
  it('缺段用 - 占位（保持四段式结构可读）；段内非法字符清洗', () => {
    assert.equal(
      businessFileName({ supplier: null, material: '', period: undefined, docName: '收领单' }, true),
      '------收领单.pdf',
    );
  });
});

describe('归档命名：通用工具', () => {
  it('extOf 从键或 URL 取小写扩展名', () => {
    assert.equal(extOf('2026-01/abc.PNG'), '.png');
    assert.equal(extOf('/api/files/x/y.pdf'), '.pdf');
    assert.equal(extOf('noext'), '');
  });
  it('prefixedFileName 保留原扩展名（小写化）、主体清洗', () => {
    assert.equal(prefixedFileName('HT-2026-0001', '扫描件(3).PDF'), 'HT-2026-0001-扫描件(3).pdf');
  });
  it('dedupePath 重名追加 (2)(3)，保留扩展名', () => {
    const used = new Set(['a/结算单.xlsx']);
    assert.equal(dedupePath(used, 'a/结算单.xlsx'), 'a/结算单(2).xlsx');
    used.add('a/结算单(2).xlsx');
    assert.equal(dedupePath(used, 'a/结算单.xlsx'), 'a/结算单(3).xlsx');
    assert.equal(dedupePath(new Set(), 'a/结算单.xlsx'), 'a/结算单.xlsx');
  });
  it('periodDirOf：2026.1 → 2026年1月（需求原例「月度结算单/2026年1月/」）', () => {
    assert.equal(periodDirOf('2026.1'), '2026年1月');
    assert.equal(periodDirOf('2026-12'), '2026年12月');
    assert.equal(periodDirOf('2026年3月'), '2026年3月');
    assert.equal(periodDirOf(''), '未分账期');
  });
  it('空目录占位：文件名与文案（保证包内目录结构与需求一致）', () => {
    assert.equal(PLACEHOLDER_NAME, '_说明.txt');
    const text = placeholderText('8.发票台账', '发票管理');
    assert.ok(text.includes('8.发票台账') && text.includes('发票管理'));
  });
});

describe('归档注册表（业务确认的目录口径）', () => {
  it('目录清单 = 用户确认的 13 类（无 4.收领单台账、无 12.采购文件）', () => {
    const dirs = ARCHIVE_CATEGORIES.map((c) => c.dir);
    assert.equal(ARCHIVE_CATEGORIES.length, 13);
    assert.ok(dirs.includes('5.物资结算/收领单'), '用户修正 1：新增收领单扫描件目录');
    assert.ok(dirs.includes('5.物资结算/月度结算单'), '用户修正 3：月度结算单是 Excel');
    assert.ok(dirs.includes('7.付款台账') && dirs.includes('10.保理与逾期利息') && dirs.includes('13.还款协议'));
    assert.ok(!dirs.some((d) => d.startsWith('4.')), '用户确认不补收领单台账目录');
    assert.ok(!dirs.some((d) => d.startsWith('12.')), '用户修正 7：12.采购文件明确不做');
  });
  it('key 不重复、dir 不重复（重复会让 ZIP 里两类混进同一目录）', () => {
    assert.equal(new Set(ARCHIVE_CATEGORIES.map((c) => c.key)).size, ARCHIVE_CATEGORIES.length);
    assert.equal(new Set(ARCHIVE_CATEGORIES.map((c) => c.dir)).size, ARCHIVE_CATEGORIES.length);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseImportDate, pickDictCode } from '../src/common/utils/import-parse.ts';
import { isSafeFileUrl, checkFileUrl } from '../src/common/utils/safe-url.ts';
import { assertSettlementProgress, SETTLEMENT_STATUS } from '../src/constants/workflowGuards.ts';
import { localDayKey } from '../src/common/utils/helpers.ts';
import { mapPrismaError } from '../src/common/utils/prisma-error.ts';

// 本地日期断言与机器时区相关：固定成业务时区，CI（UTC）与开发机（CST）跑出同一结果
process.env.TZ = 'Asia/Shanghai';

/**
 * 第 8/9 轮审计新增的三个纯函数守卫：
 * ① 导入行的日期/字典解析不能静默写错值；
 * ② 附件地址必须过协议白名单（否则 `javascript:` 就是存储型 XSS）；
 * ③ 结算状态只能沿链路前进（回退必须走驳回）。
 */

describe('parseImportDate：导入日期解析', () => {
  it('标准写法与常见变体都能解析成同一天', () => {
    const expect = new Date(2026, 0, 31);
    for (const raw of ['2026-01-31', '2026/1/31', '2026.1.31', '2026年1月31日', '2026-01-31 12:30']) {
      const r = parseImportDate(raw, '开票日期');
      assert.equal(r.error, undefined, `${raw} 不应报错`);
      assert.deepEqual(r.date, expect, `${raw} 应解析为 2026-01-31`);
    }
  });

  it('空值/占位符返回 null 而不是 1970 或 Invalid Date', () => {
    for (const raw of [null, undefined, '', '   ', '-', '—']) {
      assert.deepEqual(parseImportDate(raw), { date: null });
    }
  });

  it('不存在的日期被识破（2026-02-30 不会被 Date 顺延成 3-2）', () => {
    const r = parseImportDate('2026-02-30', '签订日期');
    assert.equal(r.date, null);
    assert.match(String(r.error), /不是真实存在的日期/);
  });

  it('Excel 序列号按 1899-12-30 基准换算（45000 → 2023-03-15）', () => {
    const r = parseImportDate(45000, '开票日期');
    assert.equal(r.error, undefined);
    assert.equal(r.date?.getFullYear(), 2023);
    assert.equal(r.date?.getMonth(), 2);
    assert.equal(r.date?.getDate(), 15);
  });

  it('乱写的中文/超范围年份给出带列名的错误', () => {
    assert.match(String(parseImportDate('去年三月', '进场日期').error), /「进场日期」不是有效日期/);
    assert.match(String(parseImportDate('1899-01-01').error), /超出范围/);
  });
});

describe('pickDictCode：导入字典项', () => {
  const items = [
    { itemCode: 'PURCHASE', itemName: '采购合同' },
    { itemCode: 'yes', itemName: '是' },
  ];

  it('按名称或编码都能命中', () => {
    assert.equal(pickDictCode(items, '采购合同'), 'PURCHASE');
    assert.equal(pickDictCode(items, 'PURCHASE'), 'PURCHASE');
  });

  it('空单元格允许留空', () => {
    assert.equal(pickDictCode(items, ''), null);
    assert.equal(pickDictCode(items, null), null);
  });

  it('非空但没命中返回 null，由调用方报行级错误（不能静默写 NULL）', () => {
    assert.equal(pickDictCode(items, '采购合'), null);
  });
});

describe('附件地址的协议白名单', () => {
  it('站内路径与 http(s) 放行', () => {
    for (const url of ['/api/files/2026-10-abc.pdf', 'https://example.com/a.pdf', 'http://1.2.3.4/b.xlsx']) {
      assert.equal(isSafeFileUrl(url), true, url);
    }
  });

  it('javascript:/data:/协议相对地址一律拒绝', () => {
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:fetch("/api/auth/profile")', 'data:text/html,<script>1</script>', '//evil.example.com/x.pdf', 'vbscript:msgbox', 'file:///etc/passwd']) {
      assert.equal(isSafeFileUrl(url), false, url);
    }
  });

  it('checkFileUrl 区分「没填」「非法」「合法」', () => {
    assert.deepEqual(checkFileUrl(''), { url: null });
    assert.match(String(checkFileUrl('javascript:alert(1)', '第 1 个附件的地址').error), /只能填站内路径/);
    assert.deepEqual(checkFileUrl('/api/files/a.pdf'), { url: '/api/files/a.pdf' });
  });
});

describe('结算状态只能沿链路前进', () => {
  it('不变或前进都放行', () => {
    assert.doesNotThrow(() => assertSettlementProgress(SETTLEMENT_STATUS.DRAFT, SETTLEMENT_STATUS.PENDING));
    assert.doesNotThrow(() => assertSettlementProgress(SETTLEMENT_STATUS.PENDING, SETTLEMENT_STATUS.CONFIRMED));
    assert.doesNotThrow(() => assertSettlementProgress(SETTLEMENT_STATUS.DONE, SETTLEMENT_STATUS.DONE));
  });

  it('回退到草稿必须走驳回', () => {
    assert.throws(
      () => assertSettlementProgress(SETTLEMENT_STATUS.DONE, SETTLEMENT_STATUS.DRAFT),
      /不能把结算单直接改回「草稿」/,
    );
  });

  it('其他回退方向被拒并提示用驳回', () => {
    assert.throws(
      () => assertSettlementProgress(SETTLEMENT_STATUS.CONFIRMED, SETTLEMENT_STATUS.PENDING),
      /回退到/,
    );
  });

  it('未知状态直接判非法', () => {
    assert.throws(() => assertSettlementProgress(SETTLEMENT_STATUS.PENDING, 'NOT_A_STATUS'), /取值非法/);
  });
});

/**
 * 第 21 轮审计新增的三个「不许回退」守卫：
 * ① 单据编号/归档包名必须用**本地**日期（UTC 会让北京时间凌晨开出来的单号写成前一天）；
 * ② Prisma 写冲突要映射成 4xx + 人话，不能把表名/列名/SQL 片段回给前端，也不能一律 500；
 * ③ 用户接口不许写 `isSuperAdmin`（超管在权限守卫里直接短路，等于自我提权）。
 */
describe('localDayKey：单据日期用本地时区', () => {
  it('跨零点后仍是当天（不因 UTC 退到前一天）', () => {
    // 2026-10-21T16:30Z === 北京时间 2026-10-22 00:30 → 单据日期必须是 10-22
    const utcLateNight = new Date('2026-10-21T16:30:00Z');
    assert.equal(utcLateNight.toISOString().slice(0, 10), '2026-10-21', '前提：UTC 日期是前一天');
    assert.equal(localDayKey(utcLateNight), '2026-10-22');
  });

  it('补零格式固定 YYYY-MM-DD', () => {
    assert.equal(localDayKey(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(localDayKey(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31');
  });

  it('非法日期返回空串而不是 NaN-NaN-NaN', () => {
    assert.equal(localDayKey('not-a-date'), '');
  });
});

describe('mapPrismaError：写冲突映射成 4xx 人话', () => {
  it('唯一键冲突 → 400 且带字段名', () => {
    const r = mapPrismaError({ code: 'P2002', meta: { target: ['projectId', 'code'] } });
    assert.equal(r?.status, 400);
    assert.match(String(r?.message), /数据重复/);
    assert.match(String(r?.message), /projectId/);
  });

  it('外键被引用 → 400（不是 500）', () => {
    const r = mapPrismaError({ code: 'P2003', meta: { target: 'supplierId' } });
    assert.equal(r?.status, 400);
    assert.match(String(r?.message), /关联数据/);
  });

  it('记录不存在 → 404', () => {
    const r = mapPrismaError({ code: 'P2025' });
    assert.equal(r?.status, 404);
    assert.match(String(r?.message), /不存在/);
  });

  it('未知异常不映射（仍走 500，原文不外泄）', () => {
    assert.equal(mapPrismaError(new Error('connect ECONNREFUSED 10.0.0.1:5432')), null);
    assert.equal(mapPrismaError({ code: 'P1001' }), null);
    assert.equal(mapPrismaError(null), null);
  });

  it('约束字段名只采信白名单字符，挡掉拼接注入', () => {
    const r = mapPrismaError({ code: 'P2002', meta: { target: ["x', (SELECT 1)) --"] } });
    assert.equal(r?.status, 400);
    assert.ok(!String(r?.message).includes('SELECT 1'));
  });
});

describe('用户写白名单：不许自我提权', () => {
  it('system.service.ts 的 USER_WRITABLE_FIELDS 不含 isSuperAdmin', async () => {
    const src = await readFile(join(__dirname, '../src/modules/system/system.service.ts'), 'utf8');
    const line = src.split('\n').find((l) => l.includes('const USER_WRITABLE_FIELDS'));
    assert.ok(line, '必须能找到白名单定义');
    assert.ok(!line!.includes('isSuperAdmin'), `白名单混入了 isSuperAdmin：${line}`);
  });
});

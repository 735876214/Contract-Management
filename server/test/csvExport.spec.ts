import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, toCsv } from '../src/common/utils/csv.ts';
import { pickFields, MAX_FIELD_TEXT } from '../src/common/pick-fields.ts';

/**
 * 导出与校验层的两个兜底（2026-10-21 第 16、19 轮审计）。
 *
 * ① CSV 公式注入：合同物资清单导出的「备注/物资名称」是用户可填字段，Excel 打开 CSV 时
 *    会把 `=cmd|'/c calc'!A1` 当公式执行 → 必须在导出侧补单引号。
 * ② 字段长度：控制器普遍 `@Body() body: any`（无 DTO），Prisma 的 String 是 PostgreSQL text，
 *    没有长度约束，几 MB 的 remark 也能存进库 → pickFields 统一兜上限。
 */

describe('CSV 单元格：公式注入防护', () => {
  it('以 = + - @ 开头的值补单引号', () => {
    assert.equal(csvCell('=cmd|\'/c calc\'!A1'), "'=cmd|'/c calc'!A1");
    assert.equal(csvCell('+1+1'), "'+1+1");
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  });

  it('负数与小数是数字，不能被当成注入加引号', () => {
    assert.equal(csvCell(-5), '-5');
    assert.equal(csvCell('-5'), '-5');
    assert.equal(csvCell('12.34'), '12.34');
    // 但 -5 后面带非数字就是文本，要防护
    assert.equal(csvCell('-5+cmd'), "'-5+cmd");
  });

  it('含逗号、引号、换行的值按 RFC 4180 包裹并转义引号', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('他说"行"'), '"他说""行"""');
    assert.equal(csvCell('第一行\n第二行'), '"第一行\n第二行"');
  });

  it('空值给空串；二维数组按行拼接', () => {
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
    assert.equal(toCsv([['序号', '备注'], [1, '=1+1']]), `序号,备注\r\n1,'=1+1`);
  });
});

describe('pickFields：白名单 + 文本长度上限', () => {
  it('白名单外的字段被丢弃，白名单内保留', () => {
    const out = pickFields({ name: '合同', projectId: 'x', createdBy: 'y' }, ['name']);
    assert.deepEqual(out, { name: '合同' });
  });

  it('超长文本抛 400，而不是把几 MB 塞进库', () => {
    const long = 'a'.repeat(MAX_FIELD_TEXT + 1);
    assert.throws(() => pickFields({ remark: long }, ['remark']), /内容过长/);
    // 恰好等于上限放行
    assert.equal(pickFields({ remark: 'a'.repeat(MAX_FIELD_TEXT) }, ['remark']).remark.length, MAX_FIELD_TEXT);
  });

  it('非字符串值不参与长度检查（数字、jsonb、布尔）', () => {
    const out = pickFields({ amount: 1000, formData: { a: 1 }, isFramework: true }, ['amount', 'formData', 'isFramework']);
    assert.equal(out.amount, 1000);
    assert.deepEqual(out.formData, { a: 1 });
    assert.equal(out.isFramework, true);
  });
});

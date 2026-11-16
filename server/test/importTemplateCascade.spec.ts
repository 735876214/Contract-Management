import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  ImportTemplateService,
  cascadeRangeName,
  sanitizeDefinedName,
} from '../src/common/services/import-template.service.ts';

/**
 * 通用导入模板的**级联下拉**（2026-10-18，物资基础库一/二级分类需求）。
 *
 * Excel 原生级联 = 命名区域 + `INDIRECT("<前缀>_" & 父级单元格)`；三件事会悄悄坏掉：
 * ① 父级选项文本含空格/特殊字符 → 命名区域名非法或 INDIRECT 命不中（用 SUBSTITUTE 只能救空格）；
 * ② 同名子选项跨父级重复（如「型钢」同属工程材料/周转材料）→ 各自成组，不能去重合并；
 * ③ 命名区域没注册或范围错 → Excel 打开即报「名称冲突/无效引用」。
 * 纯函数读回 xlsx 逐项断言（真实序列化路径）。
 */

describe('sanitizeDefinedName / cascadeRangeName', () => {
  it('非法字符替换为下划线，中文字符保留', () => {
    assert.equal(sanitizeDefinedName('工程材料'), '工程材料');
    assert.equal(sanitizeDefinedName('资金 费用'), '资金_费用');
    assert.equal(sanitizeDefinedName('A-B.C'), 'A_B_C');
    assert.equal(sanitizeDefinedName(undefined as any), '');
  });

  it('cascadeRangeName = 前缀_父级（各自合法化）', () => {
    assert.equal(cascadeRangeName('二级分类', '工程材料'), '二级分类_工程材料');
    assert.equal(cascadeRangeName('sub', '资金 费用'), 'sub_资金_费用');
  });
});

describe('ImportTemplateService 级联下拉', () => {
  const build = async () => {
    const tpl = new ImportTemplateService();
    const { buffer } = await tpl.buildTemplate({
      moduleName: '测试',
      sheetName: '数据',
      columns: [
        { label: '一级', key: 'l1', type: 'select', options: ['工程材料', '周转材料', '空组'] },
        {
          label: '二级',
          key: 'l2',
          type: 'cascader',
          cascadeFrom: 'l1',
          cascadePrefix: '二级分类',
          cascade: {
            工程材料: ['钢筋', '型钢'],
            周转材料: ['模板木方', '型钢'],
            空组: [],
          },
        },
      ],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    return wb;
  };

  it('每个非空父级注册命名区域，指向「选项」表的分组列', async () => {
    const wb = await build();
    const names = new Map(wb.definedNames.model.map((n: any) => [n.name, n.ranges[0]]));
    // 空组不注册（没有子选项）；同名子选项跨父级各自成组（工程材料/周转材料各有一段）
    assert.equal(names.get('二级分类_工程材料'), "'选项'!$B$2:$B$3");
    assert.equal(names.get('二级分类_周转材料'), "'选项'!$C$2:$C$3");
    assert.ok(!names.has('二级分类_空组'), '空父级不注册命名区域');
    assert.equal(names.size, 2);
  });

  it('子级列数据验证 = INDIRECT(前缀_ & SUBSTITUTE(父级单元格))，全数据区生效', async () => {
    const wb = await build();
    const first = wb.worksheets[0].getCell('B3').dataValidation;
    assert.equal(first.type, 'list');
    assert.match(first.formulae[0], /^INDIRECT\("二级分类_"&SUBSTITUTE\(A3," ","_"\)\)$/);
    // 最后一行（第 3 + 5000 - 1 行）也有验证
    const last = wb.worksheets[0].getCell('B5002').dataValidation;
    assert.match(last.formulae[0], /SUBSTITUTE\(A5002/);
  });

  it('选项表按父级分组写列，组内含全部子选项（同名不合并）', async () => {
    const wb = await build();
    const opt = wb.worksheets.find((w) => w.name === '选项');
    // 普通下拉占 A 列，级联组从 B 列起
    assert.deepEqual(opt.getColumn(2).values.slice(1, 4), ['二级（工程材料）', '钢筋', '型钢']);
    assert.deepEqual(opt.getColumn(3).values.slice(1, 4), ['二级（周转材料）', '模板木方', '型钢']);
    assert.equal(opt.state, 'hidden', '选项表保持隐藏');
  });

  it('普通 select 列不受级联列影响（列段照旧）', async () => {
    const wb = await build();
    const names = new Set(wb.definedNames.model.map((n: any) => n.name));
    assert.ok(![...names].some((n) => n.startsWith('一级')), '普通下拉不注册命名区域');
    const dv = wb.worksheets[0].getCell('A3').dataValidation;
    assert.match(dv.formulae[0], /^选项!\$A\$2:\$A\$4$/);
  });

  it('无级联列时行为与旧版一致（不建命名区域）', async () => {
    const tpl = new ImportTemplateService();
    const { buffer } = await tpl.buildTemplate({
      moduleName: '普通',
      columns: [{ label: '状态', key: 's', type: 'select', options: ['是', '否'] }],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    assert.equal(wb.definedNames.model.length, 0);
  });
});

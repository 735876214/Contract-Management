import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { bootIntApp, uniq, type IntContext } from './helpers';
import { MaterialService } from '../src/modules/material/material.service';
import { DictService } from '../src/modules/dict/dict.service';

/**
 * 集成测试 · 物资一/二级分类字典（业务 2026-10-18 分类表）。
 * 验的是启动同步真的落库，以及创建物资基础库时分类必须引用规范项且二级挂在一级下。
 */
describe('集成 · 物资分类字典与基础库引用', () => {
  let ctx: IntContext;
  let material: MaterialService;
  let dict: DictService;

  before(async () => {
    ctx = await bootIntApp();
    material = ctx.get<MaterialService>(MaterialService);
    dict = ctx.get<DictService>(DictService);
  });
  after(async () => {
    await ctx.app.close();
  });

  const base = (over: Record<string, any> = {}) => ({
    name: uniq('分类测试物资'),
    spec: uniq('SPEC'),
    unit: 'T',
    isAsset: false,
    isSafetyMaterial: false,
    categoryLevel1: '工程材料',
    categoryLevel2: '钢筋',
    ...over,
  });

  it('字典同步：一级 10 项、二级 67 项，二级挂到一级编码下', async () => {
    const l1 = await dict.options('material_category');
    const l2 = await dict.options('material_type');
    assert.equal(l1.length, 10);
    assert.equal(l2.length, 67);
    const ci = l2.find((i: any) => i.itemName === 'CI材料');
    assert.equal(ci?.extField1, 'CI');
    const steel = l2.filter((i: any) => i.itemName === '型钢');
    assert.equal(steel.length, 2, '「型钢」同名分属工程材料/周转材料');
    assert.deepEqual(new Set(steel.map((i: any) => i.extField1)), new Set(['ENG', 'TURNOVER']));
  });

  it('创建物资：合法分类存名称；同名二级按一级归位', async () => {
    const a: any = await material.createBase(base());
    assert.equal(a.categoryLevel1, '工程材料');
    assert.equal(a.categoryLevel2, '钢筋');
    await ctx.prisma.materialBase.delete({ where: { id: a.id } });

    const b: any = await material.createBase(
      base({ categoryLevel1: '周转材料', categoryLevel2: '型钢' }),
    );
    assert.equal(b.categoryLevel1, '周转材料');
    assert.equal(b.categoryLevel2, '型钢');
    await ctx.prisma.materialBase.delete({ where: { id: b.id } });
  });

  it('二级不属于所选一级 → 400；旧分类名 → 400', async () => {
    await assert.rejects(
      () => material.createBase(base({ categoryLevel1: '工程材料', categoryLevel2: '租赁物资' })),
      /不属于一级分类/,
    );
    await assert.rejects(
      () => material.createBase(base({ categoryLevel1: '安全材料', categoryLevel2: '劳保用品' })),
      /一级分类不在字典范围内/,
    );
  });

  it('只传二级时自动带出所属一级', async () => {
    const created: any = await material.createBase(
      base({ categoryLevel1: null, categoryLevel2: '混凝土' }),
    );
    assert.equal(created.categoryLevel1, '工程材料');
    assert.equal(created.categoryLevel2, '混凝土');
    await ctx.prisma.materialBase.delete({ where: { id: created.id } });
  });

  it('导入模板预置一/二级分类下拉（数据验证 + 隐藏选项表）', async () => {
    const { buffer } = await material.templateBases();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('数据')!;
    const opt = wb.getWorksheet('选项')!;
    assert.ok(ws && opt, '模板应包含「数据」与隐藏「选项」表');
    assert.equal(opt.state, 'hidden');

    // C = 一级分类，D = 二级分类（表头顺序见 templateBases）
    assert.equal(ws.getCell(3, 3).dataValidation?.type, 'list');
    assert.equal(ws.getCell(3, 4).dataValidation?.type, 'list');
    assert.match(String(ws.getCell(3, 3).dataValidation?.formulae?.[0] || ''), /选项!/);
    assert.match(String(ws.getCell(3, 4).dataValidation?.formulae?.[0] || ''), /选项!/);

    const optionValues = new Set<string>();
    for (let c = 1; c <= opt.columnCount; c++) {
      opt.getColumn(c).eachCell((cell) => {
        if (cell.value) optionValues.add(String(cell.value));
      });
    }
    assert.ok(optionValues.has('工程材料'));
    assert.ok(optionValues.has('智慧工地'));
    assert.ok(optionValues.has('钢模板'));
    assert.ok(optionValues.has('绿色施工'));
  });
});

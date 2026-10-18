import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { bootIntApp, uniq, type IntContext } from './helpers';
import { MaterialService } from '../src/modules/material/material.service';
import { DictService } from '../src/modules/dict/dict.service';
import { fixLegacyData } from '../src/seed';

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

    // C = 一级分类（普通下拉），D = 二级分类（级联：INDIRECT 随 C 列联动）
    assert.equal(ws.getCell(3, 3).dataValidation?.type, 'list');
    assert.equal(ws.getCell(3, 4).dataValidation?.type, 'list');
    assert.match(String(ws.getCell(3, 3).dataValidation?.formulae?.[0] || ''), /选项!/);
    assert.match(String(ws.getCell(3, 4).dataValidation?.formulae?.[0] || ''), /INDIRECT\("二级分类_/);

    // 级联后「选项」表按命名区域分组：父级列（一级）+ 每个父级一列子选项。
    // 用定义名称断言（真实序列化路径），而不是扫列。
    // DefinedNamesModel = [{ name, ranges }]；读回后 model 可能需要先 getAll
    const names = new Set<string>();
    const dnModel = (wb as any).definedNames.model || [];
    for (const dn of dnModel) names.add(dn.name);
    assert.ok(names.has('二级分类_工程材料'), '应有工程材料子级命名区域');
    assert.ok(names.has('二级分类_周转材料'), '应有周转材料子级命名区域');
    assert.ok(names.has('二级分类_智慧工地'), '应有智慧工地子级命名区域');
  });

  it('再次启动同步不覆盖字典管理里手工维护的分类', async () => {
    const custom = await ctx.prisma.dictItem.create({
      data: {
        typeCode: 'material_type',
        itemCode: `CUSTOM_${uniq('X').toUpperCase()}`,
        itemName: '自定义分类',
        status: 1,
        extField1: 'ENG',
      },
    });
    const canonical = await ctx.prisma.dictItem.findUnique({
      where: { typeCode_itemCode: { typeCode: 'material_category', itemCode: 'ENG' } },
    });
    assert.ok(canonical);
    await ctx.prisma.dictItem.update({ where: { id: canonical!.id }, data: { itemName: '工程材料（自定义）' } });

    await fixLegacyData(ctx.prisma);

    const customAfter = await ctx.prisma.dictItem.findUnique({ where: { id: custom.id } });
    assert.equal(customAfter?.status, 1, '业务新增分类不得被启动同步停用');
    assert.equal(customAfter?.itemName, '自定义分类');
    const canonicalAfter = await ctx.prisma.dictItem.findUnique({ where: { id: canonical!.id } });
    assert.equal(canonicalAfter?.itemName, '工程材料（自定义）', '手工改名不得被启动同步回滚');

    // 还原，避免影响同文件后续/重复运行
    await ctx.prisma.dictItem.update({ where: { id: canonical!.id }, data: { itemName: '工程材料' } });
    await ctx.prisma.dictItem.delete({ where: { id: custom.id } });
  });
});

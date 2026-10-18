import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_CATEGORY_CODE_MAP,
  LEGACY_CATEGORY_NAME_MAP,
  MATERIAL_CATEGORY_L1,
  MATERIAL_CATEGORY_L2,
} from '../src/constants/materialCategories.ts';

/**
 * 物资一/二级分类表（业务 2026-10-18 提供）：
 * 锁分类数量、编码唯一性、二级必须挂到存在的一级，以及旧数据映射的目标都存在。
 */
describe('物资分类字典（2026-10-18 分类表）', () => {
  it('一级分类 10 个，编码唯一', () => {
    assert.equal(MATERIAL_CATEGORY_L1.length, 10);
    const codes = MATERIAL_CATEGORY_L1.map((i) => i.code);
    assert.equal(new Set(codes).size, codes.length);
    assert.deepEqual(
      MATERIAL_CATEGORY_L1.map((i) => i.name),
      ['工程材料', '周转材料', 'CI材料', '其他', '机械设备', '资金费用', '服务人工类', '扣罚调差', '租赁物资', '智慧工地'],
    );
  });

  it('二级分类 67 个，编码唯一且父级存在', () => {
    assert.equal(MATERIAL_CATEGORY_L2.length, 67);
    const codes = MATERIAL_CATEGORY_L2.map((i) => i.code);
    assert.equal(new Set(codes).size, codes.length, '二级分类编码必须唯一');
    const parents = new Set(MATERIAL_CATEGORY_L1.map((i) => i.code));
    for (const it of MATERIAL_CATEGORY_L2) {
      assert.ok(parents.has(it.parent), `${it.code} 的父级 ${it.parent} 不存在`);
    }
    // 同名二级允许（如「型钢」分属工程材料/周转材料），但 (父级, 名称) 不能重复
    const pairs = MATERIAL_CATEGORY_L2.map((i) => `${i.parent}|${i.name}`);
    assert.equal(new Set(pairs).size, pairs.length);
  });

  it('每个一级分类至少挂一个二级分类', () => {
    const withChildren = new Set(MATERIAL_CATEGORY_L2.map((i) => i.parent));
    for (const l1 of MATERIAL_CATEGORY_L1) {
      assert.ok(withChildren.has(l1.code), `${l1.name} 没有二级分类`);
    }
  });

  it('旧编码/旧名称映射的目标都在新表中', () => {
    const l1Codes = new Set(MATERIAL_CATEGORY_L1.map((i) => i.code));
    const l2Codes = new Set(MATERIAL_CATEGORY_L2.map((i) => i.code));
    for (const m of LEGACY_CATEGORY_CODE_MAP) {
      const target = m.typeCode === 'material_category' ? l1Codes : l2Codes;
      assert.ok(target.has(m.to), `旧编码 ${m.from} → ${m.to} 的目标不存在`);
    }
    const l1Names = new Set(MATERIAL_CATEGORY_L1.map((i) => i.name));
    const l2Names = new Set(MATERIAL_CATEGORY_L2.map((i) => i.name));
    for (const m of LEGACY_CATEGORY_NAME_MAP) {
      const target = m.field === 'categoryLevel1' ? l1Names : l2Names;
      assert.ok(target.has(m.to), `旧名称 ${m.from} → ${m.to} 的目标不存在`);
    }
  });
});

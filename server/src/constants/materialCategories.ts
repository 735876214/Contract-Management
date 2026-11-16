/**
 * 物资一/二级分类的**单一事实源**（2026-10-18 业务提供的分类表）。
 *
 * 落库位置：
 * - 一级分类 → 字典 `material_category`（value = itemCode，展示 = itemName）；
 * - 二级分类 → 字典 `material_type`（`extField1` = 所属一级分类 itemCode）；
 * - `MaterialBase.categoryLevel1/2` 存**名称**（与前端下拉一致），创建/更新时由
 *   `MaterialService.resolveCategories()` 校验并从字典取值，避免写入表外分类。
 *
 * 启动时由 `server/src/seed.ts` 的 `seedMaterialCategoryDicts()` 幂等同步：
 * 新增/改名、旧编码映射（历史日报）、表外项停用；同时停用历史遗留的
 * `material_category_l1/l2` 两套重复字典（代码从未引用）。
 *
 * 零依赖，供 `.mts` 单测直接加载（`server/test/materialCategories.spec.mts`）。
 */

export interface MaterialCategoryL1 {
  code: string;
  name: string;
  color: string;
  sortOrder: number;
}

export interface MaterialCategoryL2 {
  code: string;
  name: string;
  /** 所属一级分类 itemCode */
  parent: string;
  sortOrder: number;
}

export const MATERIAL_CATEGORY_L1: MaterialCategoryL1[] = [
  { code: 'ENG', name: '工程材料', color: 'blue', sortOrder: 0 },
  { code: 'TURNOVER', name: '周转材料', color: 'cyan', sortOrder: 1 },
  { code: 'CI', name: 'CI材料', color: 'purple', sortOrder: 2 },
  { code: 'OTHER', name: '其他', color: 'default', sortOrder: 3 },
  { code: 'MACHINERY', name: '机械设备', color: 'geekblue', sortOrder: 4 },
  { code: 'FUND', name: '资金费用', color: 'gold', sortOrder: 5 },
  { code: 'SERVICE', name: '服务人工类', color: 'green', sortOrder: 6 },
  { code: 'PENALTY', name: '扣罚调差', color: 'red', sortOrder: 7 },
  { code: 'LEASE', name: '租赁物资', color: 'magenta', sortOrder: 8 },
  { code: 'SMART_SITE', name: '智慧工地', color: 'volcano', sortOrder: 9 },
];

export const MATERIAL_CATEGORY_L2: MaterialCategoryL2[] = [
  // 工程材料
  { code: 'REBAR', name: '钢筋', parent: 'ENG', sortOrder: 0 },
  { code: 'SECTION_STEEL', name: '型钢', parent: 'ENG', sortOrder: 1 },
  { code: 'PC_STRAND', name: '钢绞线', parent: 'ENG', sortOrder: 2 },
  { code: 'OTHER_STEEL', name: '其他钢材', parent: 'ENG', sortOrder: 3 },
  { code: 'CONCRETE', name: '混凝土', parent: 'ENG', sortOrder: 4 },
  { code: 'CEMENT', name: '水泥', parent: 'ENG', sortOrder: 5 },
  { code: 'SAND', name: '砂子', parent: 'ENG', sortOrder: 6 },
  { code: 'GRAVEL', name: '碎石', parent: 'ENG', sortOrder: 7 },
  { code: 'OTHER_STONE', name: '其他石材', parent: 'ENG', sortOrder: 8 },
  { code: 'FLY_ASH', name: '粉煤灰', parent: 'ENG', sortOrder: 9 },
  { code: 'ADMIXTURE', name: '外加剂', parent: 'ENG', sortOrder: 10 },
  { code: 'LIME', name: '石灰', parent: 'ENG', sortOrder: 11 },
  { code: 'SLAG_POWDER', name: '矿粉', parent: 'ENG', sortOrder: 12 },
  { code: 'BACKFILL', name: '回填料', parent: 'ENG', sortOrder: 13 },
  { code: 'CEMENT_STABILIZED_GRAVEL', name: '水泥稳定碎石', parent: 'ENG', sortOrder: 14 },
  { code: 'ASPHALT', name: '沥青类', parent: 'ENG', sortOrder: 15 },
  { code: 'CEMENT_PRODUCTS', name: '水泥及砼制品', parent: 'ENG', sortOrder: 16 },
  { code: 'EXPANSION_JOINT', name: '伸缩缝', parent: 'ENG', sortOrder: 17 },
  { code: 'BEARING', name: '支座', parent: 'ENG', sortOrder: 18 },
  { code: 'ANCHORAGE', name: '锚具', parent: 'ENG', sortOrder: 19 },
  { code: 'GEO_MATERIAL', name: '土工材料', parent: 'ENG', sortOrder: 20 },
  { code: 'WATER_SUPPLY_DRAINAGE', name: '给排水材料', parent: 'ENG', sortOrder: 21 },
  { code: 'OTHER_ENG', name: '其他工程材料', parent: 'ENG', sortOrder: 22 },
  // 周转材料
  { code: 'STEEL_FORMWORK', name: '钢模板', parent: 'TURNOVER', sortOrder: 23 },
  { code: 'TURNOVER_SECTION_STEEL', name: '型钢', parent: 'TURNOVER', sortOrder: 24 },
  { code: 'WEIGHING_EQUIPMENT', name: '称重设备', parent: 'TURNOVER', sortOrder: 25 },
  { code: 'CONTAINER_HOUSE', name: '箱式房', parent: 'TURNOVER', sortOrder: 26 },
  { code: 'PREFAB_HOUSE', name: '板房', parent: 'TURNOVER', sortOrder: 27 },
  { code: 'ENCLOSURE', name: '围挡类', parent: 'TURNOVER', sortOrder: 28 },
  { code: 'TRANSFORMER', name: '变压器', parent: 'TURNOVER', sortOrder: 29 },
  { code: 'DISTRIBUTION_BOX', name: '配电箱', parent: 'TURNOVER', sortOrder: 30 },
  { code: 'CABLE', name: '电缆线', parent: 'TURNOVER', sortOrder: 31 },
  { code: 'ROAD_STEEL_PLATE', name: '道路钢板', parent: 'TURNOVER', sortOrder: 32 },
  { code: 'TIMBER', name: '木方', parent: 'TURNOVER', sortOrder: 33 },
  { code: 'OTHER_TURNOVER', name: '其他周转材料', parent: 'TURNOVER', sortOrder: 34 },
  // CI材料
  { code: 'CI_MATERIAL', name: 'CI材料', parent: 'CI', sortOrder: 35 },
  // 其他
  { code: 'LABOR_PROTECTION', name: '劳保用品', parent: 'OTHER', sortOrder: 36 },
  { code: 'FIRE_EQUIPMENT', name: '消防器材', parent: 'OTHER', sortOrder: 37 },
  { code: 'OFFICE_SUPPLIES', name: '生活办公', parent: 'OTHER', sortOrder: 38 },
  { code: 'OTHER_MATERIALS', name: '其他材料', parent: 'OTHER', sortOrder: 39 },
  // 机械设备
  { code: 'TUNNEL_TOOLING', name: '隧道工装', parent: 'MACHINERY', sortOrder: 40 },
  { code: 'LARGE_MACHINERY', name: '大型机械设备', parent: 'MACHINERY', sortOrder: 41 },
  { code: 'SMALL_MACHINERY', name: '小型机械设备', parent: 'MACHINERY', sortOrder: 42 },
  { code: 'MACHINERY_PARTS', name: '机械配件', parent: 'MACHINERY', sortOrder: 43 },
  { code: 'TESTING_EQUIPMENT', name: '检测设备', parent: 'MACHINERY', sortOrder: 44 },
  { code: 'MEASURING_INSTRUMENT', name: '测量仪器', parent: 'MACHINERY', sortOrder: 45 },
  { code: 'TOOLS', name: '工具用具', parent: 'MACHINERY', sortOrder: 46 },
  { code: 'FUEL_OIL', name: '燃料机油', parent: 'MACHINERY', sortOrder: 47 },
  { code: 'OTHER_MACHINERY', name: '其他机械设备相关', parent: 'MACHINERY', sortOrder: 48 },
  // 资金费用
  { code: 'FACTORING_DISCOUNT', name: '保理贴息', parent: 'FUND', sortOrder: 49 },
  { code: 'OVERDUE_INTEREST', name: '逾期利息', parent: 'FUND', sortOrder: 50 },
  { code: 'OTHER_FUND', name: '其他资金费用', parent: 'FUND', sortOrder: 51 },
  // 服务人工类
  { code: 'MAINTENANCE', name: '维护保养', parent: 'SERVICE', sortOrder: 52 },
  { code: 'MOBILIZATION_FEE', name: '进出场费用', parent: 'SERVICE', sortOrder: 53 },
  { code: 'SITE_TRANSFER', name: '场地转运', parent: 'SERVICE', sortOrder: 54 },
  { code: 'OTHER_SERVICE', name: '其他服务人工', parent: 'SERVICE', sortOrder: 55 },
  // 扣罚调差
  { code: 'PENALTY', name: '扣罚调差', parent: 'PENALTY', sortOrder: 56 },
  // 租赁物资
  { code: 'LEASE_MATERIAL', name: '租赁物资', parent: 'LEASE', sortOrder: 57 },
  // 智慧工地
  { code: 'NETWORK_INFRA', name: '网络基础设施', parent: 'SMART_SITE', sortOrder: 58 },
  { code: 'VIDEO_SURVEILLANCE', name: '视频监控', parent: 'SMART_SITE', sortOrder: 59 },
  { code: 'VIDEO_CONFERENCE', name: '视频会议', parent: 'SMART_SITE', sortOrder: 60 },
  { code: 'CONTROL_CENTER', name: '智控中心', parent: 'SMART_SITE', sortOrder: 61 },
  { code: 'MATERIAL_MANAGEMENT', name: '物料管理', parent: 'SMART_SITE', sortOrder: 62 },
  { code: 'PRODUCTION_DISPATCH', name: '生产调度', parent: 'SMART_SITE', sortOrder: 63 },
  { code: 'SAFETY_MANAGEMENT', name: '安全管理', parent: 'SMART_SITE', sortOrder: 64 },
  { code: 'TECH_QUALITY', name: '科技质量', parent: 'SMART_SITE', sortOrder: 65 },
  { code: 'GREEN_CONSTRUCTION', name: '绿色施工', parent: 'SMART_SITE', sortOrder: 66 },
];

/** 旧字典编码 → 新编码（历史日报行，启动时幂等迁移） */
export const LEGACY_CATEGORY_CODE_MAP: { typeCode: 'material_category' | 'material_type'; from: string; to: string }[] = [
  { typeCode: 'material_category', from: 'SAFETY', to: 'OTHER' },
  { typeCode: 'material_category', from: 'SUNDRY', to: 'OTHER' },
  { typeCode: 'material_type', from: 'STEEL', to: 'OTHER_STEEL' },
  { typeCode: 'material_type', from: 'FORMWORK', to: 'TIMBER' },
  { typeCode: 'material_type', from: 'SCAFFOLD', to: 'OTHER_TURNOVER' },
  { typeCode: 'material_type', from: 'HELMET', to: 'LABOR_PROTECTION' },
  { typeCode: 'material_type', from: 'NET', to: 'OTHER_MATERIALS' },
  { typeCode: 'material_type', from: 'TOOL', to: 'TOOLS' },
  { typeCode: 'material_type', from: 'CI_ITEM', to: 'CI_MATERIAL' },
  { typeCode: 'material_type', from: 'LEASE_STEEL', to: 'LEASE_MATERIAL' },
  { typeCode: 'material_type', from: 'LEASE_MACHINE', to: 'LEASE_MATERIAL' },
  { typeCode: 'material_type', from: 'FEE', to: 'OTHER_FUND' },
];

/** 旧分类名称 → 新名称（物资基础库存的是名称；启动时幂等迁移） */
export const LEGACY_CATEGORY_NAME_MAP: {
  field: 'categoryLevel1' | 'categoryLevel2';
  from: string;
  to: string;
}[] = [
  { field: 'categoryLevel1', from: 'CI类材料', to: 'CI材料' },
  { field: 'categoryLevel1', from: '安全材料', to: '其他' },
  { field: 'categoryLevel1', from: '零星材料', to: '其他' },
  { field: 'categoryLevel2', from: '商砼', to: '混凝土' },
  { field: 'categoryLevel2', from: '箱房', to: '箱式房' },
  { field: 'categoryLevel2', from: '地磅', to: '称重设备' },
  { field: 'categoryLevel2', from: '模板', to: '钢模板' },
  { field: 'categoryLevel2', from: '保底贴息', to: '保理贴息' },
  { field: 'categoryLevel2', from: 'CI标识牌', to: 'CI材料' },
];

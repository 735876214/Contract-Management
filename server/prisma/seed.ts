import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/** 字典定义：类型编码 -> { 名称, 字典项 } */
const DICTS: Record<string, { name: string; remark?: string; items: any[] }> = {
  yes_no: {
    name: '是/否',
    items: [
      { itemCode: 'Y', itemName: '是', color: 'green' },
      { itemCode: 'N', itemName: '否', color: 'default' },
    ],
  },
  industry_type: {
    name: '项目业态',
    items: [
      { itemCode: 'FACTORY', itemName: '厂房', color: 'blue' },
      { itemCode: 'RESIDENCE', itemName: '住宅', color: 'green' },
      { itemCode: 'RAIL_TRANSIT', itemName: '轨道交通', color: 'purple' },
      { itemCode: 'MUNICIPAL', itemName: '市政', color: 'cyan' },
      { itemCode: 'BRIDGE', itemName: '桥梁', color: 'orange' },
      { itemCode: 'RAILWAY', itemName: '铁路', color: 'geekblue' },
      { itemCode: 'PIPE_GALLERY', itemName: '管廊', color: 'gold' },
      { itemCode: 'OTHER', itemName: '其他', color: 'default' },
    ],
  },
  contract_sub_type: {
    name: '合同子类型',
    items: [
      { itemCode: 'SINGLE', itemName: '单项', color: 'blue' },
      { itemCode: 'EXEC', itemName: '执行', color: 'geekblue' },
    ],
  },
  contract_type: {
    name: '合同类型',
    items: [
      { itemCode: 'FRAMEWORK', itemName: '框架协议', color: 'blue' },
      { itemCode: 'PURCHASE', itemName: '采购合同', color: 'cyan' },
      { itemCode: 'PURCHASE_EXEC', itemName: '采购执行合同', color: 'geekblue' },
      { itemCode: 'LEASE', itemName: '租赁合同', color: 'purple' },
      { itemCode: 'LEASE_EXEC', itemName: '租赁执行合同', color: 'magenta' },
    ],
  },
  contract_execution_status: {
    name: '合同执行情况',
    items: [
      { itemCode: 'DRAFT', itemName: '草稿', color: 'default' },
      { itemCode: 'UNUSED', itemName: '未使用', color: 'orange' },
      { itemCode: 'EXECUTING', itemName: '执行中', color: 'processing' },
      { itemCode: 'DONE_UNSETTLED', itemName: '已完未结', color: 'gold' },
      { itemCode: 'DONE_SETTLED', itemName: '已完已结', color: 'green' },
    ],
  },
  approval_status: {
    name: '申请状态',
    items: [
      { itemCode: 'PENDING', itemName: '待处理', color: 'processing' },
      { itemCode: 'APPROVED', itemName: '已通过', color: 'green' },
      { itemCode: 'REJECTED', itemName: '已驳回', color: 'red' },
    ],
  },
  supplement_agreement_type: {
    name: '补充协议类型',
    items: [
      { itemCode: 'PRICE_UP', itemName: '涨价补充协议', color: 'volcano' },
      { itemCode: 'PRICE_DOWN', itemName: '降价补充协议', color: 'green' },
      { itemCode: 'ITEM_ADD', itemName: '增项补充协议', color: 'blue' },
      { itemCode: 'QTY_ADD', itemName: '增量补充协议', color: 'geekblue' },
      { itemCode: 'OTHER', itemName: '其他类补充协议', color: 'default' },
    ],
  },
  asset_status: {
    name: '资产状态',
    items: [
      { itemCode: 'IN_USE', itemName: '在用', color: 'green' },
      { itemCode: 'IDLE', itemName: '闲置', color: 'gold' },
      { itemCode: 'SCRAP', itemName: '报废', color: 'default' },
      { itemCode: 'LOST', itemName: '丢失', color: 'red' },
      { itemCode: 'DISPOSED', itemName: '处置', color: 'orange' },
    ],
  },
  asset_ledger_source: {
    name: '资产来源',
    items: [
      { itemCode: 'PURCHASE', itemName: '采购', color: 'blue' },
      { itemCode: 'TRANSFER_IN', itemName: '调入', color: 'cyan' },
      { itemCode: 'TRANSFER_OUT', itemName: '调出', color: 'orange' },
      { itemCode: 'TRANSFER_IN_FEE', itemName: '调入费', color: 'default' },
      { itemCode: 'MAINTENANCE', itemName: '维保费', color: 'default' },
      { itemCode: 'DISPOSE_SALE', itemName: '处置（出售）', color: 'red' },
      { itemCode: 'DISPOSE_RENT', itemName: '处置（出租）', color: 'purple' },
    ],
  },
  asset_category_l1: {
    name: '资产类别（一级）',
    items: [
      { itemCode: 'LARGE_EQUIP', itemName: '大型设备' },
      { itemCode: 'MACHINE', itemName: '机械设备' },
      { itemCode: 'OFFICE', itemName: '办公设施' },
      { itemCode: 'LIVING', itemName: '生活设施' },
      { itemCode: 'SAFETY', itemName: '安全文明施工设施' },
      { itemCode: 'TEMP_BUILD', itemName: '临建设施' },
      { itemCode: 'TOOLS', itemName: '工具用具' },
      { itemCode: 'TURNOVER', itemName: '周转料具' },
      { itemCode: 'OTHER', itemName: '其他资产' },
    ],
  },
  asset_category_focus: {
    name: '资产类别（重点关注）',
    items: [
      { itemCode: 'STEEL_FORM', itemName: '钢模板' },
      { itemCode: 'POWER', itemName: '配电设施' },
      { itemCode: 'CABLE', itemName: '电线电缆' },
      { itemCode: 'TEMP_HOUSE', itemName: '临时用房' },
      { itemCode: 'BOOTH', itemName: '亭棚类' },
      { itemCode: 'WEIGHING', itemName: '称重类' },
      { itemCode: 'SMART_SITE', itemName: '智慧工地' },
      { itemCode: 'FENCE', itemName: '施工围挡' },
      { itemCode: 'BRIDGE_PART', itemName: '钢便桥零件' },
      { itemCode: 'ROAD_STEEL', itemName: '道路钢板' },
      { itemCode: 'NONE', itemName: '非重点关注资产' },
    ],
  },
  material_source: {
    name: '来源',
    items: [
      { itemCode: 'PURCHASE', itemName: '采购', color: 'blue' },
      { itemCode: 'LEASE', itemName: '租赁', color: 'purple' },
      { itemCode: 'PROJ_TEAM_IN', itemName: '项目内部队伍调入', color: 'cyan' },
      { itemCode: 'BRANCH_IN', itemName: '分公司内部调入', color: 'cyan' },
      { itemCode: 'CROSS_BRANCH_IN', itemName: '跨分公司调入', color: 'geekblue' },
      { itemCode: 'PROJ_TEAM_OUT', itemName: '项目内部队伍调出', color: 'orange' },
      { itemCode: 'BRANCH_OUT', itemName: '分公司内部调出', color: 'orange' },
      { itemCode: 'CROSS_BRANCH_OUT', itemName: '跨分公司调出', color: 'volcano' },
      { itemCode: 'RETURN', itemName: '材料退货', color: 'red' },
      { itemCode: 'LABOR_RETURN', itemName: '劳务退库', color: 'magenta' },
      { itemCode: 'MIX_STATION', itemName: '自拌站', color: 'lime' },
      { itemCode: 'WASTE', itemName: '闲废处理', color: 'default' },
    ],
  },
  material_category: {
    name: '材料类别',
    items: [
      { itemCode: 'ENG', itemName: '工程材料', color: 'blue' },
      { itemCode: 'TURNOVER', itemName: '周转材料', color: 'cyan' },
      { itemCode: 'SAFETY', itemName: '安全材料', color: 'green' },
      { itemCode: 'SUNDRY', itemName: '零星材料', color: 'gold' },
      { itemCode: 'CI', itemName: 'CI类材料', color: 'purple' },
      { itemCode: 'LEASE', itemName: '租赁物资', color: 'magenta' },
      { itemCode: 'FUND', itemName: '资金费用', color: 'red' },
    ],
  },
  material_type: {
    name: '物资种类（关联材料类别）',
    remark: 'extField1 存储所属材料类别编码，实现与 material_category 联动',
    items: [
      { itemCode: 'STEEL', itemName: '钢材', extField1: 'ENG', color: 'blue' },
      { itemCode: 'CEMENT', itemName: '水泥', extField1: 'ENG', color: 'blue' },
      { itemCode: 'SAND', itemName: '砂石', extField1: 'ENG', color: 'cyan' },
      { itemCode: 'CONCRETE', itemName: '商品砼', extField1: 'ENG', color: 'cyan' },
      { itemCode: 'FORMWORK', itemName: '模板木方', extField1: 'TURNOVER', color: 'gold' },
      { itemCode: 'SCAFFOLD', itemName: '脚手架', extField1: 'TURNOVER', color: 'gold' },
      { itemCode: 'HELMET', itemName: '安全防护用品', extField1: 'SAFETY', color: 'green' },
      { itemCode: 'NET', itemName: '安全网', extField1: 'SAFETY', color: 'green' },
      { itemCode: 'TOOL', itemName: '小型机具', extField1: 'SUNDRY', color: 'default' },
      { itemCode: 'CI_ITEM', itemName: 'CI标识牌', extField1: 'CI', color: 'purple' },
      { itemCode: 'LEASE_STEEL', itemName: '租赁钢管', extField1: 'LEASE', color: 'magenta' },
      { itemCode: 'LEASE_MACHINE', itemName: '租赁机械', extField1: 'LEASE', color: 'magenta' },
      { itemCode: 'FEE', itemName: '资金费用类', extField1: 'FUND', color: 'red' },
    ],
  },
  measurement_unit: {
    name: '计量单位',
    items: [
      { itemCode: 'T', itemName: '吨(t)', color: 'blue' },
      { itemCode: 'M3', itemName: '立方米(m³)', color: 'blue' },
      { itemCode: 'M2', itemName: '平方米(㎡)', color: 'cyan' },
      { itemCode: 'M', itemName: '米(m)', color: 'cyan' },
      { itemCode: 'PCS', itemName: '件', color: 'default' },
      { itemCode: 'SET', itemName: '套', color: 'default' },
      { itemCode: 'UNIT', itemName: '台', color: 'default' },
      { itemCode: 'KG', itemName: '千克(kg)', color: 'default' },
    ],
  },
  invoice_type: {
    name: '发票类型',
    items: [
      { itemCode: 'VAT_SPECIAL', itemName: '增值税专用发票', color: 'red' },
      { itemCode: 'VAT_NORMAL', itemName: '增值税普通发票', color: 'orange' },
      { itemCode: 'OTHER', itemName: '其他', color: 'default' },
    ],
  },
  invoice_status: {
    name: '发票状态',
    items: [
      { itemCode: 'WAIT_VERIFY', itemName: '待查验', color: 'default' },
      { itemCode: 'VERIFIED', itemName: '已查验', color: 'blue' },
      { itemCode: 'CERTIFIED', itemName: '已认证', color: 'cyan' },
      { itemCode: 'DEDUCTED', itemName: '已抵扣', color: 'green' },
      { itemCode: 'ABNORMAL', itemName: '异常', color: 'red' },
      { itemCode: 'CANCELLED', itemName: '作废', color: 'default' },
      { itemCode: 'RED', itemName: '红冲', color: 'volcano' },
    ],
  },
  invoice_review_status: {
    name: '发票信息审核状态',
    items: [
      { itemCode: 'PENDING', itemName: '待审核', color: 'default' },
      { itemCode: 'PASSED', itemName: '审核通过', color: 'green' },
      { itemCode: 'REJECTED', itemName: '审核不通过', color: 'red' },
    ],
  },
  finance_transfer_status: {
    name: '财务移交情况',
    items: [
      { itemCode: 'NOT_TRANSFERRED', itemName: '未移交', color: 'default' },
      { itemCode: 'TRANSFERRING', itemName: '移交中', color: 'processing' },
      { itemCode: 'TRANSFERRED', itemName: '已移交', color: 'green' },
    ],
  },
  goods_category: {
    name: '商品类别',
    items: [
      { itemCode: 'MATERIAL', itemName: '材料', color: 'blue' },
      { itemCode: 'LEASE', itemName: '租赁', color: 'purple' },
      { itemCode: 'SERVICE', itemName: '服务', color: 'cyan' },
      { itemCode: 'OTHER', itemName: '其他', color: 'default' },
    ],
  },
  settlement_type: {
    name: '结算类型',
    items: [
      { itemCode: 'ADVANCE', itemName: '预付款', color: 'orange' },
      { itemCode: 'PROGRESS', itemName: '进度款', color: 'blue' },
      { itemCode: 'FINAL', itemName: '尾款', color: 'cyan' },
      { itemCode: 'WARRANTY', itemName: '质保金', color: 'gold' },
    ],
  },
  settlement_status: {
    name: '结算状态',
    items: [
      { itemCode: 'DRAFT', itemName: '草稿', color: 'default' },
      { itemCode: 'PENDING', itemName: '待确认', color: 'processing' },
      { itemCode: 'CONFIRMED', itemName: '已确认', color: 'blue' },
      { itemCode: 'INVOICED', itemName: '已开票', color: 'cyan' },
      { itemCode: 'PAID', itemName: '已付款', color: 'green' },
      { itemCode: 'DONE', itemName: '已完成', color: 'green' },
    ],
  },
  payment_method: {
    name: '付款方式',
    items: [
      { itemCode: 'TRANSFER', itemName: '银行转账', color: 'blue' },
      { itemCode: 'ACCEPTANCE', itemName: '银行承兑', color: 'cyan' },
      { itemCode: 'COMMERCIAL', itemName: '商业承兑', color: 'purple' },
      { itemCode: 'FACTORING', itemName: '保理', color: 'orange' },
      { itemCode: 'CASH', itemName: '现金', color: 'default' },
      { itemCode: 'OFFSET', itemName: '抵账', color: 'gold' },
    ],
  },
  payment_status: {
    name: '付款状态',
    items: [
      { itemCode: 'PENDING', itemName: '待付款', color: 'default' },
      { itemCode: 'PARTIAL', itemName: '部分付款', color: 'orange' },
      { itemCode: 'PAID', itemName: '已付款', color: 'green' },
      { itemCode: 'FAILED', itemName: '付款失败', color: 'red' },
      { itemCode: 'REFUNDED', itemName: '已退款', color: 'volcano' },
    ],
  },
  payment_plan_status: {
    name: '付款计划状态',
    items: [
      { itemCode: 'WAIT', itemName: '待付款', color: 'default' },
      { itemCode: 'PARTIAL', itemName: '部分付款', color: 'orange' },
      { itemCode: 'PAID', itemName: '已付款', color: 'green' },
      { itemCode: 'OVERDUE', itemName: '已逾期', color: 'red' },
    ],
  },
  project_status: {
    name: '项目状态',
    items: [
      { itemCode: 'ONGOING', itemName: '进行中', color: 'processing' },
      { itemCode: 'COMPLETED', itemName: '已完工', color: 'green' },
      { itemCode: 'ARCHIVED', itemName: '已归档', color: 'default' },
    ],
  },
  project_member_role: {
    name: '项目内角色',
    items: [
      { itemCode: 'ADMIN', itemName: '项目管理员', color: 'blue' },
      { itemCode: 'MEMBER', itemName: '项目成员', color: 'cyan' },
      { itemCode: 'READONLY', itemName: '只读用户', color: 'default' },
    ],
  },
  procurement_source: {
    name: '采购来源',
    items: [
      { itemCode: 'BID', itemName: '招标采购', color: 'blue' },
      { itemCode: 'INQUIRY', itemName: '询价采购', color: 'cyan' },
      { itemCode: 'NEGOTIATE', itemName: '谈判采购', color: 'purple' },
      { itemCode: 'DIRECT', itemName: '直接采购', color: 'orange' },
      { itemCode: 'FRAMEWORK', itemName: '框架协议', color: 'geekblue' },
    ],
  },
  supplier_category: {
    name: '分供方类别',
    items: [
      { itemCode: 'MATERIAL', itemName: '材料供应商', color: 'blue' },
      { itemCode: 'LEASE', itemName: '租赁商', color: 'purple' },
      { itemCode: 'LABOR', itemName: '劳务分包', color: 'orange' },
      { itemCode: 'PROFESSIONAL', itemName: '专业分包', color: 'cyan' },
      { itemCode: 'OTHER', itemName: '其他', color: 'default' },
    ],
  },
  is_direct_purchase: {
    name: '是否厂家直采',
    items: [
      { itemCode: 'Y', itemName: '是', color: 'green' },
      { itemCode: 'N', itemName: '否', color: 'default' },
    ],
  },
  contract_template_category: {
    name: '合同模板分类',
    items: [
      { itemCode: 'FRAMEWORK', itemName: '框架协议', color: 'blue' },
      { itemCode: 'PURCHASE', itemName: '采购合同', color: 'cyan' },
      { itemCode: 'PURCHASE_EXEC', itemName: '采购执行合同', color: 'geekblue' },
      { itemCode: 'LEASE', itemName: '租赁合同', color: 'purple' },
      { itemCode: 'LEASE_EXEC', itemName: '租赁执行合同', color: 'magenta' },
      { itemCode: 'PRICE_UP', itemName: '涨价补充协议', color: 'volcano' },
      { itemCode: 'PRICE_DOWN', itemName: '降价补充协议', color: 'green' },
      { itemCode: 'ITEM_ADD', itemName: '增项补充协议', color: 'blue' },
      { itemCode: 'QTY_ADD', itemName: '增量补充协议', color: 'geekblue' },
      { itemCode: 'OTHER_SUPP', itemName: '其他类补充协议', color: 'default' },
    ],
  },
};

const PERMISSIONS = [
  { code: 'dashboard:view', name: '查看看板', module: '看板' },
  { code: 'dict:view', name: '查看字典', module: '字典管理' },
  { code: 'dict:edit', name: '维护字典', module: '字典管理' },
  { code: 'project:view', name: '查看项目', module: '项目管理' },
  { code: 'project:edit', name: '维护项目', module: '项目管理' },
  { code: 'supplier:view', name: '查看供应商', module: '供应商库' },
  { code: 'supplier:edit', name: '维护供应商', module: '供应商库' },
  { code: 'contract:view', name: '查看合同', module: '合同管理' },
  { code: 'contract:edit', name: '维护合同', module: '合同管理' },
  { code: 'template:view', name: '查看模板', module: '合同模板' },
  { code: 'template:edit', name: '维护模板', module: '合同模板' },
  { code: 'daily:view', name: '查看日报', module: '日报管理' },
  { code: 'daily:edit', name: '维护日报', module: '日报管理' },
  { code: 'item:view', name: '查看合同清单', module: '合同清单' },
  { code: 'item:edit', name: '维护合同清单', module: '合同清单' },
  { code: 'material:view', name: '查看物资基础库', module: '物资管理' },
  { code: 'material:edit', name: '维护物资与合同物资清单', module: '物资管理' },
  { code: 'settlement:view', name: '查看结算', module: '结算管理' },
  { code: 'settlement:edit', name: '维护结算', module: '结算管理' },
  { code: 'payment:view', name: '查看付款', module: '付款管理' },
  { code: 'payment:edit', name: '维护付款', module: '付款管理' },
  { code: 'invoice:view', name: '查看发票', module: '发票管理' },
  { code: 'invoice:edit', name: '维护发票', module: '发票管理' },
  { code: 'ledger:view', name: '查看合同台账', module: '合同台账' },
  { code: 'repayment:view', name: '查看还款协议', module: '还款协议' },
  { code: 'repayment:edit', name: '维护还款协议', module: '还款协议' },
  { code: 'finance:view', name: '查看资金费用台账', module: '资金费用台账' },
  { code: 'finance:edit', name: '维护资金费用台账', module: '资金费用台账' },
  { code: 'asset:view', name: '查看资产管理台账', module: '资产管理台账' },
  { code: 'asset:edit', name: '维护资产管理台账', module: '资产管理台账' },
  { code: 'system:user', name: '用户与角色管理', module: '系统管理' },
  { code: 'system:config', name: '系统参数配置', module: '系统管理' },
  { code: 'system:log', name: '日志查看', module: '系统管理' },
];

const SYS_PARAMS = [
  { key: 'contract.code.fixed_prefix', value: 'CSCEC', remark: '合同编号固定前缀（第1段，只读）' },
  { key: 'contract.code.type_mapping', value: '{"框架协议":"WZCG","采购合同":"WZCG","采购执行合同":"WZCG","租赁合同":"WZZL","租赁执行合同":"WZZL"}', remark: '合同类型→编号第2段映射（JSON，按字典项名称匹配）' },
  { key: 'contract.code.sub_type_mapping', value: '{"单项":"G1","执行":"G2"}', remark: '合同子类型→编号第4段映射（JSON，按字典项名称匹配）' },
  { key: 'contract.code.seq_digits', value: '3', remark: '合同编号顺序码位数' },
  { key: 'contract.code.year_reset', value: 'true', remark: '顺序码是否按年重置' },
  { key: 'contract.code.unique.scope', value: 'GLOBAL', remark: '合同编号唯一性范围：GLOBAL 全局唯一 / PROJECT 项目内唯一' },
  { key: 'multi.project.enabled', value: 'true', remark: '是否启用多项目' },
  { key: 'supplier.share.scope', value: 'GLOBAL', remark: '供应商库共享范围：GLOBAL 全局共享 / PROJECT 项目隔离' },
  { key: 'dict.share.scope', value: 'GLOBAL', remark: '字典共享范围：GLOBAL 全局共享 / PROJECT 项目隔离' },
  { key: 'repayment.code.prefix', value: 'HK', remark: '还款协议编号前缀' },
  { key: 'contract.code.prefix', value: 'HT', remark: '合同编号前缀' },
  { key: 'supplier.name.sync.history', value: 'KEEP', remark: '供应商名称变更时历史合同处理：KEEP 保留原值 / SYNC 同步更新' },
  { key: 'finance.overdue.default_monthly_rate', value: '0.006', remark: '资金费用-默认延期月利率（合同可覆盖）' },
  { key: 'finance.overdue.default_grace_days', value: '7', remark: '资金费用-默认逾期宽限天数（合同可覆盖）' },
  { key: 'finance.overdue.interest_cap_ratio', value: '0.05', remark: '资金费用-逾期利息上限比例（合同可覆盖）' },
  { key: 'finance.overdue.days360_method', value: 'true', remark: '资金费用-是否使用 DAYS360 计算逾期天数' },
  { key: 'finance.payment.mode_100_description', value: '次月25日前支付100%（逾期宽限7天）', remark: '资金费用-100%付款模式描述' },
  { key: 'finance.payment.mode_3382_description', value: '第3个月内支付当月结算价款的80%，在第6个月支付第一个月的100%（逾期宽限7天）', remark: '资金费用-3382付款模式描述' },
];

async function main() {
  console.log('>>> 开始初始化数据...');

  // ---------- 部门 ----------
  const deptRoot = await prisma.dept.upsert({
    where: { id: 'dept-root' },
    update: {},
    create: { id: 'dept-root', name: '集团总部', sort: 0 },
  });
  const deptPurchase = await prisma.dept.upsert({
    where: { id: 'dept-purchase' },
    update: {},
    create: { id: 'dept-purchase', name: '采购管理部', parentId: deptRoot.id, sort: 1 },
  });
  const deptFinance = await prisma.dept.upsert({
    where: { id: 'dept-finance' },
    update: {},
    create: { id: 'dept-finance', name: '财务管理部', parentId: deptRoot.id, sort: 2 },
  });

  // ---------- 权限 ----------
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { name: p.name, module: p.module },
      create: p,
    });
  }

  // ---------- 角色 ----------
  const roleAdmin = await prisma.role.upsert({
    where: { code: 'SUPER_ADMIN' },
    update: {},
    create: { code: 'SUPER_ADMIN', name: '超级管理员', remark: '拥有全部权限' },
  });
  const roleManager = await prisma.role.upsert({
    where: { code: 'PROJECT_MANAGER' },
    update: {},
    create: { code: 'PROJECT_MANAGER', name: '项目管理员', remark: '项目管理' },
  });
  const roleStaff = await prisma.role.upsert({
    where: { code: 'STAFF' },
    update: {},
    create: { code: 'STAFF', name: '普通员工', remark: '基础录入与查看' },
  });

  const allPerms = await prisma.permission.findMany();
  for (const p of allPerms) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: roleAdmin.id, permissionId: p.id } },
      update: {},
      create: { roleId: roleAdmin.id, permissionId: p.id },
    });
  }
  const managerPermCodes = PERMISSIONS.filter((p) => !p.code.startsWith('system:')).map((p) => p.code);
  for (const p of allPerms.filter((x) => managerPermCodes.includes(x.code))) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: roleManager.id, permissionId: p.id } },
      update: {},
      create: { roleId: roleManager.id, permissionId: p.id },
    });
  }
  const staffPermCodes = PERMISSIONS.filter((p) => p.code.endsWith(':view')).map((p) => p.code);
  for (const p of allPerms.filter((x) => staffPermCodes.includes(x.code))) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: roleStaff.id, permissionId: p.id } },
      update: {},
      create: { roleId: roleStaff.id, permissionId: p.id },
    });
  }

  // ---------- 用户 ----------
  const password = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      password,
      realName: '系统管理员',
      deptId: deptRoot.id,
      isSuperAdmin: true,
      email: 'admin@demo.com',
      phone: '13800000000',
    },
  });
  const manager = await prisma.user.upsert({
    where: { username: 'manager' },
    update: {},
    create: { username: 'manager', password, realName: '项目经理-张伟', deptId: deptPurchase.id },
  });
  const staff = await prisma.user.upsert({
    where: { username: 'staff' },
    update: {},
    create: { username: 'staff', password, realName: '采购专员-李娜', deptId: deptPurchase.id },
  });
  for (const [user, role] of [
    [admin, roleAdmin],
    [manager, roleManager],
    [staff, roleStaff],
  ] as any[]) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });
  }

  // ---------- 字典 ----------
  let order = 0;
  for (const [code, def] of Object.entries(DICTS)) {
    await prisma.dictType.upsert({
      where: { code },
      update: { name: def.name, remark: def.remark },
      create: { code, name: def.name, remark: def.remark, sort: order++, isSystem: true },
    });
    let itemOrder = 0;
    for (const item of def.items) {
      const exist = await prisma.dictItem.findFirst({ where: { typeCode: code, itemCode: item.itemCode } });
      if (exist) {
        await prisma.dictItem.update({ where: { id: exist.id }, data: { itemName: item.itemName, color: item.color, extField1: item.extField1, sortOrder: itemOrder++ } });
      } else {
        await prisma.dictItem.create({
          data: { typeCode: code, itemCode: item.itemCode, itemName: item.itemName, color: item.color, extField1: item.extField1, sortOrder: itemOrder++ },
        });
      }
    }
  }

  // ---------- 系统参数 ----------
  for (const p of SYS_PARAMS) {
    await prisma.sysParam.upsert({ where: { key: p.key }, update: { value: p.value, remark: p.remark }, create: p });
  }

  // ---------- 项目 ----------
  const project = await prisma.project.upsert({
    where: { code: 'PRJ-DEMO-001' },
    update: { nameAbbr: '滨江商务中心', codeAbbr: 'BJWSZX', undertaker: '中建三局', selfContractAmount: 58000.00, industryType: 'RESIDENCE' },
    create: {
      code: 'PRJ-DEMO-001',
      name: '滨江商务中心项目',
      nameAbbr: '滨江商务中心',
      codeAbbr: 'BJWSZX',
      undertaker: '中建三局',
      selfContractAmount: 58000.00,
      industryType: 'RESIDENCE',
      status: 'ONGOING',
      description: '演示项目：含土建、安装、装饰全过程',
      startDate: new Date('2026-01-01'),
      managerId: manager.id,
    },
  });
  const project2 = await prisma.project.upsert({
    where: { code: 'PRJ-DEMO-002' },
    update: {},
    create: { code: 'PRJ-DEMO-002', name: '城南安置房项目', nameAbbr: '城南安置房', codeAbbr: 'CNAZF', undertaker: '中建三局', selfContractAmount: 32000.00, industryType: 'RESIDENCE', status: 'ONGOING', managerId: manager.id },
  });
  for (const [u, roleCode] of [
    [admin, 'ADMIN'],
    [manager, 'ADMIN'],
    [staff, 'MEMBER'],
  ] as any[]) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: u.id } },
      update: {},
      create: { projectId: project.id, userId: u.id, roleCode },
    });
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project2.id, userId: u.id } },
      update: {},
      create: { projectId: project2.id, userId: u.id, roleCode },
    });
  }

  // ---------- 供应商 ----------
  const supplierData = [
    {
      name: '华东建材集团有限公司',
      legalPerson: '陈建国', legalPhone: '13900001111',
      contractAuthPerson: '陈建国', contractAuthPhone: '13900001111', contractAuthIdNo: '310101197001011234',
      contactName: '王强', contactPhone: '13900002222', contactEmail: 'wq@huadong.com',
      bankName: '中国建设银行上海分行', bankAccount: '3100 1234 5678 9012 345', address: '上海市浦东新区世纪大道 100 号',
    },
    {
      name: '宏基钢材贸易有限公司',
      legalPerson: '刘宏基', legalPhone: '13800003333',
      contractAuthPerson: '刘宏基', contractAuthPhone: '13800003333', contractAuthIdNo: '320101197502025678',
      contactName: '赵敏', contactPhone: '13800004444', contactEmail: 'zm@hongji.com',
      bankName: '中国工商银行南京分行', bankAccount: '4301 2345 6789 0123 456', address: '江苏省南京市鼓楼区中山北路 88 号',
    },
    {
      name: '安泰建筑机械设备租赁有限公司',
      legalPerson: '孙安泰', legalPhone: '13700005555',
      contractAuthPerson: '周涛', contractAuthPhone: '13700006666', contractAuthIdNo: '330101198003039876',
      contactName: '周涛', contactPhone: '13700006666', contactEmail: 'zt@antai.com',
      bankName: '中国银行杭州分行', bankAccount: '3630 1234 5678 9012', address: '浙江省杭州市西湖区文三路 66 号',
    },
  ];
  const suppliers: any[] = [];
  for (const s of supplierData) {
    const exist = await prisma.supplier.findUnique({ where: { name: s.name } });
    suppliers.push(exist || (await prisma.supplier.create({ data: s as any })));
  }

  // ---------- 合同 ----------
  const contractSeed = [
    {
      code: 'HT-2026-0001', name: '滨江项目钢筋采购合同', typeCode: 'PURCHASE_EXEC',
      supplierIdx: 1, amount: 8600000, taxRate: 0.13, paymentMethodCode: 'TRANSFER',
      isFramework: 'N', isSupplement: 'N', signDate: new Date('2026-01-15'),
      execStatus: 'EXECUTING',
      ext: { financeCode: 'FIN-2026-0001', procurementSrc: 'BID', isDirectPurchase: 'N', bidName: '滨江项目钢筋招标', currentPayRatio: 0.75, supplierCategory: 'MATERIAL', bidStartDate: new Date('2025-12-01'), bidWinDate: new Date('2025-12-20'), disclosureDate: new Date('2026-01-10') },
    },
    {
      code: 'HT-2026-0002', name: '滨江项目塔吊租赁合同', typeCode: 'LEASE_EXEC',
      supplierIdx: 2, amount: 2400000, taxRate: 0.09, paymentMethodCode: 'ACCEPTANCE',
      isFramework: 'N', isSupplement: 'N', signDate: new Date('2026-02-01'),
      execStatus: 'EXECUTING',
      ext: { financeCode: 'FIN-2026-0002', procurementSrc: 'INQUIRY', isDirectPurchase: 'N', bidName: '塔吊租赁询价', currentPayRatio: 0.6, supplierCategory: 'LEASE', bidStartDate: new Date('2026-01-05'), bidWinDate: new Date('2026-01-20') },
    },
    {
      code: 'HT-2026-0003', name: '滨江项目商品砼框架协议', typeCode: 'FRAMEWORK',
      supplierIdx: 0, amount: 15000000, taxRate: 0.13, paymentMethodCode: 'TRANSFER',
      isFramework: 'Y', isSupplement: 'N', signDate: new Date('2026-01-05'),
      execStatus: 'EXECUTING',
      ext: { procurementSrc: 'FRAMEWORK', isDirectPurchase: 'Y', supplierCategory: 'MATERIAL' },
    },
    {
      code: 'HT-2026-0004', name: '钢筋采购合同涨价补充协议', typeCode: 'PURCHASE',
      supplierIdx: 1, amount: 600000, taxRate: 0.13, paymentMethodCode: 'TRANSFER',
      isFramework: 'N', isSupplement: 'Y', supplementTypeCode: 'PRICE_UP', signDate: new Date('2026-03-10'),
      execStatus: 'DRAFT',
      ext: { supplierCategory: 'MATERIAL' },
    },
  ];
  const contracts: any[] = [];
  for (const c of contractSeed) {
    const exist = await prisma.contract.findFirst({ where: { projectId: project.id, code: c.code } });
    if (exist) { contracts.push(exist); continue; }
    const created = await prisma.contract.create({
      data: {
        projectId: project.id,
        code: c.code, name: c.name, typeCode: c.typeCode,
        supplierId: suppliers[c.supplierIdx].id,
        amount: c.amount, taxRate: c.taxRate, paymentMethodCode: c.paymentMethodCode,
        isFramework: c.isFramework, isSupplement: c.isSupplement, supplementTypeCode: (c as any).supplementTypeCode,
        signDate: c.signDate, execStatus: c.execStatus,
        createdBy: admin.id,
        ext: { create: c.ext as any },
      },
    });
    contracts.push(created);
  }

  // ---------- 合同清单 ----------
  if ((await prisma.contractItem.count({ where: { projectId: project.id } })) === 0) {
    await prisma.contractItem.createMany({
      data: [
        { projectId: project.id, contractId: contracts[0].id, supplierId: suppliers[1].id, materialCategory: 'ENG', materialName: '螺纹钢 HRB400E Φ20', spec: 'Φ20', unit: 'T', qty: 1200, costPrice: 3850, taxRate: 0.13, comprehensivePrice: 4350.5 },
        { projectId: project.id, contractId: contracts[0].id, supplierId: suppliers[1].id, materialCategory: 'ENG', materialName: '盘螺 HRB400E Φ8', spec: 'Φ8', unit: 'T', qty: 600, costPrice: 3720, taxRate: 0.13, comprehensivePrice: 4203.6 },
        { projectId: project.id, contractId: contracts[1].id, supplierId: suppliers[2].id, materialCategory: 'LEASE', materialName: '塔吊 QTZ63', spec: 'QTZ63', unit: 'UNIT', qty: 4, costPrice: 28000, taxRate: 0.09, comprehensivePrice: 30520 },
        { projectId: project.id, contractId: contracts[2].id, supplierId: suppliers[0].id, materialCategory: 'ENG', materialName: '商品砼 C30', spec: 'C30', unit: 'M3', qty: 20000, costPrice: 420, taxRate: 0.13, comprehensivePrice: 474.6 },
      ],
    });
  }

  // ---------- 日报 ----------
  if ((await prisma.dailyReport.count({ where: { projectId: project.id } })) === 0) {
    await prisma.dailyReport.createMany({
      data: [
        { projectId: project.id, periodYear: 2026, periodMonth: 1, entryDate: new Date('2026-01-10'), contractId: contracts[0].id, isAsset: 'Y', department: '工程部', personnel: '王强', assetStatus: 'IN_USE', sourceCode: 'PURCHASE', materialCategory: 'ENG', materialType: 'STEEL', materialName: '螺纹钢 HRB400E Φ20', steelBrand: '沙钢', steelCount: 120, spec: 'Φ20', unit: 'T', weighQty: 320.5, deductQty: 1.2, settleQty: 319.3, isWeighed: 'Y', priceBeforeTax: 3850, taxRate: 0.13, priceAfterTax: 4350.5, amountBeforeTax: 1229305, amountAfterTax: 1389114.65, supplierId: suppliers[1].id, receiveUnit: '一标段', receiver: '李强', usePosition: '3#楼基础', isProxy: 'N', plateNo: '沪A12345', receiptNo: 'SL-2026-0001' },
        { projectId: project.id, periodYear: 2026, periodMonth: 2, entryDate: new Date('2026-02-05'), contractId: contracts[0].id, isAsset: 'Y', department: '工程部', personnel: '王强', assetStatus: 'IN_USE', sourceCode: 'PURCHASE', materialCategory: 'ENG', materialType: 'STEEL', materialName: '盘螺 HRB400E Φ8', spec: 'Φ8', unit: 'T', weighQty: 180, deductQty: 0.8, settleQty: 179.2, isWeighed: 'Y', priceBeforeTax: 3720, taxRate: 0.13, priceAfterTax: 4203.6, amountBeforeTax: 666624, amountAfterTax: 753485.12, supplierId: suppliers[1].id, receiveUnit: '二标段', receiver: '赵磊', usePosition: '5#楼主体', isProxy: 'N', plateNo: '沪B67890', receiptNo: 'SL-2026-0002' },
        { projectId: project.id, periodYear: 2026, periodMonth: 2, entryDate: new Date('2026-02-08'), contractId: contracts[1].id, isAsset: 'Y', department: '设备部', personnel: '周涛', assetStatus: 'IN_USE', sourceCode: 'LEASE', materialCategory: 'LEASE', materialType: 'LEASE_MACHINE', materialName: '塔吊 QTZ63', spec: 'QTZ63', unit: 'UNIT', settleQty: 2, priceBeforeTax: 28000, taxRate: 0.09, priceAfterTax: 30520, amountBeforeTax: 56000, amountAfterTax: 61040, supplierId: suppliers[2].id, receiveUnit: '一标段', receiver: '孙立', usePosition: '1#楼', isProxy: 'N' },
        { projectId: project.id, periodYear: 2026, periodMonth: 3, entryDate: new Date('2026-02-20'), contractId: contracts[2].id, isAsset: 'N', department: '工程部', personnel: '陈静', assetStatus: 'IN_USE', sourceCode: 'PURCHASE', materialCategory: 'ENG', materialType: 'CONCRETE', materialName: '商品砼 C30', spec: 'C30', unit: 'M3', weighQty: 1500, settleQty: 1500, isWeighed: 'N', priceBeforeTax: 420, taxRate: 0.13, priceAfterTax: 474.6, amountBeforeTax: 630000, amountAfterTax: 711900, supplierId: suppliers[0].id, receiveUnit: '三标段', receiver: '陈静', usePosition: '地下室', isProxy: 'N' },
      ],
    });
  }

  // ---------- 结算单 & 结算台账 ----------
  if ((await prisma.settlement.count({ where: { projectId: project.id } })) === 0) {
    await prisma.settlement.createMany({
      data: [
        { projectId: project.id, contractId: contracts[0].id, code: 'JS-2026-0001', typeCode: 'PROGRESS', amount: 1389114.65, deductAmount: 0, actualAmount: 1389114.65, settleDate: new Date('2026-01-31'), statusCode: 'PAID' },
        { projectId: project.id, contractId: contracts[0].id, code: 'JS-2026-0002', typeCode: 'PROGRESS', amount: 753485.12, deductAmount: 5000, actualAmount: 748485.12, settleDate: new Date('2026-02-28'), statusCode: 'CONFIRMED' },
        { projectId: project.id, contractId: contracts[1].id, code: 'JS-2026-0003', typeCode: 'PROGRESS', amount: 61040, deductAmount: 0, actualAmount: 61040, settleDate: new Date('2026-02-28'), statusCode: 'INVOICED' },
        { projectId: project.id, contractId: contracts[2].id, code: 'JS-2026-0004', typeCode: 'PROGRESS', amount: 711900, deductAmount: 0, actualAmount: 711900, settleDate: new Date('2026-03-31'), statusCode: 'CONFIRMED' },
      ],
    });
    await prisma.settlementLedger.createMany({
      data: [
        { projectId: project.id, contractId: contracts[0].id, settleMonth: '2026-01', monthSettleAmount: 1389114.65, monthInvoiceAmount: 1389114.65, settleCount: 1, yearSettleAmount: 1389114.65, cumPurchaseAmount: 1389114.65, startSettleAmount: 1389114.65, monthActualPurchase: 1389114.65, yearSettleIncome: 1500000, cumSettleIncome: 1500000, isOnAccount: 'N' },
        { projectId: project.id, contractId: contracts[0].id, settleMonth: '2026-02', monthSettleAmount: 748485.12, monthInvoiceAmount: 748485.12, settleCount: 2, yearSettleAmount: 2137599.77, cumPurchaseAmount: 2137599.77, startSettleAmount: 2137599.77, monthActualPurchase: 748485.12, factoringDiscount: 12000, overdueInterest: 3000, yearSettleIncome: 2300000, cumSettleIncome: 2300000, isOnAccount: 'N' },
        { projectId: project.id, contractId: contracts[1].id, settleMonth: '2026-02', monthSettleAmount: 61040, monthInvoiceAmount: 61040, settleCount: 1, yearSettleAmount: 61040, cumPurchaseAmount: 61040, startSettleAmount: 61040, monthActualPurchase: 61040, isOnAccount: 'N' },
        { projectId: project.id, contractId: contracts[2].id, settleMonth: '2026-03', monthSettleAmount: 711900, monthInvoiceAmount: 711900, settleCount: 1, yearSettleAmount: 711900, cumPurchaseAmount: 711900, startSettleAmount: 711900, monthActualPurchase: 711900, isOnAccount: 'Y' },
      ],
    });
  }

  // ---------- 付款 ----------
  if ((await prisma.paymentRecord.count({ where: { projectId: project.id } })) === 0) {
    await prisma.paymentPlan.createMany({
      data: [
        { projectId: project.id, contractId: contracts[0].id, period: 1, planAmount: 1000000, planDate: new Date('2026-02-15'), condition: '到货验收后 15 日', statusCode: 'PAID' },
        { projectId: project.id, contractId: contracts[0].id, period: 2, planAmount: 800000, planDate: new Date('2026-03-15'), condition: '月度结算后付款', statusCode: 'WAIT' },
        { projectId: project.id, contractId: contracts[1].id, period: 1, planAmount: 61040, planDate: new Date('2026-03-20'), condition: '租赁月度结算', statusCode: 'OVERDUE' },
      ],
    });
    await prisma.paymentApply.createMany({
      data: [
        { projectId: project.id, contractId: contracts[0].id, code: 'FK-2026-0001', applyAmount: 1000000, payee: suppliers[1].name, bankName: suppliers[1].bankName, bankAccount: suppliers[1].bankAccount, payDate: new Date('2026-02-20'), methodCode: 'TRANSFER', statusCode: 'APPROVED', createdBy: admin.id },
        { projectId: project.id, contractId: contracts[1].id, code: 'FK-2026-0002', applyAmount: 61040, payee: suppliers[2].name, bankName: suppliers[2].bankName, bankAccount: suppliers[2].bankAccount, payDate: new Date('2026-03-25'), methodCode: 'ACCEPTANCE', statusCode: 'PENDING', createdBy: admin.id },
      ],
    });
    await prisma.paymentRecord.createMany({
      data: [
        { projectId: project.id, contractId: contracts[0].id, payMonth: '2026-02', amount: 1000000, methodCode: 'TRANSFER', payDate: new Date('2026-02-20'), statusCode: 'PAID', remark: '第一期进度款' },
        { projectId: project.id, contractId: contracts[1].id, payMonth: '2026-02', amount: 30000, methodCode: 'TRANSFER', payDate: new Date('2026-02-28'), statusCode: 'PARTIAL' },
      ],
    });
  }

  // ---------- 发票 ----------
  if ((await prisma.invoice.count({ where: { projectId: project.id } })) === 0) {
    await prisma.invoice.createMany({
      data: [
        { projectId: project.id, contractId: contracts[0].id, goodsCategory: 'MATERIAL', settlePeriod: '2026-01', invoiceCode: '011002600111', invoiceNo: '08812345', typeCode: 'VAT_SPECIAL', invoiceDate: new Date('2026-01-28'), issuer: suppliers[1].name, receiver: '滨江项目部', amountBeforeTax: 1229305, taxRate: 0.13, amountWithTax: 1389114.65, receiveDate: new Date('2026-01-30'), reviewStatus: 'PASSED', responsiblePerson: '李娜', financeTransferStatus: 'TRANSFERRED', statusCode: 'DEDUCTED' },
        { projectId: project.id, contractId: contracts[0].id, goodsCategory: 'MATERIAL', settlePeriod: '2026-02', invoiceCode: '011002600111', invoiceNo: '08812678', typeCode: 'VAT_SPECIAL', invoiceDate: new Date('2026-02-26'), issuer: suppliers[1].name, receiver: '滨江项目部', amountBeforeTax: 661846.13, taxRate: 0.13, amountWithTax: 748485.12, receiveDate: new Date('2026-02-28'), reviewStatus: 'PENDING', responsiblePerson: '李娜', financeTransferStatus: 'NOT_TRANSFERRED', statusCode: 'WAIT_VERIFY' },
        { projectId: project.id, contractId: contracts[1].id, goodsCategory: 'LEASE', settlePeriod: '2026-02', invoiceCode: '011002600112', invoiceNo: '08813001', typeCode: 'VAT_SPECIAL', invoiceDate: new Date('2026-02-27'), issuer: suppliers[2].name, receiver: '滨江项目部', amountBeforeTax: 56000, taxRate: 0.09, amountWithTax: 61040, receiveDate: new Date('2026-03-02'), reviewStatus: 'PASSED', responsiblePerson: '李娜', financeTransferStatus: 'TRANSFERRING', statusCode: 'VERIFIED' },
      ],
    });
  }

  // ---------- 还款协议 ----------
  if ((await prisma.repaymentAgreement.count({ where: { projectId: project.id } })) === 0) {
    const agree = await prisma.repaymentAgreement.create({
      data: {
        projectId: project.id, code: 'HK-2026-0001', supplierId: suppliers[1].id, contractId: contracts[0].id,
        material: '螺纹钢/盘螺', signDate: new Date('2026-03-01'), settleAmount: 2137599.77,
        agreedDebtAmount: 1137599.77, paidBeforeSign: 1000000, paidAfterSign: 0, overdueUnpaid: 1137599.77,
        remark: '分三期偿还',
        details: {
          create: [
            { period: 1, amount: 400000, dueDate: new Date('2026-04-30') },
            { period: 2, amount: 400000, dueDate: new Date('2026-05-31') },
            { period: 3, amount: 337599.77, dueDate: new Date('2026-06-30') },
          ],
        },
      },
    });
    console.log('  还款协议:', agree.code);
  }

  // ---------- 合同模板 ----------
  if ((await prisma.contractTemplate.count()) === 0) {
    const tplContent = `<h2 style="text-align:center">{合同名称}</h2>
<p>合同编号：{合同编号}　　项目名称：{项目名称}</p>
<p>甲方：本公司</p>
<p>乙方：{供应商名称}</p>
<p>法定代表人：{法人姓名}（电话：{法人电话}）</p>
<p>合同授权人：{合同授权人姓名}（电话：{合同授权人电话}，身份证号：{合同授权人身份证号}）</p>
<p>联系人：{联系人姓名}　电话：{联系人电话}　邮箱：{联系人邮箱}</p>
<p>开户银行：{银行名称}　银行账号：{银行账号}</p>
<p>公司地址：{公司地址}</p>
<p>合同金额：{合同额} 元，税率：{税率}，付款方式：{合同约定付款方式}，签订日期：{签订日期}。</p>
<p>一、工程概况及承包范围……</p>
<p>二、合同价款与支付方式……</p>
<p>三、质量标准与验收……</p>
<p>四、违约责任……</p>`;
    await prisma.contractTemplate.create({
      data: {
        name: '采购执行合同标准模板',
        categoryCode: 'PURCHASE_EXEC',
        tags: '采购,钢筋,标准',
        status: 1,
        version: 1,
        content: tplContent,
        createdBy: admin.id,
        variables: {
          create: [
            { varKey: '合同编号', varLabel: '合同编号', sourceType: 'CONTRACT' },
            { varKey: '合同名称', varLabel: '合同名称', sourceType: 'CONTRACT' },
            { varKey: '合同额', varLabel: '合同额', sourceType: 'CONTRACT' },
            { varKey: '税率', varLabel: '税率', sourceType: 'CONTRACT' },
            { varKey: '签订日期', varLabel: '签订日期', sourceType: 'CONTRACT' },
            { varKey: '合同约定付款方式', varLabel: '付款方式', sourceType: 'CONTRACT' },
            { varKey: '项目名称', varLabel: '项目名称', sourceType: 'CONTRACT' },
            { varKey: '供应商名称', varLabel: '供应商名称', sourceType: 'SUPPLIER' },
            { varKey: '法人姓名', varLabel: '法人姓名', sourceType: 'SUPPLIER' },
            { varKey: '法人电话', varLabel: '法人电话', sourceType: 'SUPPLIER' },
            { varKey: '合同授权人姓名', varLabel: '授权人姓名', sourceType: 'SUPPLIER' },
            { varKey: '合同授权人电话', varLabel: '授权人电话', sourceType: 'SUPPLIER' },
            { varKey: '合同授权人身份证号', varLabel: '授权人身份证号', sourceType: 'SUPPLIER' },
            { varKey: '联系人姓名', varLabel: '联系人姓名', sourceType: 'SUPPLIER' },
            { varKey: '联系人电话', varLabel: '联系人电话', sourceType: 'SUPPLIER' },
            { varKey: '联系人邮箱', varLabel: '联系人邮箱', sourceType: 'SUPPLIER' },
            { varKey: '银行名称', varLabel: '银行名称', sourceType: 'SUPPLIER' },
            { varKey: '银行账号', varLabel: '银行账号', sourceType: 'SUPPLIER' },
            { varKey: '公司地址', varLabel: '公司地址', sourceType: 'SUPPLIER' },
          ],
        },
      },
    });
    await prisma.contractTemplate.create({
      data: { name: '框架协议标准模板', categoryCode: 'FRAMEWORK', status: 1, version: 1, content: '<h2 style="text-align:center">框架协议</h2><p>甲方：本公司　乙方：{供应商名称}</p><p>联系人：{联系人姓名} {联系人电话}</p>', createdBy: admin.id },
    });
    await prisma.contractTemplate.create({
      data: { name: '涨价补充协议模板', categoryCode: 'PRICE_UP', status: 1, version: 1, content: '<h2 style="text-align:center">涨价补充协议</h2><p>原合同编号：{合同编号}</p><p>乙方：{供应商名称}</p>', createdBy: admin.id },
    });
    await prisma.clause.createMany({
      data: [
        { title: '质量标准条款', content: '乙方提供的材料必须符合国家现行标准及设计要求，并提供合格证与检测报告。', categoryCode: 'PURCHASE_EXEC', createdBy: admin.id },
        { title: '付款条款（月结 70%）', content: '每月 25 日办理结算，次月 20 日前支付上月结算额的 70%，竣工验收后付至 97%，余 3% 作为质保金。', categoryCode: 'PURCHASE_EXEC', createdBy: admin.id },
        { title: '违约责任条款', content: '逾期交货的，每逾期一日按合同总价的 0.5‰ 支付违约金，累计不超过合同总价的 5%。', categoryCode: 'PURCHASE_EXEC', createdBy: admin.id },
      ],
    });
  }

  // ---------- 通知 ----------
  if ((await prisma.notification.count()) === 0) {
    await prisma.notification.createMany({
      data: [
        { userId: admin.id, title: '付款计划逾期', content: '塔吊租赁合同付款计划已逾期', type: 'WARNING', projectId: project.id },
      ],
    });
  }

  // ---------- 资金费用台账（保理费用 + 逾期利息） ----------
  if ((await prisma.factoringCost.count()) === 0) {
    await prisma.contract.update({
      where: { id: contracts[0].id },
      data: { paymentMode: '3382', monthlyRate: 0.006, graceDays: 7, interestCapRatio: 0.05 },
    });
    await prisma.factoringCost.createMany({
      data: [
        { contractId: contracts[0].id, seqNo: 1, financingDate: new Date('2026-02-10'), financingAmount: 500000, actualReceipt: 492500, financingInterest: 6500, handlingFee: 1000, totalCost: 7500, settlementMonth: '2026-01', remark: '某银行保理' },
        { contractId: contracts[0].id, seqNo: 2, financingDate: new Date('2026-03-12'), financingAmount: 600000, actualReceipt: 591000, financingInterest: 7500, handlingFee: 1500, totalCost: 9000, settlementMonth: '2026-02', remark: '' },
        { contractId: contracts[0].id, seqNo: 3, financingDate: new Date('2026-04-08'), financingAmount: 450000, actualReceipt: 443700, financingInterest: 5400, handlingFee: 900, totalCost: 6300, settlementMonth: '2026-03', remark: '费率下浮后重签' },
      ],
    });
    await prisma.overdueInterest.createMany({
      data: [
        // 2026-01 结算：材料款 100 万 × 80%（3382 第3个月付80%），应付款 2026-04-25，逾期起始 2026-05-03
        { contractId: contracts[0].id, settlementMonth: '2026-01', materialAmount: 1000000, paymentRatio: 0.8, payableAmount: 800000, payableDate: new Date('2026-04-25'), overdueStartDate: new Date('2026-05-03'), paymentDate: new Date('2026-05-10'), paymentAmount: 500000, interestAmount: 500000, overdueDays: 7, monthlyRate: 0.006, overdueInterest: 700, isSettlementPeriod: true, periodSeq: 1, prevCumulative: 0 },
        { contractId: contracts[0].id, settlementMonth: '2026-01', materialAmount: 0, paymentRatio: 0.8, payableAmount: 800000, payableDate: new Date('2026-04-25'), overdueStartDate: new Date('2026-05-03'), paymentDate: new Date('2026-06-20'), paymentAmount: 300000, interestAmount: 300000, overdueDays: 47, monthlyRate: 0.006, overdueInterest: 2820, isSettlementPeriod: true, periodSeq: 2 },
        { contractId: contracts[0].id, settlementMonth: '2026-01', materialAmount: 0, paymentRatio: 0.8, payableAmount: 800000, overdueStartDate: new Date('2026-05-03'), paymentAmount: 0, interestAmount: 0, overdueDays: 0, monthlyRate: 0.006, overdueInterest: 0, remark: '剩余款尚未支付，付款后自动计息', isSettlementPeriod: true, periodSeq: 3 },
      ],
    });
    console.log('  资金费用台账: 保理费用 3 行 / 逾期利息 3 行');
  }

  // ---------- 资产管理台账 ----------
  if ((await prisma.assetLedger.count({ where: { projectId: project.id } })) === 0) {
    await prisma.assetLedger.createMany({
      data: [
        { projectId: project.id, date: new Date('2026-01-15'), sourceCode: 'PURCHASE', categoryL1Code: 'TEMP_BUILD', categoryFocusCode: 'TEMP_HOUSE', name: '箱式房', spec: '3×6m 标准间', unit: '间', qty: 12, price: 8500, supplierId: suppliers[2]?.id, receiveUnit: '项目部办公区', responsible: '王强', inUseQty: 10, idleQty: 2, scrapQty: 0, lostQty: 0, turnoverCount: 1, originalPrice: 8500, remark: '' },
        { projectId: project.id, date: new Date('2026-02-20'), sourceCode: 'TRANSFER_IN', categoryL1Code: 'TURNOVER', categoryFocusCode: 'STEEL_FORM', name: '钢模板', spec: 'P3015 平面模板', unit: '块', qty: 300, price: 220, supplierId: suppliers[2]?.id, receiveUnit: '木工班组', responsible: '赵磊', inUseQty: 260, idleQty: 40, scrapQty: 0, lostQty: 0, turnoverCount: 3, originalPrice: 240, remark: '分公司内部调入' },
        { projectId: project.id, date: new Date('2026-03-10'), sourceCode: 'PURCHASE', categoryL1Code: 'SAFETY', categoryFocusCode: 'FENCE', name: '施工围挡', spec: '2.5m 高彩钢围挡', unit: 'm', qty: 800, price: 95, receiveUnit: '施工现场', responsible: '王强', inUseQty: 800, idleQty: 0, scrapQty: 0, lostQty: 0, turnoverCount: 1, originalPrice: 95, remark: '' },
      ],
    });
    console.log('  资产管理台账: 3 行');
  }

  console.log('>>> 初始化完成');
  console.log('    管理员账号：admin / admin123');
  console.log('    项目：', project.name, '/', project2.name);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PURCHASE_EXEC_TEMPLATE } from './templates/purchase-exec-contract';
import { dictTypes, dictItems, sysParams } from '../src/seed-data';

const prisma = new PrismaClient();

/** 字典定义：类型编码 -> { 名称, 字典项 } */
const DICTS: Record<string, { name: string; remark?: string; items: any[] }> = {};
for (const t of dictTypes) {
  DICTS[t.code] = {
    name: t.name,
    remark: t.remark ?? undefined,
    items: dictItems.filter((i) => i.typeCode === t.code),
  };
}
const PERMISSIONS = [
  { code: 'dashboard:view', name: '查看看板', module: '看板' },
  { code: 'dict:view', name: '查看字典', module: '字典管理' },
  { code: 'dict:edit', name: '维护字典', module: '字典管理' },
  { code: 'project:view', name: '查看项目', module: '项目管理' },
  { code: 'project:edit', name: '维护项目', module: '项目管理' },
  { code: 'supplier:view', name: '查看供应商', module: '供应商库' },
  { code: 'supplier:edit', name: '维护供应商', module: '供应商库' },
  { code: 'subcontractor:view', name: '查看分包商库', module: '基础信息管理' },
  { code: 'subcontractor:edit', name: '维护分包商与授权委托书', module: '基础信息管理' },
  { code: 'contract:view', name: '查看合同', module: '合同管理' },
  { code: 'contract:edit', name: '维护合同', module: '合同管理' },
  { code: 'template:view', name: '查看模板', module: '合同模板' },
  { code: 'template:edit', name: '维护模板', module: '合同模板' },
  { code: 'daily:view', name: '查看日报', module: '日报管理' },
  { code: 'daily:edit', name: '维护日报', module: '日报管理' },
  { code: 'receipt:view', name: '查看收领单', module: '日报管理' },
  { code: 'receipt:edit', name: '维护收领单', module: '日报管理' },
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
  { code: 'system:role', name: '角色管理', module: '系统管理' },
  { code: 'system:config', name: '系统参数配置', module: '系统管理' },
  { code: 'system:log', name: '日志查看', module: '系统管理' },
];

const SYS_PARAMS = sysParams.map((p) => ({ key: p.key, value: p.value ?? '', remark: p.remark ?? '' }));


async function main() {
  console.log('>>> 开始初始化数据...');

  // ---------- 权限 ----------
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { name: p.name, module: p.module },
      create: p,
    });
  }

  // ---------- 条款示例（需求 2.3：固定四种类型，各预置一条） ----------
  const SAMPLE_CLAUSES = [
    {
      id: 'clause-sample-technical',
      title: '技术标准条款',
      type: 'technical',
      content: '<p><strong>技术标准：</strong>本工程所用主要材料须符合国家现行标准及设计要求，材料的规格、型号、性能应符合招标文件技术规范书的规定。</p><ul><li>提供原厂质量证明文件与检测报告；</li><li>进口材料须提供报关单及商检证明。</li></ul>',
      sortOrder: 1,
    },
    {
      id: 'clause-sample-quality',
      title: '质量验收与质保条款',
      type: 'quality',
      content: '<p><strong>质量要求：</strong>货物质量须符合国家标准及行业标准，一次验收合格率不低于 98%。</p><ul><li>质保期：验收合格之日起 24 个月；</li><li>质保期内出现非人为质量问题的，供应商免费维修或更换。</li></ul>',
      sortOrder: 2,
    },
    {
      id: 'clause-sample-payment',
      title: '付款方式条款',
      type: 'payment',
      content: '<p><strong>付款方式：</strong>按月计量支付，支付比例为当月已完工程量的 80%。</p><ul><li>合同生效后 7 日内支付预付款（合同额的 10%）；</li><li>竣工验收后支付至结算价的 97%；</li><li>预留 3% 质保金，质保期满无质量问题后 14 日内无息退还。</li></ul>',
      sortOrder: 3,
    },
    {
      id: 'clause-sample-acceptance',
      title: '验收流程条款',
      type: 'acceptance',
      content: '<p><strong>验收方式：</strong>到货验收 + 安装调试后终验。</p><ul><li>到货后 3 个工作日内由采购人与供应商共同开箱验收；</li><li>安装调试完成后组织终验，验收资料一式三份；</li><li>验收不合格的，供应商应在 5 日内完成整改并重新报验。</li></ul>',
      sortOrder: 4,
    },
  ];
  for (const c of SAMPLE_CLAUSES) {
    await prisma.clause.upsert({ where: { id: c.id }, update: { ...c }, create: { ...c, status: 1 } });
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
      isSuperAdmin: true,
      email: 'admin@demo.com',
      phone: '13800000000',
    },
  });
  const manager = await prisma.user.upsert({
    where: { username: 'manager' },
    update: {},
    create: { username: 'manager', password, realName: '项目经理-张伟' },
  });
  const staff = await prisma.user.upsert({
    where: { username: 'staff' },
    update: {},
    create: { username: 'staff', password, realName: '采购专员-李娜' },
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

  // ---------- 物资基础库 + 合同物资清单（统一数据源：由物资库派生） ----------
  if ((await prisma.materialBase.count()) === 0) {
    const bases: any[] = [];
    for (const b of [
      { name: '螺纹钢 HRB400E', spec: 'Φ20', mdmCode: 'MDM-GC-001', dscCode: 'DSC-001' },
      { name: '盘螺 HRB400E', spec: 'Φ8', mdmCode: 'MDM-GC-002', dscCode: 'DSC-002' },
      { name: '塔吊', spec: 'QTZ63', mdmCode: 'MDM-JX-001', dscCode: 'DSC-003' },
      { name: '商品砼', spec: 'C30', mdmCode: 'MDM-SC-001', dscCode: 'DSC-004' },
    ]) {
      bases.push(await prisma.materialBase.create({ data: b }));
    }
    const pick = (name: string, spec: string) => bases.find((b: any) => b.name === name && b.spec === spec)!;
    const rows: any[] = [
      { contractId: contracts[0].id, materialBaseId: pick('螺纹钢 HRB400E', 'Φ20').id, unit: 'T', qty: 1200, priceBeforeTax: 3850, taxRatePct: 13, remark: '' },
      { contractId: contracts[0].id, materialBaseId: pick('盘螺 HRB400E', 'Φ8').id, unit: 'T', qty: 600, priceBeforeTax: 3720, taxRatePct: 13, remark: '' },
      { contractId: contracts[1].id, materialBaseId: pick('塔吊', 'QTZ63').id, unit: '台', qty: 4, priceBeforeTax: 28000, taxRatePct: 9, remark: '' },
      { contractId: contracts[2].id, materialBaseId: pick('商品砼', 'C30').id, unit: 'm³', qty: 20000, priceBeforeTax: 420, taxRatePct: 13, remark: '' },
    ];
    for (const [i, r] of rows.entries()) {
      const priceWithTax = Math.round(r.priceBeforeTax * (1 + r.taxRatePct / 100) * 10000) / 10000;
      await prisma.contractMaterial.create({
        data: { ...r, sortOrder: i + 1, priceWithTax, totalWithTax: Math.round(r.qty * priceWithTax * 10000) / 10000 },
      });
    }
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
    // 参考真实合同（紫金街项目步道砖、盲道砖采购合同）整理的采购执行合同模板
    const { variables, ...purchaseExec } = PURCHASE_EXEC_TEMPLATE;
    await prisma.contractTemplate.create({
      data: {
        ...purchaseExec,
        version: 1,
        createdBy: admin.id,
        variables: { create: variables.map((v) => ({ ...v })) },
      },
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

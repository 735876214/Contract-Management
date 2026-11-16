import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { dictTypes, dictItems, sysParams } from './seed-data';
import {
  LEGACY_CATEGORY_CODE_MAP,
  LEGACY_CATEGORY_NAME_MAP,
  MATERIAL_CATEGORY_L1,
  MATERIAL_CATEGORY_L2,
} from './constants/materialCategories';

/**
 * 启动时若用户表为空，则自动创建一个默认管理员账号，
 * 保证首次部署（空 PostgreSQL 库）也能直接登录。
 *
 * 设计要点：
 * - 仅在 user 表为空时创建，已有用户则跳过，不会覆盖或重复创建。
 * - 凭据可通过环境变量 DEFAULT_ADMIN_USERNAME / DEFAULT_ADMIN_PASSWORD 覆盖。
 * - 任何数据库异常都只记录日志、不向上抛错，避免阻塞后端启动。
 *
 * @param prisma 从 Nest DI 取出的 PrismaClient 实例
 */
export async function seedAdmin(prisma: PrismaClient): Promise<void> {
  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';

  try {
    const count = await prisma.user.count();
    if (count > 0) {
      return;
    }

    await prisma.user.create({
      data: {
        username,
        password: await bcrypt.hash(password, 10),
        realName: '超级管理员',
        status: 1,
        isSuperAdmin: true,
      },
    });

    console.log('[seed] 已创建默认管理员账号:', username);
  } catch (e) {
    console.error('[seed] 初始化默认管理员失败:', e);
  }
}

/**
 * 首次部署（空库）时，把字典类型（DictType）、字典项（DictItem）、
 * 系统参数（SysParam）三张表的初始数据写入数据库，保证「字典管理 / 系统参数」
 * 页面有内容。
 *
 * 设计要点：
 * - 使用 upsert 实现幂等：仅当记录不存在时 create，已存在则跳过（update 传空对象），
 *   不会覆盖线上已有数据，可安全地在每次启动重复调用。
 * - create 中不传 id / createdAt / updatedAt，由 Prisma 默认值自动生成。
 * - 可空字段（remark / color / extField1 / value）按 seed-data 中的真实值（null 或字符串）原样传入。
 * - 任何数据库异常只记录日志、不向上抛错，避免阻塞后端启动。
 *
 * @param prisma 从 Nest DI 取出的 PrismaClient 实例
 */
export async function seedDictAndParams(prisma: PrismaClient): Promise<void> {
  try {
    for (const t of dictTypes) {
      await prisma.dictType.upsert({
        where: { code: t.code },
        update: {},
        create: {
          code: t.code,
          name: t.name,
          remark: t.remark,
          sort: t.sort,
          status: t.status,
          isSystem: t.isSystem,
          scope: t.scope,
        },
      });
    }

    for (const it of dictItems) {
      await prisma.dictItem.upsert({
        where: { typeCode_itemCode: { typeCode: it.typeCode, itemCode: it.itemCode } },
        update: {},
        create: {
          typeCode: it.typeCode,
          itemCode: it.itemCode,
          itemName: it.itemName,
          sortOrder: it.sortOrder,
          status: it.status,
          color: it.color,
          remark: it.remark,
          extField1: it.extField1,
        },
      });
    }

    for (const p of sysParams) {
      await prisma.sysParam.upsert({
        where: { key: p.key },
        update: {},
        create: {
          key: p.key,
          value: p.value,
          remark: p.remark,
        },
      });
    }

    console.log('[seed] 已初始化字典与系统参数');
  } catch (e) {
    console.error('[seed] 初始化字典/系统参数失败:', e);
  }
}

/**
 * 首次部署（空库）时，创建一个默认项目（DEFAULT），
 * 解决容器化部署空库后 admin 登录报「缺少项目上下文（x-project-id）」的问题。
 *
 * 设计要点：
 * - superAdmin（admin 即为 superAdmin）登录时 auth.service.getProjects 会调用
 *   prisma.project.findMany() 返回所有项目；只要库里至少有 1 个项目，前端就能自动
 *   选中 res.projects?.[0]?.id 写入 localStorage.cms_project_id，x-project-id 不再为空，报错消失。
 * - 仅在 project 表为空时创建，已有项目则跳过，不会覆盖或重复创建。
 * - 创建成功后会把 admin 设为该项目成员（ADMIN 角色）作为双保险，superAdmin 本就能看所有项目。
 * - create 中不传 id / createdAt / updatedAt / version，由 Prisma 默认值自动生成。
 * - 任何数据库异常只记录日志、不向上抛错，避免阻塞后端启动。
 *
 * @param prisma 从 Nest DI 取出的 PrismaClient 实例
 */
export async function seedDefaultProject(prisma: PrismaClient): Promise<void> {
  try {
    const count = await prisma.project.count();
    if (count > 0) {
      return;
    }

    const p = await prisma.project.create({
      data: {
        code: 'DEFAULT',
        name: '默认项目',
        nameAbbr: '默认',
        codeAbbr: 'DEFAULT',
        description: '系统初始默认项目，可删除后自建项目',
      },
    });

    // 双保险：把 admin 设为该项目成员，保证其明确拥有该项目上下文
    const admin = await prisma.user.findUnique({ where: { username: 'admin' } });
    if (admin) {
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: p.id, userId: admin.id } },
        update: {},
        create: { projectId: p.id, userId: admin.id, roleCode: 'ADMIN' },
      });
    }

    console.log('[seed] 已创建默认项目:', p.code);
  } catch (e) {
    console.error('[seed] 初始化默认项目失败:', e);
  }
}

/**
 * 幂等「基础数据增补 + 历史数据修正」（每次启动执行，可安全重复调用）。
 *
 * 为什么放在这里而**不是** `prisma/seed-data.ts`：后者是「由本地 dev.db 提取」的自动生成物，
 * 文件头明确标注**不要手改**（改了下次提取会被覆盖）。新增字典/参数请加在本函数；
 * 历史数据修正同理（也不要去改已应用的迁移文件——会与 `_prisma_migrations` 的 checksum 冲突）。
 *
 * 当前处理项：
 * 1. 增补字典类型 `site_confirm_status`（现场确认状态，.claude/rules/backend-conventions.md「日报/现场确认」）及其字典项；
 * 2. 增补系统参数：`settlement.require_confirmed` / `settlement.over_amount_policy` / `payment.over_amount_policy`；
 * 3. 修正合同模板变量展示名：`银行名称` 的 varLabel 曾为「开户银行」（与 varKey 不一致，
 *    模板作者按展示名插入变量会拿到 `{开户银行}` 而永远不被替换）。
 *
 * ⚠️ 只做 **upsert / 定向 updateMany**：不覆盖已存在的字典项与参数值（业务可能已在页面上改过），
 *    也不删除任何数据。
 *
 * @param prisma 从 Nest DI 取出的 PrismaClient 实例
 */
export async function fixLegacyData(prisma: PrismaClient): Promise<void> {
  try {
    await seedSiteConfirmationDict(prisma);
    await seedBidderStatusDict(prisma);
    await seedEvaluationConclusionDict(prisma);
    await seedDocTemplateCategoryDict(prisma);
    await seedFinalSettlementStatusDict(prisma);
    await seedMaterialCategoryDicts(prisma);
    await seedAiPermissions(prisma);

    const fixed = await prisma.templateVariable.updateMany({
      where: { varKey: '银行名称', varLabel: '开户银行' },
      data: { varLabel: '银行名称' },
    });
    if (fixed.count > 0) {
      console.log('[seed] 已修正合同模板变量展示名（开户银行 → 银行名称）:', fixed.count, '条');
    }
  } catch (e) {
    console.error('[seed] 历史数据修正失败（不影响启动）:', e);
  }
}

/**
 * AI 助手权限码（2026-10-19 新增能力）。
 *
 * 为什么必须在这里播种：`src/seed.ts` 原本**不播种任何权限**（权限只在 `prisma/seed.ts`
 * 的 `main()` 里创建，只在空库 + `npm run seed` 生效）。新权限码若不进 `fixLegacyData`，
 * **存量库升级后菜单永远不可见**（角色里没有这条 permission，`GET /api/menu` 直接过滤掉）。
 *
 * 分配口径：`ai:view`（看入口/字段目录）与 `ai:use`（真正调模型）一起授给
 * **项目管理员**与**普通员工** —— AI 助手是录入效率工具，不是管理功能；
 * 超级管理员走 `isSuperAdmin` 直通，无需授权行。角色不存在时跳过（不造角色）。
 */
const AI_PERMISSIONS = [
  { code: 'ai:view', name: '查看 AI 助手', module: 'AI 助手' },
  { code: 'ai:use', name: '使用 AI 助手', module: 'AI 助手' },
];
const AI_PERMISSION_ROLE_CODES = ['PROJECT_MANAGER', 'STAFF'];

async function seedAiPermissions(prisma: PrismaClient): Promise<void> {
  const roles = await prisma.role.findMany({
    where: { code: { in: AI_PERMISSION_ROLE_CODES } },
    select: { id: true },
  });
  for (const p of AI_PERMISSIONS) {
    const perm = await prisma.permission.upsert({
      where: { code: p.code },
      update: { name: p.name, module: p.module },
      create: p,
    });
    for (const role of roles) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }
}

/**
 * 物资一/二级分类字典同步（业务 2026-10-18 提供的分类表）。
 *
 * - 一级 → `material_category`；二级 → `material_type`（`extField1` = 一级编码）；
 * - **只在首次（或分类表版本升级）做全量同步**：upsert 规范项 + 表外旧项置停用 +
 *   历史编码/名称迁移；之后每次启动只补齐缺失的规范项，**不覆盖字典管理里手工维护的**
 *   名称/颜色/排序/启停，也不停用业务新增的分类（字典驱动必须可维护）。
 * - 同步版本记录在系统参数 `material.category.sync.version`。
 */
const MATERIAL_CATEGORY_SYNC_KEY = 'material.category.sync.version';
const MATERIAL_CATEGORY_SYNC_VERSION = '2026-10-18';

async function seedMaterialCategoryDicts(prisma: PrismaClient): Promise<void> {
  const marker = await prisma.sysParam.findUnique({
    where: { key: MATERIAL_CATEGORY_SYNC_KEY },
    select: { value: true },
  });
  const applied = marker?.value === MATERIAL_CATEGORY_SYNC_VERSION;

  await prisma.dictType.upsert({
    where: { code: 'material_category' },
    update: { name: '材料类别（物资一级分类）', status: 1 },
    create: { code: 'material_category', name: '材料类别（物资一级分类）', sort: 7, status: 1, isSystem: true, scope: 'GLOBAL' },
  });
  await prisma.dictType.upsert({
    where: { code: 'material_type' },
    update: { name: '物资种类（二级分类，关联材料类别）', status: 1 },
    create: {
      code: 'material_type',
      name: '物资种类（二级分类，关联材料类别）',
      remark: 'extField1 存储所属材料类别编码，实现与 material_category 联动',
      sort: 8,
      status: 1,
      isSystem: true,
      scope: 'GLOBAL',
    },
  });

  /**
   * 已同步过：只补齐**缺失**的规范项（两次查询 + 最多两次批量插入），
   * 不覆盖手工维护的名称/颜色/排序/启停，避免每次启动 77 次串行 upsert。
   */
  if (applied) {
    const existingL1 = new Set(
      (await prisma.dictItem.findMany({ where: { typeCode: 'material_category' }, select: { itemCode: true } })).map(
        (i) => i.itemCode,
      ),
    );
    const missingL1 = MATERIAL_CATEGORY_L1.filter((i) => !existingL1.has(i.code)).map((i) => ({
      typeCode: 'material_category',
      itemCode: i.code,
      itemName: i.name,
      sortOrder: i.sortOrder,
      status: 1,
      color: i.color,
    }));
    if (missingL1.length) await prisma.dictItem.createMany({ data: missingL1, skipDuplicates: true });

    const existingL2 = new Set(
      (await prisma.dictItem.findMany({ where: { typeCode: 'material_type' }, select: { itemCode: true } })).map(
        (i) => i.itemCode,
      ),
    );
    const colorOf = new Map(MATERIAL_CATEGORY_L1.map((i) => [i.code, i.color]));
    const missingL2 = MATERIAL_CATEGORY_L2.filter((i) => !existingL2.has(i.code)).map((i) => ({
      typeCode: 'material_type',
      itemCode: i.code,
      itemName: i.name,
      sortOrder: i.sortOrder,
      status: 1,
      color: colorOf.get(i.parent) ?? 'default',
      extField1: i.parent,
    }));
    if (missingL2.length) await prisma.dictItem.createMany({ data: missingL2, skipDuplicates: true });
    return;
  }

  const colorOf = new Map(MATERIAL_CATEGORY_L1.map((i) => [i.code, i.color]));
  for (const it of MATERIAL_CATEGORY_L1) {
    await prisma.dictItem.upsert({
      where: { typeCode_itemCode: { typeCode: 'material_category', itemCode: it.code } },
      update: { itemName: it.name, sortOrder: it.sortOrder, status: 1, color: it.color, extField1: null },
      create: {
        typeCode: 'material_category',
        itemCode: it.code,
        itemName: it.name,
        sortOrder: it.sortOrder,
        status: 1,
        color: it.color,
      },
    });
  }
  for (const it of MATERIAL_CATEGORY_L2) {
    const color = colorOf.get(it.parent) ?? 'default';
    await prisma.dictItem.upsert({
      where: { typeCode_itemCode: { typeCode: 'material_type', itemCode: it.code } },
      update: { itemName: it.name, sortOrder: it.sortOrder, status: 1, color, extField1: it.parent },
      create: {
        typeCode: 'material_type',
        itemCode: it.code,
        itemName: it.name,
        sortOrder: it.sortOrder,
        status: 1,
        color,
        extField1: it.parent,
      },
    });
  }

  if (!applied) {
    // 表外旧项停用（不删除）：仅首次同步时清理旧种子数据
    await prisma.dictItem.updateMany({
      where: { typeCode: 'material_category', itemCode: { notIn: MATERIAL_CATEGORY_L1.map((i) => i.code) } },
      data: { status: 0 },
    });
    await prisma.dictItem.updateMany({
      where: { typeCode: 'material_type', itemCode: { notIn: MATERIAL_CATEGORY_L2.map((i) => i.code) } },
      data: { status: 0 },
    });

    // 历史日报编码 → 新编码（幂等）
    for (const m of LEGACY_CATEGORY_CODE_MAP) {
      if (m.typeCode === 'material_category') {
        await prisma.dailyReport.updateMany({ where: { materialCategory: m.from }, data: { materialCategory: m.to } });
      } else {
        await prisma.dailyReport.updateMany({ where: { materialType: m.from }, data: { materialType: m.to } });
      }
    }
    // 物资基础库存的是名称：旧名称 → 新名称（幂等）
    for (const m of LEGACY_CATEGORY_NAME_MAP) {
      await prisma.materialBase.updateMany({ where: { [m.field]: m.from }, data: { [m.field]: m.to } });
    }

    // 停用历史遗留的重复字典（代码从未引用；保留数据以便追溯）
    await prisma.dictType.updateMany({
      where: { code: { in: ['material_category_l1', 'material_category_l2'] } },
      data: { status: 0 },
    });
    await prisma.dictItem.updateMany({
      where: { typeCode: { in: ['material_category_l1', 'material_category_l2'] } },
      data: { status: 0 },
    });

    await prisma.sysParam.upsert({
      where: { key: MATERIAL_CATEGORY_SYNC_KEY },
      update: { value: MATERIAL_CATEGORY_SYNC_VERSION },
      create: {
        key: MATERIAL_CATEGORY_SYNC_KEY,
        value: MATERIAL_CATEGORY_SYNC_VERSION,
        remark: '物资分类全量同步版本（升级分类表时递增；之后启动不覆盖手工维护项）',
      },
    });
  }
}

/**
 * 现场确认字典与相关系统参数（口径见 .claude/rules/backend-conventions.md「日报/现场确认」）。
 * - 字典类型 `site_confirm_status`：PENDING 待确认 / CONFIRMED 已确认 / REJECTED 已驳回
 * - 参数 `settlement.require_confirmed`（默认 true）：结算口径是否只认「已确认」的现场记录
 * - 参数 `settlement.over_amount_policy` / `payment.over_amount_policy`（默认 WARN）：
 *   累计结算超过合同链金额 / 累计付款超过累计结算时的策略（BLOCK 拦截 / WARN 仅提示 / OFF 不校验）
 */
async function seedSiteConfirmationDict(prisma: PrismaClient): Promise<void> {
  const typeCode = 'site_confirm_status';
  await prisma.dictType.upsert({
    where: { code: typeCode },
    update: {},
    create: {
      code: typeCode,
      name: '现场确认状态',
      remark: '日报行（现场记录）的确认状态，决定该行是否计入结算口径',
      sort: 60,
      status: 1,
      isSystem: true,
      scope: 'GLOBAL',
    },
  });

  const items = [
    { itemCode: 'PENDING', itemName: '待确认', sortOrder: 1, color: 'orange', remark: '日报页手工新增的默认态；未确认时不计入结算口径' },
    { itemCode: 'CONFIRMED', itemName: '已确认', sortOrder: 2, color: 'green', remark: '计入结算口径；收领单推送生成的行自动为此态' },
    { itemCode: 'REJECTED', itemName: '已驳回', sortOrder: 3, color: 'red', remark: '不计入结算口径，可重新确认' },
  ];
  for (const it of items) {
    await prisma.dictItem.upsert({
      where: { typeCode_itemCode: { typeCode, itemCode: it.itemCode } },
      update: {},
      create: { typeCode, itemCode: it.itemCode, itemName: it.itemName, sortOrder: it.sortOrder, status: 1, color: it.color, remark: it.remark, extField1: null },
    });
  }

  const params = [
    {
      key: 'settlement.require_confirmed',
      value: 'true',
      remark: '结算口径是否只认「已确认」的现场记录（true/false）；关闭后与改造前一致',
    },
    {
      key: 'settlement.over_amount_policy',
      value: 'WARN',
      remark: '累计结算超过合同链金额（含补充协议）时的策略：BLOCK 拦截 / WARN 仅提示 / OFF 不校验',
    },
    {
      key: 'payment.over_amount_policy',
      value: 'WARN',
      remark: '累计付款超过累计结算时的策略：BLOCK 拦截 / WARN 仅提示 / OFF 不校验',
    },
  ];
  for (const p of params) {
    await prisma.sysParam.upsert({ where: { key: p.key }, update: {}, create: p });
  }
}

/**
 * 招标域字典（docs/05 §6「设计 A」，2026-10-19）：
 * `bidder_status` —— 投标/响应单位状态。`WON` 由服务端在「勾选拟推荐成交候选人」时驱动，
 * 取消勾选回落到「入围/已递交」（判据：`constants/procurementFlow.ts` 的 `bidderStatusWhenNotWon()`）。
 * code 的单一事实源是 `constants/statuses.ts` 的 `BIDDER_STATUS`，由 `test/statusCodes.spec.mts` 双向锁。
 */
async function seedBidderStatusDict(prisma: PrismaClient): Promise<void> {
  const typeCode = 'bidder_status';
  await prisma.dictType.upsert({
    where: { code: typeCode },
    update: {},
    create: {
      code: typeCode,
      name: '投标单位状态',
      remark: '成交报告「响应单位情况汇总表」的响应单位状态；WON 由勾选候选人驱动',
      sort: 61,
      status: 1,
      isSystem: true,
      scope: 'GLOBAL',
    },
  });

  const items = [
    { itemCode: 'SIGNED_UP', itemName: '已报名', sortOrder: 1, color: 'default', remark: null },
    { itemCode: 'SUBMITTED', itemName: '已递交', sortOrder: 2, color: 'blue', remark: '导入响应单位后的默认态' },
    { itemCode: 'ABSTAINED', itemName: '弃权', sortOrder: 3, color: 'default', remark: null },
    { itemCode: 'SHORTLISTED', itemName: '入围', sortOrder: 4, color: 'cyan', remark: '通过第一轮报价但未中标；取消勾选时自动回落到此态' },
    { itemCode: 'WON', itemName: '中标', sortOrder: 5, color: 'green', remark: '勾选「拟推荐成交候选人」即为此态；生成合同的单位与金额取自这些行' },
    { itemCode: 'LOST', itemName: '未中标', sortOrder: 6, color: 'red', remark: null },
  ];
  for (const it of items) {
    await prisma.dictItem.upsert({
      where: { typeCode_itemCode: { typeCode, itemCode: it.itemCode } },
      update: {},
      create: { typeCode, itemCode: it.itemCode, itemName: it.itemName, sortOrder: it.sortOrder, status: 1, color: it.color, remark: it.remark, extField1: null },
    });
  }
}

/**
 * 单据模板分类字典（业务口径 2026-10-16）：基础信息管理 →「单据模板」模块用**五类**：
 * 结算单 / 总结算单 / 保理单 / 逾期利息 / 付款单。
 *
 * ⚠️ 刻意**不复用** `contract_template_category`：那是合同模板的分类，混在一起会让
 * "合同模板"的分类下拉里冒出"付款单"，两类东西的编辑与生成路径都不同。
 * 单据模板复用 `ContractTemplate` **表**（见 schema 注释），但分类走这一套字典。
 */
async function seedDocTemplateCategoryDict(prisma: PrismaClient): Promise<void> {
  const typeCode = 'doc_template_category';
  await prisma.dictType.upsert({
    where: { code: typeCode },
    update: {},
    create: {
      code: typeCode,
      name: '单据模板分类',
      remark: '基础信息管理 → 单据模板：结算单 / 总结算单 / 保理单 / 逾期利息 / 付款单',
      sort: 63,
      status: 1,
      isSystem: true,
      scope: 'GLOBAL',
    },
  });

  const items = [
    { itemCode: 'SETTLEMENT', itemName: '结算单', sortOrder: 1, color: 'blue', remark: null },
    { itemCode: 'FINAL_SETTLEMENT', itemName: '总结算单', sortOrder: 2, color: 'cyan', remark: null },
    { itemCode: 'FACTORING', itemName: '保理单', sortOrder: 3, color: 'purple', remark: null },
    { itemCode: 'OVERDUE', itemName: '逾期利息', sortOrder: 4, color: 'orange', remark: null },
    { itemCode: 'PAYMENT', itemName: '付款单', sortOrder: 5, color: 'green', remark: '付款单与总结算单已接 Excel 生成路径' },
  ];
  for (const it of items) {
    await prisma.dictItem.upsert({
      where: { typeCode_itemCode: { typeCode, itemCode: it.itemCode } },
      update: {},
      create: { typeCode, itemCode: it.itemCode, itemName: it.itemName, sortOrder: it.sortOrder, status: 1, color: it.color, remark: it.remark, extField1: null },
    });
  }
}

/**
 * 总结算单状态字典（业务口径 2026-10-16）：**待附件 → 已结算**。
 * code 的单一事实源是 `constants/statuses.ts` 的 `FINAL_SETTLEMENT_STATUS`，
 * 由 `test/statusCodes.spec.mts` 双向锁（常量 ↔ 本函数里的字典项）。
 */
async function seedFinalSettlementStatusDict(prisma: PrismaClient): Promise<void> {
  const typeCode = 'final_settlement_status';
  await prisma.dictType.upsert({
    where: { code: typeCode },
    update: {},
    create: {
      code: typeCode,
      name: '总结算单状态',
      remark: '附件上传完成即「已结算」，并驱动合同转为已完已结（付款比例切 100%）',
      sort: 64,
      status: 1,
      isSystem: true,
      scope: 'GLOBAL',
    },
  });

  const items = [
    { itemCode: 'PENDING_ATTACHMENT', itemName: '待附件', sortOrder: 1, color: 'orange', remark: '已抓取月度结算生成，待上传附件' },
    { itemCode: 'SETTLED', itemName: '已结算', sortOrder: 2, color: 'green', remark: '附件已上传；合同执行情况置「已完已结」' },
  ];
  for (const it of items) {
    await prisma.dictItem.upsert({
      where: { typeCode_itemCode: { typeCode, itemCode: it.itemCode } },
      update: {},
      create: { typeCode, itemCode: it.itemCode, itemName: it.itemName, sortOrder: it.sortOrder, status: 1, color: it.color, remark: it.remark, extField1: null },
    });
  }
}

/**
 * **启动播种的唯一入口**（把 main.ts 里原先分散的四次调用串成一段，并加并发保护）。
 *
 * 为什么需要并发保护：Prisma 的 `upsert` **不保证原子**（会退化成 `insert` → 撞唯一键则 `update`），
 * 空库上多进程同时走到 `insert` 分支时，后者抛 `P2002` → 该 seed 函数被中断
 * → **它后面的字典项/参数就漏播了**（只有一条日志，极难察觉）。
 * 真实触发场景有两个：
 * ① 后端**多副本**、或容器重启与新实例重叠（同 CLAUDE.md 提到的多副本必办项）；
 * ② **CI 的集成测试**：`test-integration/*.int.spec.ts` 每个文件并发跑、各自启动一次应用并跑一遍播种，
 *    空库上必现（2026-10-16 实测：spec 从 4 个加到 5 个后 CI 每次都红，本地因库已播种而看不出来）。
 *
 * 做法：用**事务级**咨询锁（`pg_advisory_xact_lock`）把整段播种串行化。
 * - 同一事务内的查询走**同一条连接**，锁在事务边界获取/释放 —— 规避了会话级
 *   `pg_advisory_lock` 在连接池下"加锁与解锁不在同一连接"的经典坑；
 * - 后到的进程会等前一个提交，之后它的 `upsert` 全部走 `update` 分支（幂等、无副作用）。
 *
 * ⚠️ 播种顺序有依赖：默认项目要把 admin 设为成员，故 admin 必须先建。
 */
export async function runStartupSeed(prisma: PrismaClient): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // 键值任意，只要全仓一致即可；仅用于串行化"启动播种"这一段
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(854412)`;
      // 事务客户端只用到各模型委托，与 PrismaClient 的差异在此不涉及
      const client = tx as unknown as PrismaClient;
      await seedAdmin(client);
      await seedDefaultProject(client);
      await seedDictAndParams(client);
      await fixLegacyData(client);
    },
    { timeout: 60000 },
  );
}

/** 招标域字典：`evaluation_conclusion` —— 评标记录的结论（推荐 / 不推荐） */
async function seedEvaluationConclusionDict(prisma: PrismaClient): Promise<void> {
  const typeCode = 'evaluation_conclusion';
  await prisma.dictType.upsert({
    where: { code: typeCode },
    update: {},
    create: {
      code: typeCode,
      name: '评标结论',
      remark: '评标记录（ProcurementEvaluation）的结论',
      sort: 62,
      status: 1,
      isSystem: true,
      scope: 'GLOBAL',
    },
  });

  const items = [
    { itemCode: 'RECOMMEND', itemName: '推荐', sortOrder: 1, color: 'green', remark: null },
    { itemCode: 'NOT_RECOMMEND', itemName: '不推荐', sortOrder: 2, color: 'red', remark: null },
  ];
  for (const it of items) {
    await prisma.dictItem.upsert({
      where: { typeCode_itemCode: { typeCode, itemCode: it.itemCode } },
      update: {},
      create: { typeCode, itemCode: it.itemCode, itemName: it.itemName, sortOrder: it.sortOrder, status: 1, color: it.color, remark: it.remark, extField1: null },
    });
  }
}


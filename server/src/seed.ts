import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { dictTypes, dictItems, sysParams } from './seed-data';

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
 *    模板作者按展示名插入变量会拿到 `{开户银行}` 而永远不被替换，docs/06 #8）。
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


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

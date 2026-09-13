import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { dictTypes, dictItems, sysParams } from './seed-data';

/**
 * 启动时若用户表为空，则自动创建一个默认管理员账号，
 * 保证首次部署（空 SQLite 库）也能直接登录。
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

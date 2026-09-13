import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

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

import type { Prisma } from '@prisma/client';

/**
 * 用户（`User`）的**写入原语**——表归 system 模块所有（用户管理 CRUD 在 system.service.ts）。
 *
 * 认证模块确实要改用户行：登录成功记最后登录时间、改密码写新哈希。按模块边界规则
 * 不直接写表，收敛到本文件；哈希算法由调用方（auth）决定，这里只负责落库。
 */
type Db = Prisma.TransactionClient;

/** 记录最后登录时间（登录成功调用） */
export async function touchUserLastLogin(db: Db, userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
}

/** 写入新的密码哈希（调用方负责 bcrypt 加密与强度校验） */
export async function setUserPasswordHash(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { password: passwordHash } });
}

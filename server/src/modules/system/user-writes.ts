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

/**
 * 写入新的密码哈希（调用方负责 bcrypt 加密与强度校验）。
 *
 * 同时 `tokenVersion + 1`（2026-11-23）：JWT 里带 `tv`，`JwtStrategy` 每次校验都跟库里比。
 * 否则「改密码」只对新登录生效，泄露/共享出去的旧 token 仍能用到 7 天有效期末。
 */
export async function setUserPasswordHash(db: Db, userId: string, passwordHash: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { password: passwordHash, tokenVersion: { increment: 1 } },
  });
}

/**
 * 递增令牌版本 → 该用户已签发的所有 JWT 立即失效（停用账号、强制下线时调用）。
 * 与改密同一条通道：`JwtStrategy` 只认「token 里的 tv == 库里的 tokenVersion」。
 */
export async function bumpUserTokenVersion(db: Db, userId: string): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
}

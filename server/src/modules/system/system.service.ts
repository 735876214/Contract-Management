import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { paginate, buildResult } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { SysParamService } from '../../common/services/sys-param.service';

/**
 * 用户主表可写字段白名单（password 单独处理，roleIds 走关联表）。
 *
 * **`isSuperAdmin` 不在白名单里**（第 21 轮审计 P0）：超管在
 * `assertPermission()` / `PermissionsGuard` / `ProjectAccessService` 里**直接短路放行**，
 * 等于「全部权限 + 全部项目」。而它原来是可写字段——任何拿到 `system:user` 编辑权的人
 * 只要 `PUT /system/users/<自己的 id>` 带 `{ isSuperAdmin: true }`，一次请求就把自己提成超管
 * （新用户接口同理）。这条路径不是业务能力：前端根本没有这个开关，
 * 超管身份由种子/运维在库里指定，接口一律不接受该字段（传了会被 `pickFields` 丢弃）。
 */
const USER_WRITABLE_FIELDS = ['username', 'realName', 'phone', 'email', 'status'];

/** 出参统一剥掉 bcrypt 哈希：新增/修改/重置密码都不许把 `password` 回给前端 */
function stripPassword<T extends Record<string, any> | null | undefined>(row: T): T {
  if (!row) return row;
  const { password, ...rest } = row as any;
  return rest as T;
}

@Injectable()
export class SystemService {
  constructor(private prisma: PrismaClient, private sysParam: SysParamService) {}

  // ---------------- 用户 ----------------
  async users(query: any = {}) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.keyword) where.OR = [{ username: { contains: query.keyword } }, { realName: { contains: query.keyword } }];
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    const [list, total] = await Promise.all([
      this.prisma.user.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { roles: { include: { role: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);
    return buildResult(list.map(({ password, ...u }: any) => u), total, query);
  }

  async createUser(data: any) {
    const exist = await this.prisma.user.findUnique({ where: { username: data.username } });
    if (exist) throw new BadRequestException('用户名已存在');
    const password = await bcrypt.hash(data.password || '123456', 10);
    const { roleIds, ...rest } = data;
    const created = await this.prisma.user.create({
      data: {
        ...pickFields(rest, USER_WRITABLE_FIELDS, { label: '用户' }),
        password,
        roles: roleIds?.length ? { create: roleIds.map((roleId: string) => ({ role: { connect: { id: roleId } } })) } : undefined,
      },
    });
    return stripPassword(created);
  }

  /**
   * 改用户：主表与角色关联必须同事务。
   * 原实现先 `userRole.deleteMany` → `createMany` → `user.update`，三步各自提交：
   * 用户名撞车（P2002）时 update 失败，而角色关联已经删掉 → 该用户下次登录无任何权限，
   * 且接口只回 500，管理员看不出「权限被清了」。
   */
  async updateUser(id: string, data: any) {
    const { roleIds, password, ...rest } = data;
    const payload = pickFields(rest, USER_WRITABLE_FIELDS, { label: '用户' });
    if (payload.username) {
      const dup = await this.prisma.user.findFirst({ where: { username: payload.username, id: { not: id } } });
      if (dup) throw new BadRequestException('用户名已存在');
    }
    const hashed = password ? await bcrypt.hash(password, 10) : undefined;
    const updated = await this.prisma.$transaction(async (tx) => {
      if (roleIds) {
        await tx.userRole.deleteMany({ where: { userId: id } });
        if (roleIds.length) {
          await tx.userRole.createMany({ data: roleIds.map((roleId: string) => ({ userId: id, roleId })) });
        }
      }
      return tx.user.update({
        where: { id },
        data: hashed ? { ...payload, password: hashed } : payload,
      });
    });
    return stripPassword(updated);
  }

  async removeUser(id: string) {
    await this.prisma.user.delete({ where: { id } });
    return true;
  }

  async resetPassword(id: string, password: string) {
    const updated = await this.prisma.user.update({ where: { id }, data: { password: await bcrypt.hash(password || '123456', 10) } });
    return stripPassword(updated);
  }

  // ---------------- 角色 ----------------
  async roles() {
    return this.prisma.role.findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { createdAt: 'desc' } });
  }

  async createRole(data: any) {
    return this.prisma.role.create({ data });
  }

  /** 改角色：权限关联与主表同事务（理由同 `updateUser`，失败时不能留下「权限被清空」的角色） */
  async updateRole(id: string, data: any) {
    const { permissionIds, ...rest } = data;
    return this.prisma.$transaction(async (tx) => {
      if (permissionIds) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        if (permissionIds.length) {
          await tx.rolePermission.createMany({ data: permissionIds.map((permissionId: string) => ({ roleId: id, permissionId })) });
        }
      }
      return tx.role.update({ where: { id }, data: rest });
    });
  }

  async removeRole(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (role?.code === 'SUPER_ADMIN') throw new BadRequestException('超级管理员角色不可删除');
    await this.prisma.role.delete({ where: { id } });
    return true;
  }

  async permissions() {
    const list = await this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] });
    const grouped: Record<string, any[]> = {};
    list.forEach((p: any) => (grouped[p.module] = [...(grouped[p.module] || []), p]));
    return Object.entries(grouped).map(([module, items]) => ({ module, items }));
  }

  // ---------------- 系统参数 ----------------
  /**
   * 敏感参数：**只由「系统管理 → AI 信息登记」页面维护**，通用参数接口既不返回也不接受。
   *
   * 2026-10-20 审计 P2：`ai.apiKey` 存在 SysParam 里，通用参数页会把它明文铺在表格中，
   * 与「密钥只写不读」的口径冲突；而且页面「保存全部」会把别的页面刚改的键覆盖回去。
   * 这里直接不透出，避免任何读取路径（含导出、日志）带出明文。
   */
  private readonly secretParamKeys = new Set(['ai.apiKey']);

  async params() {
    const rows = await this.prisma.sysParam.findMany({ orderBy: { key: 'asc' } });
    return rows.filter((r) => !this.secretParamKeys.has(r.key));
  }

  async saveParams(items: { key: string; value?: string }[]) {
    for (const item of items) {
      // 敏感键不从这里写：否则「读不到值 → 提交空串 → 把密钥清掉」是必然结果
      if (this.secretParamKeys.has(item.key)) continue;
      await this.sysParam.set(item.key, item.value ?? '');
    }
    await this.sysParam.refresh();
    return this.params();
  }

  // ---------------- 日志 ----------------
  async operationLogs(query: any = {}) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.userId) where.userId = query.userId;
    if (query.module) where.module = query.module;
    if (query.action) where.action = query.action;
    if (query.result) where.result = query.result;
    if (query.bizType) where.bizType = query.bizType;
    if (query.projectId) where.projectId = query.projectId;
    if (query.keyword) {
      where.OR = [
        { username: { contains: query.keyword } },
        { action: { contains: query.keyword } },
        { url: { contains: query.keyword } },
        { bizId: { contains: query.keyword } },
      ];
    }
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }
    const [list, total] = await Promise.all([
      this.prisma.operationLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.operationLog.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async loginLogs(query: any = {}) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.keyword) where.username = { contains: query.keyword };
    const [list, total] = await Promise.all([
      this.prisma.loginLog.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.loginLog.count({ where }),
    ]);
    return buildResult(list, total, query);
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { paginate, buildResult } from '../../common/utils/helpers';
import { SysParamService } from '../../common/services/sys-param.service';

@Injectable()
export class SystemService {
  constructor(private prisma: PrismaClient, private sysParam: SysParamService) {}

  // ---------------- 用户 ----------------
  async users(query: any = {}) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.keyword) where.OR = [{ username: { contains: query.keyword } }, { realName: { contains: query.keyword } }];
    if (query.deptId) where.deptId = query.deptId;
    if (query.status !== undefined && query.status !== '') where.status = Number(query.status);
    const [list, total] = await Promise.all([
      this.prisma.user.findMany({
        where, skip, take, orderBy: { createdAt: 'desc' },
        include: { dept: true, roles: { include: { role: true } } },
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
    return this.prisma.user.create({
      data: {
        ...rest,
        password,
        roles: roleIds?.length ? { create: roleIds.map((roleId: string) => ({ role: { connect: { id: roleId } } })) } : undefined,
      },
    });
  }

  async updateUser(id: string, data: any) {
    const { roleIds, password, ...rest } = data;
    if (roleIds) {
      await this.prisma.userRole.deleteMany({ where: { userId: id } });
      if (roleIds.length) {
        await this.prisma.userRole.createMany({ data: roleIds.map((roleId: string) => ({ userId: id, roleId })) });
      }
    }
    return this.prisma.user.update({
      where: { id },
      data: password ? { ...rest, password: await bcrypt.hash(password, 10) } : rest,
    });
  }

  async removeUser(id: string) {
    await this.prisma.user.delete({ where: { id } });
    return true;
  }

  async resetPassword(id: string, password: string) {
    return this.prisma.user.update({ where: { id }, data: { password: await bcrypt.hash(password || '123456', 10) } });
  }

  // ---------------- 角色 ----------------
  async roles() {
    return this.prisma.role.findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { createdAt: 'desc' } });
  }

  async createRole(data: any) {
    return this.prisma.role.create({ data });
  }

  async updateRole(id: string, data: any) {
    const { permissionIds, ...rest } = data;
    if (permissionIds) {
      await this.prisma.rolePermission.deleteMany({ where: { roleId: id } });
      if (permissionIds.length) {
        await this.prisma.rolePermission.createMany({ data: permissionIds.map((permissionId: string) => ({ roleId: id, permissionId })) });
      }
    }
    return this.prisma.role.update({ where: { id }, data: rest });
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

  // ---------------- 部门 ----------------
  async depts() {
    const list = await this.prisma.dept.findMany({ orderBy: { sort: 'asc' } });
    return list;
  }

  async createDept(data: any) {
    return this.prisma.dept.create({ data });
  }

  async updateDept(id: string, data: any) {
    return this.prisma.dept.update({ where: { id }, data });
  }

  async removeDept(id: string) {
    const [userCount, childCount] = await Promise.all([
      this.prisma.user.count({ where: { deptId: id } }),
      this.prisma.dept.count({ where: { parentId: id } }),
    ]);
    if (userCount || childCount) throw new BadRequestException('部门下存在人员或子部门，不可删除');
    await this.prisma.dept.delete({ where: { id } });
    return true;
  }

  // ---------------- 系统参数 ----------------
  async params() {
    return this.prisma.sysParam.findMany({ orderBy: { key: 'asc' } });
  }

  async saveParams(items: { key: string; value?: string }[]) {
    for (const item of items) {
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

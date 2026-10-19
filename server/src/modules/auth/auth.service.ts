import { Injectable, UnauthorizedException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { LogService } from '../../common/services/log.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { ProjectAccessService } from '../../common/services/project-access.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaClient,
    private jwt: JwtService,
    private logService: LogService,
    private sysParam: SysParamService,
    private projectAccess: ProjectAccessService,
  ) {}

  async validateUser(username: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { username } });
    if (!user) throw new UnauthorizedException('用户名或密码错误');
    if (user.status !== 1) throw new UnauthorizedException('账号已停用');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('用户名或密码错误');
    return user;
  }

  async login(username: string, password: string, ip: string, userAgent: string) {
    const user = await this.validateUser(username, password);
    const permissions = await this.getPermissions(user.id, user.isSuperAdmin);
    const projects = await this.getProjects(user.id, user.isSuperAdmin);

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.logService.login({ userId: user.id, username: user.username, ip, userAgent, result: 'SUCCESS' });

    const payload = { sub: user.id, username: user.username };
    return {
      token: this.jwt.sign(payload),
      user: {
        id: user.id,
        username: user.username,
        realName: user.realName,
        isSuperAdmin: user.isSuperAdmin,
        permissions,
      },
      projects,
    };
  }

  async getPermissions(userId: string, isSuperAdmin: boolean): Promise<string[]> {
    if (isSuperAdmin) {
      const all = await this.prisma.permission.findMany();
      return all.map((p) => p.code);
    }
    const roles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { include: { permissions: { include: { permission: true } } } } },
    });
    const set = new Set<string>();
    roles.forEach((r: any) => r.role?.permissions?.forEach((rp: any) => set.add(rp.permission.code)));
    return Array.from(set);
  }

  async getProjects(userId: string, isSuperAdmin: boolean) {
    const multiEnabled = (await this.sysParam.get('multi.project.enabled', 'true')) === 'true';
    if (isSuperAdmin) {
      const list = await this.prisma.project.findMany({ orderBy: { createdAt: 'asc' } });
      return list.map((p) => ({ ...p, roleCode: 'ADMIN' }));
    }
    const members = await this.prisma.projectMember.findMany({
      where: { userId },
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    });
    let list = members.map((m: any) => ({ ...m.project, roleCode: m.roleCode }));
    if (!multiEnabled) list = list.slice(0, 1);
    return list;
  }

  /** 校验当前用户是否可以访问项目（实现在 ProjectAccessService，guard 与这里共用同一口径） */
  async assertProjectAccess(userId: string, projectId: string, isSuperAdmin: boolean) {
    return this.projectAccess.assertAccess(userId, projectId, isSuperAdmin);
  }

  async profile(userId: string, isSuperAdmin: boolean) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new UnauthorizedException('用户不存在');
    const { password, ...rest } = user as any;
    return {
      ...rest,
      permissions: await this.getPermissions(user.id, isSuperAdmin),
      projects: await this.getProjects(user.id, isSuperAdmin),
      params: await this.sysParam.getAll(),
    };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    const ok = await bcrypt.compare(oldPassword, user.password);
    if (!ok) throw new ForbiddenException('原密码不正确');
    await this.prisma.user.update({ where: { id: userId }, data: { password: await bcrypt.hash(newPassword, 10) } });
    return true;
  }
}

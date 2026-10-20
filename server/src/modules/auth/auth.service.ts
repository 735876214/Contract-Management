import { Injectable, UnauthorizedException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { LogService } from '../../common/services/log.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { ProjectAccessService } from '../../common/services/project-access.service';
import { LoginThrottle } from './login-throttle';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaClient,
    private jwt: JwtService,
    private logService: LogService,
    private sysParam: SysParamService,
    private projectAccess: ProjectAccessService,
    private throttle: LoginThrottle,
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
    // 撞库防护：同一「用户名 + IP」15 分钟内输错 5 次即临时锁定（见 LoginThrottle）。
    // 放在查库之前，被锁时连 bcrypt 都不做——既挡住爆破，也不给对手用 bcrypt 拖垮 CPU。
    const throttleKey = this.throttle.keyOf(username, ip);
    this.throttle.assertNotThrottled(throttleKey);
    let user: any;
    try {
      user = await this.validateUser(username, password);
    } catch (e) {
      this.throttle.fail(throttleKey);
      // 失败也要留痕：只记成功路径时，撞库/暴力破解在本系统没有任何审计记录，
      // 登录日志页的「失败」标签成了死代码。用户名记输入值（不存在也照记），不记密码。
      await this.logService.login({ username, ip, userAgent, result: 'FAIL' });
      // 刚好被锁上时把「还要等几分钟」告诉他，比继续报「用户名或密码错误」有用
      this.throttle.assertNotThrottled(throttleKey);
      throw e;
    }
    // 成功即清零：正常用户输错一两次，不该在之后 15 分钟里被上一次的失败拖累
    this.throttle.reset(throttleKey);
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
    // 改密同样限次：否则「已登录但想提权」的人可以拿它当旧密码爆破口
    const pwdKey = `pwd:${userId}`;
    this.throttle.assertNotThrottled(pwdKey);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    const ok = await bcrypt.compare(oldPassword, user.password);
    if (!ok) {
      this.throttle.fail(pwdKey);
      throw new ForbiddenException('原密码不正确');
    }
    this.throttle.reset(pwdKey);
    await this.prisma.user.update({ where: { id: userId }, data: { password: await bcrypt.hash(newPassword, 10) } });
    return true;
  }
}

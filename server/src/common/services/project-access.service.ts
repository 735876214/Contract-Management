import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * 项目上下文鉴权（**单一实现**，`AuthService.assertProjectAccess` 与 `JwtAuthGuard` 都走这里）。
 *
 * 背景：权限码是全局 RBAC（`module:action`），**不带项目维度**；`x-project-id` 只表达
 * 「想访问哪个项目」，能否访问必须按 `projectMember` 关系校验。此前 `ProjectId` 装饰器
 * 只判非空、`assertProjectAccess()` 无调用点，任何持权限码的登录用户换个 `x-project-id`
 * 即可读写其他项目数据（按 id 查询的 findOne/update/remove 组合成跨项目 IDOR）。
 */
@Injectable()
export class ProjectAccessService {
  constructor(private prisma: PrismaClient) {}

  /** 校验用户可访问该项目；返回项目（调用方一般只看 id/name） */
  async assertAccess(
    userId: string | undefined,
    projectId: string,
    isSuperAdmin = false,
  ): Promise<{ id: string; name: string }> {
    if (!projectId) throw new ForbiddenException('缺少项目上下文，请先选择项目');
    if (isSuperAdmin) {
      const project = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true },
      });
      if (!project) throw new NotFoundException('项目不存在');
      return project;
    }
    if (!userId) throw new ForbiddenException('未登录');
    // 单查询同时取成员关系与项目（projectId_userId 唯一索引），失败路径再区分 404/403
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { project: { select: { id: true, name: true } } },
    });
    if (member?.project) return member.project;
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('项目不存在');
    throw new ForbiddenException('无权访问该项目');
  }
}

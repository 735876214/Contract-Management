import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';

const PROJECT_FIELDS = ['code', 'name', 'status', 'description', 'startDate', 'endDate', 'managerId'];

@Injectable()
export class ProjectService {
  constructor(private prisma: PrismaClient, private dict: DictService) {}

  async findAll(query: any = {}, user: any) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.keyword) where.OR = [{ name: { contains: query.keyword } }, { code: { contains: query.keyword } }];
    if (query.status) where.status = query.status;
    if (!user?.isSuperAdmin) {
      where.members = { some: { userId: user.userId } };
    }
    const [list, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: { members: { include: { user: { select: { id: true, realName: true, username: true } } } } },
      }),
      this.prisma.project.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const p = await this.prisma.project.findUnique({
      where: { id },
      include: { members: { include: { user: { select: { id: true, realName: true, username: true, phone: true, deptId: true } } } } },
    });
    if (!p) throw new NotFoundException('项目不存在');
    return p;
  }

  async create(data: any) {
    if (!data.code) throw new BadRequestException('项目编码不能为空');
    const exist = await this.prisma.project.findUnique({ where: { code: data.code } });
    if (exist) throw new BadRequestException('项目编码已存在');
    await this.dict.validate('project_status', data.status);
    return this.prisma.project.create({ data: pickFields(data, PROJECT_FIELDS, { label: '项目' }) });
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    if (data.status) await this.dict.validate('project_status', data.status);
    return this.prisma.project.update({ where: { id }, data: pickFields(data, PROJECT_FIELDS, { label: '项目' }) });
  }

  async remove(id: string) {
    const counts = await Promise.all([
      this.prisma.contract.count({ where: { projectId: id } }),
      this.prisma.dailyReport.count({ where: { projectId: id } }),
      this.prisma.settlement.count({ where: { projectId: id } }),
      this.prisma.invoice.count({ where: { projectId: id } }),
    ]);
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > 0) throw new BadRequestException(`该项目下存在 ${total} 条业务数据，不可删除，建议归档`);
    await this.prisma.projectMember.deleteMany({ where: { projectId: id } });
    return this.prisma.project.delete({ where: { id } });
  }

  async members(projectId: string) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, realName: true, username: true, phone: true, email: true, deptId: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async addMember(projectId: string, userId: string, roleCode: string) {
    await this.dict.validate('project_member_role', roleCode, true);
    const exist = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
    if (exist) return this.prisma.projectMember.update({ where: { id: exist.id }, data: { roleCode } });
    return this.prisma.projectMember.create({ data: { projectId, userId, roleCode } });
  }

  async removeMember(projectId: string, userId: string) {
    await this.prisma.projectMember.deleteMany({ where: { projectId, userId } });
    return true;
  }
}

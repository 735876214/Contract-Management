import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult } from '../../common/utils/helpers';

@Injectable()
export class ApprovalService {
  constructor(private prisma: PrismaClient) {}

  private instanceInclude = {
    flow: true,
    records: { orderBy: { createdAt: 'asc' as const } },
  };

  /** 待我审批：审批节点中包含我，且状态为审批中 */
  async todo(query: any = {}, user: any) {
    const { skip, take } = paginate(query);
    const flows = await this.prisma.approvalFlow.findMany({ include: { nodes: true } });
    const myNodeMap = new Map<string, Set<number>>();
    flows.forEach((f: any) => {
      f.nodes.forEach((n: any) => {
        if ((n.approverIds || '').split(',').includes(user.userId)) {
          if (!myNodeMap.has(f.id)) myNodeMap.set(f.id, new Set());
          myNodeMap.get(f.id)!.add(n.orderNo);
        }
      });
    });
    const flowIds = Array.from(myNodeMap.keys());
    const where: any = { status: 'PENDING' };
    if (!user.isSuperAdmin) where.flowId = { in: flowIds.length ? flowIds : ['__none__'] };
    if (query.bizType) where.bizType = query.bizType;
    if (query.projectId) where.projectId = query.projectId;
    const [list, total] = await Promise.all([
      this.prisma.approvalInstance.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: this.instanceInclude }),
      this.prisma.approvalInstance.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  /** 已审批：我处理过的记录对应的实例 */
  async done(query: any = {}, user: any) {
    const { skip, take } = paginate(query);
    const where: any = { status: { not: 'PENDING' } };
    if (!user.isSuperAdmin) where.records = { some: { approverId: user.userId } };
    if (query.projectId) where.projectId = query.projectId;
    const [list, total] = await Promise.all([
      this.prisma.approvalInstance.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: this.instanceInclude }),
      this.prisma.approvalInstance.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  /** 我发起的 */
  async mine(query: any = {}, user: any) {
    const { skip, take } = paginate(query);
    const where: any = { applicantId: user.userId };
    if (query.projectId) where.projectId = query.projectId;
    if (query.status) where.status = query.status;
    const [list, total] = await Promise.all([
      this.prisma.approvalInstance.findMany({ where, skip, take, orderBy: { createdAt: 'desc' }, include: this.instanceInclude }),
      this.prisma.approvalInstance.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async handle(id: string, action: string, comment: string, user: any) {
    if (!['APPROVED', 'REJECTED', 'TRANSFER'].includes(action)) throw new BadRequestException('审批动作不合法');
    const instance = await this.prisma.approvalInstance.findUnique({ where: { id }, include: { flow: { include: { nodes: true } } } });
    if (!instance) throw new NotFoundException('审批实例不存在');
    if (instance.status !== 'PENDING') throw new BadRequestException('该审批已结束');

    const nodes = ((instance as any).flow?.nodes || []).sort((a: any, b: any) => a.orderNo - b.orderNo);
    const current = nodes.find((n: any) => n.orderNo === instance.currentNode) || nodes[0];

    await this.prisma.approvalRecord.create({
      data: {
        instanceId: id,
        nodeName: current?.nodeName || `第 ${instance.currentNode} 节点`,
        approverId: user.userId,
        approver: user.realName || user.username,
        action,
        comment,
      },
    });

    if (action === 'REJECTED') {
      await this.prisma.approvalInstance.update({ where: { id }, data: { status: 'REJECTED', finishedAt: new Date() } });
      await this.syncBizStatus(instance, 'REJECTED');
      return this.prisma.approvalInstance.findUnique({ where: { id }, include: this.instanceInclude });
    }

    const isLast = !nodes.some((n: any) => n.orderNo > instance.currentNode);
    if (isLast) {
      await this.prisma.approvalInstance.update({ where: { id }, data: { status: 'APPROVED', finishedAt: new Date() } });
      await this.syncBizStatus(instance, 'APPROVED');
    } else {
      await this.prisma.approvalInstance.update({ where: { id }, data: { currentNode: instance.currentNode + 1 } });
    }
    await this.prisma.notification.create({
      data: {
        userId: instance.applicantId,
        title: action === 'APPROVED' ? '审批通过' : action === 'REJECTED' ? '审批驳回' : '审批转办',
        content: `${instance.title} ${action}`,
        type: 'APPROVAL',
        bizType: instance.bizType,
        bizId: instance.bizId,
        projectId: instance.projectId,
      },
    });
    return this.prisma.approvalInstance.findUnique({ where: { id }, include: this.instanceInclude });
  }

  /** 审批结束回写业务单据状态 */
  private async syncBizStatus(instance: any, status: string) {
    if (instance.bizType === 'CONTRACT') {
      await this.prisma.contract.update({ where: { id: instance.bizId }, data: { approvalStatus: status } }).catch(() => undefined);
    }
    if (instance.bizType === 'PAYMENT' || instance.bizType === 'INVOICE') {
      // 付款/开票申请通过流转由各自模块处理，此处仅记录结果
    }
  }

  // ---------------- 流程定义 ----------------
  async flows(query: any = {}) {
    return this.prisma.approvalFlow.findMany({ include: { nodes: { orderBy: { orderNo: 'asc' } } }, orderBy: { createdAt: 'desc' } });
  }

  async createFlow(data: any) {
    const { nodes, ...rest } = data;
    return this.prisma.approvalFlow.create({
      data: {
        ...rest,
        nodes: { create: (nodes || []).map((n: any, i: number) => ({ ...n, orderNo: n.orderNo || i + 1 })) },
      },
      include: { nodes: true },
    });
  }

  async updateFlow(id: string, data: any) {
    const { nodes, ...rest } = data;
    await this.prisma.approvalFlow.update({ where: { id }, data: rest });
    if (Array.isArray(nodes)) {
      await this.prisma.approvalNode.deleteMany({ where: { flowId: id } });
      await this.prisma.approvalNode.createMany({ data: nodes.map((n: any, i: number) => ({ ...n, flowId: id, orderNo: n.orderNo || i + 1 })) });
    }
    return this.prisma.approvalFlow.findUnique({ where: { id }, include: { nodes: true } });
  }

  async removeFlow(id: string) {
    await this.prisma.approvalFlow.delete({ where: { id } });
    return true;
  }
}

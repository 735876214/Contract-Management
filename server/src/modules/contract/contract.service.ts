import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, fmtDate } from '../../common/utils/helpers';
import { DictService } from '../dict/dict.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { ExcelService } from '../../common/services/excel.service';

const FIELD_LABELS: Record<string, string> = {
  code: '合同编号',
  name: '合同名称',
  typeCode: '合同类型',
  supplierId: '供应商',
  signDate: '签订日期',
  amount: '合同额',
  taxRate: '税率',
  paymentMethodCode: '合同约定付款方式',
  isFramework: '是否框架协议',
  isSupplement: '是否补充协议',
  supplementTypeCode: '补充协议类型',
  execStatus: '合同执行情况',
  approvalStatus: '审批状态',
  remark: '备注',
};

@Injectable()
export class ContractService {
  constructor(
    private prisma: PrismaClient,
    private dict: DictService,
    private sysParam: SysParamService,
    private excel: ExcelService,
  ) {}

  async findAll(query: any = {}, projectId: string) {
    const { skip, take } = paginate(query);
    const where: any = { projectId };
    if (query.keyword) where.OR = [{ code: { contains: query.keyword } }, { name: { contains: query.keyword } }];
    if (query.code) where.code = { contains: query.code };
    if (query.name) where.name = { contains: query.name };
    if (query.typeCode) where.typeCode = query.typeCode;
    if (query.supplierId) where.supplierId = query.supplierId;
    if (query.execStatus) where.execStatus = query.execStatus;
    if (query.approvalStatus) where.approvalStatus = query.approvalStatus;
    if (query.startDate || query.endDate) {
      where.signDate = {};
      if (query.startDate) where.signDate.gte = new Date(query.startDate);
      if (query.endDate) where.signDate.lte = new Date(query.endDate);
    }
    const [list, total] = await Promise.all([
      this.prisma.contract.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          supplier: { select: { id: true, name: true, legalPerson: true, contactName: true, contactPhone: true } },
          ext: true,
        },
      }),
      this.prisma.contract.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async options(projectId: string, keyword?: string) {
    const where: any = { projectId };
    if (keyword) where.OR = [{ code: { contains: keyword } }, { name: { contains: keyword } }];
    return this.prisma.contract.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: { id: true, code: true, name: true, supplierId: true, amount: true, taxRate: true, typeCode: true },
    });
  }

  async findOne(id: string) {
    const c = await this.prisma.contract.findUnique({
      where: { id },
      include: { supplier: true, ext: true, attachments: true, project: { select: { id: true, name: true } } },
    });
    if (!c) throw new NotFoundException('合同不存在');
    return c;
  }

  /** 合同编号查重：scope = GLOBAL 全局唯一 / PROJECT 项目内唯一 */
  async checkCode(code: string, projectId: string, excludeId?: string) {
    if (!code) return { exists: false };
    const scope = await this.sysParam.get('contract.code.unique.scope', 'GLOBAL');
    const where: any = scope === 'GLOBAL' ? { code } : { projectId, code };
    if (excludeId) where.id = { not: excludeId };
    const exist = await this.prisma.contract.findFirst({ where });
    return { exists: !!exist, scope };
  }

  private async assertCodeUnique(code: string, projectId: string, excludeId?: string) {
    const { exists, scope } = await this.checkCode(code, projectId, excludeId);
    if (exists) {
      throw new BadRequestException(scope === 'GLOBAL' ? '合同编号已存在（系统内全局唯一）' : '合同编号在当前项目中已存在');
    }
  }

  private async validateDict(data: any) {
    await this.dict.validate('contract_type', data.typeCode);
    await this.dict.validate('yes_no', data.isFramework);
    await this.dict.validate('yes_no', data.isSupplement);
    await this.dict.validate('payment_method', data.paymentMethodCode);
    await this.dict.validate('contract_execution_status', data.execStatus);
    if (data.isSupplement === 'Y') {
      await this.dict.validate('supplement_agreement_type', data.supplementTypeCode, true);
    }
    if (data.approvalStatus) await this.dict.validate('approval_status', data.approvalStatus);
  }

  async create(data: any, projectId: string, user: any) {
    if (!data.code) throw new BadRequestException('合同编号不能为空');
    await this.assertCodeUnique(data.code, projectId);
    await this.validateDict(data);
    const { attachments, ext, ...rest } = data;
    const contract = await this.prisma.contract.create({
      data: {
        ...rest,
        projectId,
        signDate: data.signDate ? new Date(data.signDate) : null,
        amount: num(data.amount),
        taxRate: num(data.taxRate),
        createdBy: user?.userId,
      },
    });
    if (ext) await this.saveExt(contract.id, ext);
    if (Array.isArray(attachments)) {
      await this.prisma.contractAttachment.createMany({
        data: attachments.map((a: any) => ({ contractId: contract.id, fileName: a.fileName, url: a.url, size: a.size })),
      });
    }
    return this.findOne(contract.id);
  }

  async update(id: string, data: any, user: any) {
    const before = await this.findOne(id);
    if (data.code && data.code !== before.code) await this.assertCodeUnique(data.code, before.projectId, id);
    await this.validateDict({ ...before, ...data });
    const { attachments, ext, ...rest } = data;
    const contract = await this.prisma.contract.update({
      where: { id },
      data: {
        ...rest,
        signDate: data.signDate ? new Date(data.signDate) : null,
        amount: num(data.amount),
        taxRate: num(data.taxRate),
      },
    });
    if (ext) await this.saveExt(id, ext);
    if (Array.isArray(attachments)) {
      await this.prisma.contractAttachment.deleteMany({ where: { contractId: id } });
      if (attachments.length) {
        await this.prisma.contractAttachment.createMany({
          data: attachments.map((a: any) => ({ contractId: id, fileName: a.fileName, url: a.url, size: a.size })),
        });
      }
    }
    await this.logChanges(before, { ...before, ...rest }, user);
    return this.findOne(contract.id);
  }

  private async logChanges(before: any, after: any, user: any) {
    const diffs: any[] = [];
    for (const field of Object.keys(FIELD_LABELS)) {
      let b = before[field];
      let a = after[field];
      if (field === 'signDate') {
        b = fmtDate(b);
        a = fmtDate(a);
      }
      if (b instanceof Date) b = fmtDate(b);
      if (a instanceof Date) a = fmtDate(a);
      if (String(b ?? '') !== String(a ?? '')) {
        diffs.push({
          contractId: before.id,
          field,
          fieldLabel: FIELD_LABELS[field],
          beforeValue: String(b ?? ''),
          afterValue: String(a ?? ''),
          operatorId: user?.userId,
          operator: user?.realName || user?.username,
        });
      }
    }
    if (diffs.length) await this.prisma.contractChangeLog.createMany({ data: diffs });
  }

  async changes(id: string) {
    return this.prisma.contractChangeLog.findMany({ where: { contractId: id }, orderBy: { createdAt: 'desc' } });
  }

  async remove(id: string) {
    const c = await this.findOne(id);
    if (c.approvalStatus !== 'DRAFT') throw new BadRequestException('仅草稿状态的合同可删除');
    await this.prisma.contract.delete({ where: { id } });
    return true;
  }

  async submit(id: string, user: any) {
    const c = await this.findOne(id);
    if (c.approvalStatus === 'PENDING') throw new BadRequestException('合同已在审批中');
    await this.dict.validate('approval_status', 'PENDING');
    await this.prisma.contract.update({ where: { id }, data: { approvalStatus: 'PENDING' } });
    const flow = await this.prisma.approvalFlow.findFirst({ where: { bizType: 'CONTRACT', status: 1 } });
    const instance = await this.prisma.approvalInstance.create({
      data: {
        flowId: flow?.id,
        bizType: 'CONTRACT',
        bizId: id,
        projectId: c.projectId,
        title: `合同审批：${c.name}（${c.code}）`,
        applicantId: user?.userId,
        applicant: user?.realName || user?.username,
        status: 'PENDING',
        currentNode: 1,
      },
    });
    await this.prisma.approvalRecord.create({
      data: { instanceId: instance.id, nodeName: '提交', approverId: user?.userId, approver: user?.realName, action: 'SUBMIT' },
    });
    // 通知项目管理员
    if (flow) {
      const nodes = await this.prisma.approvalNode.findMany({ where: { flowId: flow.id }, orderBy: { orderNo: 'asc' } });
      const approverIds = (nodes[0]?.approverIds || '').split(',').filter(Boolean);
      for (const uid of approverIds) {
        await this.prisma.notification.create({
          data: {
            userId: uid,
            title: '合同待审批',
            content: `${c.code} ${c.name} 提交审批`,
            type: 'APPROVAL',
            bizType: 'CONTRACT',
            bizId: id,
            projectId: c.projectId,
          },
        });
      }
    }
    return this.findOne(id);
  }

  async approve(id: string, action: string, comment: string, user: any) {
    if (!['APPROVED', 'REJECTED'].includes(action)) throw new BadRequestException('审批动作不合法');
    await this.dict.validate('approval_status', action === 'APPROVED' ? 'APPROVED' : 'REJECTED');
    const c = await this.findOne(id);
    if (c.approvalStatus !== 'PENDING') throw new BadRequestException('合同不在审批中');
    await this.prisma.contract.update({ where: { id }, data: { approvalStatus: action } });
    const instance = await this.prisma.approvalInstance.findFirst({ where: { bizType: 'CONTRACT', bizId: id }, orderBy: { createdAt: 'desc' } });
    if (instance) {
      await this.prisma.approvalInstance.update({
        where: { id: instance.id },
        data: { status: action, finishedAt: new Date() },
      });
      await this.prisma.approvalRecord.create({
        data: { instanceId: instance.id, nodeName: `第 ${instance.currentNode} 节点`, approverId: user?.userId, approver: user?.realName, action, comment },
      });
      await this.prisma.notification.create({
        data: {
          userId: instance.applicantId,
          title: action === 'APPROVED' ? '合同审批通过' : '合同审批驳回',
          content: `${c.code} ${c.name} ${action === 'APPROVED' ? '已通过' : '被驳回'}：${comment || ''}`,
          type: 'APPROVAL',
          bizType: 'CONTRACT',
          bizId: id,
          projectId: c.projectId,
        },
      });
    }
    return this.findOne(id);
  }

  async saveExt(contractId: string, data: any) {
    await this.dict.validate('procurement_source', data.procurementSrc);
    await this.dict.validate('is_direct_purchase', data.isDirectPurchase);
    await this.dict.validate('supplier_category', data.supplierCategory);
    const payload: any = {
      financeCode: data.financeCode,
      procurementSrc: data.procurementSrc,
      isDirectPurchase: data.isDirectPurchase,
      bidName: data.bidName,
      currentPayRatio: num(data.currentPayRatio),
      supplierCategory: data.supplierCategory,
      bidStartDate: data.bidStartDate ? new Date(data.bidStartDate) : null,
      bidWinDate: data.bidWinDate ? new Date(data.bidWinDate) : null,
      disclosureDate: data.disclosureDate ? new Date(data.disclosureDate) : null,
      complaint: data.complaint,
    };
    const exist = await this.prisma.contractExt.findUnique({ where: { contractId } });
    if (exist) return this.prisma.contractExt.update({ where: { contractId }, data: payload });
    return this.prisma.contractExt.create({ data: { contractId, ...payload } });
  }

  async getExt(contractId: string) {
    return this.prisma.contractExt.findUnique({ where: { contractId } });
  }

  // ---------------- Excel ----------------
  async export(projectId: string) {
    const res = await this.findAll({ pageSize: 1000 }, projectId);
    const typeMap = await this.dict.nameMap('contract_type');
    const execMap = await this.dict.nameMap('contract_execution_status');
    const columns = [
      { header: '合同编号', key: 'code', width: 20 },
      { header: '合同名称', key: 'name', width: 34 },
      { header: '合同类型', key: 'typeName', width: 16 },
      { header: '供应商', key: 'supplierName', width: 30 },
      { header: '签订日期', key: 'signDate', width: 14 },
      { header: '合同额', key: 'amount', width: 16 },
      { header: '税率', key: 'taxRate', width: 10 },
      { header: '执行情况', key: 'execName', width: 14 },
      { header: '审批状态', key: 'approvalStatus', width: 12 },
      { header: '备注', key: 'remark', width: 26 },
    ];
    const rows = (res.list as any[]).map((c) => ({
      code: c.code,
      name: c.name,
      typeName: typeMap[c.typeCode]?.name || c.typeCode,
      supplierName: c.supplier?.name,
      signDate: fmtDate(c.signDate),
      amount: num(c.amount),
      taxRate: num(c.taxRate),
      execName: execMap[c.execStatus]?.name || c.execStatus,
      approvalStatus: c.approvalStatus,
      remark: c.remark,
    }));
    return this.excel.export(columns, rows, '合同列表');
  }

  async import(buffer: Buffer, projectId: string, user: any) {
    const rows = await this.excel.parse(buffer);
    // 导入时支持填写字典项编码或名称，自动解析为编码
    const resolve = async (type: string, val: any) => {
      if (!val) return null;
      const items = await this.dict.options(type);
      const hit = items.find((i: any) => i.itemCode === val || i.itemName === val);
      return hit ? hit.itemCode : null;
    };
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      const code = String(r['合同编号'] ?? '').trim();
      if (!code) {
        errors.push(`第 ${index + 2} 行：合同编号为空`);
        continue;
      }
      const { exists } = await this.checkCode(code, projectId);
      if (exists) {
        errors.push(`第 ${index + 2} 行：合同编号 ${code} 已存在`);
        continue;
      }
      const supplierName = String(r['供应商'] ?? '').trim();
      const supplier = supplierName ? await this.prisma.supplier.findFirst({ where: { name: supplierName } }) : null;
      try {
        await this.create(
          {
            code,
            name: r['合同名称'] || code,
            typeCode: await resolve('contract_type', r['合同类型']),
            supplierId: supplier?.id,
            signDate: r['签订日期'] || null,
            amount: num(r['合同额']),
            taxRate: num(r['税率']),
            remark: r['备注'] || null,
          },
          projectId,
          user,
        );
        created++;
      } catch (e: any) {
        errors.push(`第 ${index + 2} 行：${e.message}`);
      }
    }
    return { created, errors };
  }
}

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, fmtDate } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { ExcelService } from '../../common/services/excel.service';

const CONTRACT_FIELDS = [
  'projectId', 'code', 'name', 'typeCode', 'subTypeCode', 'codeAbbrUsed', 'yearSeq',
  'parentContractId', 'supplementSeq', 'supplierId', 'signDate', 'amount', 'taxRate',
  'paymentMethodCode', 'isFramework', 'isSupplement', 'supplementTypeCode', 'execStatus',
  'remark', 'createdBy',
];
const EXT_FIELDS = [
  'financeCode', 'procurementSrc', 'isDirectPurchase', 'bidName', 'currentPayRatio',
  'supplierCategory', 'bidStartDate', 'bidWinDate', 'disclosureDate', 'complaint',
];

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
      include: {
        supplier: true,
        ext: true,
        attachments: true,
        project: { select: { id: true, name: true, codeAbbr: true, industryType: true } },
        parentContract: { select: { id: true, code: true, name: true } },
        supplements: { select: { id: true, code: true, name: true }, orderBy: { supplementSeq: 'asc' } },
      },
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

  // ==================== 合同编号自动生成 ====================

  /** 读取编号规则系统参数 */
  private async codeConfig() {
    const [prefix, typeMapping, subTypeMapping, seqDigits, yearReset] = await Promise.all([
      this.sysParam.get('contract.code.fixed_prefix', 'CSCEC'),
      this.sysParam.get('contract.code.type_mapping', '{}'),
      this.sysParam.get('contract.code.sub_type_mapping', '{}'),
      this.sysParam.get('contract.code.seq_digits', '3'),
      this.sysParam.get('contract.code.year_reset', 'true'),
    ]);
    const parseJson = (s: string) => {
      try { return JSON.parse(s) || {}; } catch { return {}; }
    };
    return {
      prefix: prefix || 'CSCEC',
      typeMap: parseJson(typeMapping) as Record<string, string>,
      subTypeMap: parseJson(subTypeMapping) as Record<string, string>,
      seqDigits: Math.max(1, Number(seqDigits) || 3),
      yearReset: String(yearReset) !== 'false',
    };
  }

  /**
   * 生成标准合同编号：前缀-类型码-项目字母简称-子类型码-年份顺序码
   * 各段可缺失时在 missing 中提示，不阻断（允许用户手动补齐编号）
   */
  async nextCode(params: { typeCode?: string; subTypeCode?: string; projectId?: string; codeAbbr?: string }) {
    const cfg = await this.codeConfig();
    const missing: string[] = [];

    // 第1段：固定前缀
    const seg1 = cfg.prefix;

    // 第2段：合同类型 → 按字典项名称匹配映射
    let seg2 = '';
    if (params.typeCode) {
      const typeNames = await this.dict.nameMap('contract_type');
      const typeName = typeNames[params.typeCode]?.name || params.typeCode;
      seg2 = cfg.typeMap[typeName] || '';
    }
    if (!seg2) missing.push('合同类型码（检查类型选择或参数 contract.code.type_mapping）');

    // 第3段：项目字母简称（关联项目优先带出，否则用手填值）
    let seg3 = (params.codeAbbr || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (params.projectId) {
      const proj = await this.prisma.project.findUnique({ where: { id: params.projectId } });
      if (proj?.codeAbbr) seg3 = proj.codeAbbr;
    }
    if (!seg3) missing.push('项目字母简称（关联项目或手动输入）');

    // 第4段：合同子类型 → 按字典项名称匹配映射
    let seg4 = '';
    if (params.subTypeCode) {
      const subNames = await this.dict.nameMap('contract_sub_type');
      const subName = subNames[params.subTypeCode]?.name || params.subTypeCode;
      seg4 = cfg.subTypeMap[subName] || '';
    }
    if (!seg4) missing.push('合同子类型码（检查子类型选择或参数 contract.code.sub_type_mapping）');

    // 第5段：年份 + 顺序码（取已用最大顺序码 +1）
    const year = new Date().getFullYear();
    const yearPrefix = String(year);
    const sameYear = await this.prisma.contract.findMany({
      where: cfg.yearReset ? { yearSeq: { startsWith: yearPrefix } } : { yearSeq: { not: null } },
      select: { yearSeq: true },
    });
    let maxSeq = 0;
    for (const c of sameYear) {
      const digits = cfg.yearReset ? (c.yearSeq || '').slice(yearPrefix.length) : (c.yearSeq || '');
      const n = parseInt(digits, 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    }
    const seq = String(maxSeq + 1).padStart(cfg.seqDigits, '0');
    const yearSeq = `${yearPrefix}${seq}`;

    const segments = [seg1, seg2, seg3, seg4, yearSeq].filter(Boolean);
    const code = segments.join('-');
    return {
      code,
      segments: { prefix: seg1, typeSeg: seg2, abbr: seg3, subTypeSeg: seg4, yearSeq },
      missing,
      nextSeq: maxSeq + 1,
    };
  }

  /** 补充协议编号：原合同编号（N+1），N 为该合同已有补充协议数 */
  async nextSupplementCode(parentId: string) {
    const parent = await this.findOne(parentId);
    if (parent.isSupplement === 'Y') throw new BadRequestException('补充协议不能再派生补充协议，请选择主合同');
    const count = await this.prisma.contract.count({ where: { parentContractId: parentId } });
    return {
      code: `${parent.code}（${count + 1}）`,
      seq: count + 1,
      parentCode: parent.code,
      parentName: parent.name,
    };
  }

  /** 从合同编号尾部提取年份顺序码（如 ...-2026002 → 2026002），用于固化 yearSeq */
  private extractYearSeq(code: string): string | null {
    const m = code.match(/(\d{4})(\d{2,})\s*$/);
    return m ? `${m[1]}${m[2]}` : null;
  }

  private async validateDict(data: any) {
    await this.dict.validate('contract_type', data.typeCode);
    await this.dict.validate('contract_sub_type', data.subTypeCode);
    await this.dict.validate('yes_no', data.isFramework);
    await this.dict.validate('yes_no', data.isSupplement);
    await this.dict.validate('payment_method', data.paymentMethodCode);
    await this.dict.validate('contract_execution_status', data.execStatus);
    if (data.isSupplement === 'Y') {
      await this.dict.validate('supplement_agreement_type', data.supplementTypeCode, true);
    }
  }

  async create(data: any, projectId: string, user: any) {
    if (!data.code) throw new BadRequestException('合同编号不能为空');
    await this.assertCodeUnique(data.code, projectId);
    await this.validateDict(data);

    // 编号段落固化：yearSeq / codeAbbrUsed 未传时自动补齐
    if (!data.yearSeq) data.yearSeq = this.extractYearSeq(data.code);
    if (!data.codeAbbrUsed) {
      const proj = await this.prisma.project.findUnique({ where: { id: projectId } });
      data.codeAbbrUsed = proj?.codeAbbr || null;
    }

    // 补充协议：未传编号/顺序码时按「原合同编号（N+1）」自动生成
    if (data.isSupplement === 'Y' && data.parentContractId) {
      const parent = await this.prisma.contract.findUnique({ where: { id: data.parentContractId } });
      if (!parent) throw new BadRequestException('父合同不存在');
      if (parent.isSupplement === 'Y') throw new BadRequestException('补充协议不能再派生补充协议，请选择主合同');
      if (parent.projectId !== projectId) throw new BadRequestException('父合同与当前项目不一致');
      if (!data.supplementSeq) {
        const count = await this.prisma.contract.count({ where: { parentContractId: data.parentContractId } });
        data.supplementSeq = count + 1;
      }
      if (!data.code) data.code = `${parent.code}（${data.supplementSeq}）`;
      if (!data.yearSeq) data.yearSeq = parent.yearSeq;
      await this.assertCodeUnique(data.code, projectId);
    }

    const { attachments, ext, ...rest } = data;
    const contract = await this.prisma.contract.create({
      data: {
        ...pickFields(rest, CONTRACT_FIELDS, { label: '合同' }),
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
    // 合同编号正式生成后不可变更（历史数据固化）
    if (data.code && data.code !== before.code) {
      throw new BadRequestException('合同编号生成后不可变更');
    }
    delete data.code;
    await this.validateDict({ ...before, ...data });
    const { attachments, ext, ...rest } = data;
    const contract = await this.prisma.contract.update({
      where: { id },
      data: {
        ...pickFields(rest, CONTRACT_FIELDS, { label: '合同' }),
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
    await this.findOne(id);
    await this.prisma.contract.delete({ where: { id } });
    return true;
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

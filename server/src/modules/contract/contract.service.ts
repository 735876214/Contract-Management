import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, num, fmtDate, assertVersion } from '../../common/utils/helpers';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';
import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';
import { ImportTaskService } from '../../common/services/import-task.service';
import { SysParamService } from '../../common/services/sys-param.service';
import { ExcelService } from '../../common/services/excel.service';
import { ImportTemplateService, TemplateColumn } from '../../common/services/import-template.service';
import { MaterialService } from '../material/material.service';

const CONTRACT_FIELDS = [
  'projectId', 'code', 'name', 'typeCode', 'subTypeCode', 'codeAbbrUsed', 'yearSeq',
  'parentContractId', 'supplementSeq', 'supplierId', 'signDate', 'amount', 'taxRate',
  'paymentMethodCode', 'isFramework', 'isSupplement', 'supplementTypeCode', 'execStatus',
  'technicalClauseId', 'qualityClauseId', 'paymentClauseId', 'acceptanceClauseId',
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
    private tpl: ImportTemplateService,
    private material: MaterialService,
    private runner: ImportRunnerService,
    private tasks: ImportTaskService,
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
    // 需求 2.3：附带四种条款内容，供合同详情/编辑回显
    const clauseIds = [c.technicalClauseId, c.qualityClauseId, c.paymentClauseId, c.acceptanceClauseId];
    const ids = clauseIds.filter(Boolean) as string[];
    const clauseList = ids.length
      ? await this.prisma.clause.findMany({ where: { id: { in: ids } } })
      : [];
    const clauseMap = new Map(clauseList.map((x: any) => [x.id, x]));
    const pick = (cid: string | null) => (cid ? clauseMap.get(cid) || null : null);
    return {
      ...c,
      clauses: {
        technical: pick(c.technicalClauseId),
        quality: pick(c.qualityClauseId),
        payment: pick(c.paymentClauseId),
        acceptance: pick(c.acceptanceClauseId),
      },
    };
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

  async create(data: any, projectId: string, user: any, tx?: TxClient) {
    const db: any = tx || this.prisma;
    if (!data.code) throw new BadRequestException('合同编号不能为空');
    await this.assertCodeUnique(data.code, projectId);
    await this.validateDict(data);

    // 编号段落固化：yearSeq / codeAbbrUsed 未传时自动补齐
    if (!data.yearSeq) data.yearSeq = this.extractYearSeq(data.code);
    if (!data.codeAbbrUsed) {
      const proj = await db.project.findUnique({ where: { id: projectId } });
      data.codeAbbrUsed = proj?.codeAbbr || null;
    }

    // 补充协议：未传编号/顺序码时按「原合同编号（N+1）」自动生成
    if (data.isSupplement === 'Y' && data.parentContractId) {
      const parent = await db.contract.findUnique({ where: { id: data.parentContractId } });
      if (!parent) throw new BadRequestException('父合同不存在');
      if (parent.isSupplement === 'Y') throw new BadRequestException('补充协议不能再派生补充协议，请选择主合同');
      if (parent.projectId !== projectId) throw new BadRequestException('父合同与当前项目不一致');
      if (!data.supplementSeq) {
        const count = await db.contract.count({ where: { parentContractId: data.parentContractId } });
        data.supplementSeq = count + 1;
      }
      if (!data.code) data.code = `${parent.code}（${data.supplementSeq}）`;
      if (!data.yearSeq) data.yearSeq = parent.yearSeq;
      await this.assertCodeUnique(data.code, projectId);
    }

    const { attachments, ext, ...rest } = data;
    const contract = await db.contract.create({
      data: {
        ...pickFields(rest, CONTRACT_FIELDS, { label: '合同' }),
        projectId,
        signDate: data.signDate ? new Date(data.signDate) : null,
        amount: num(data.amount),
        taxRate: num(data.taxRate),
        createdBy: user?.userId,
      },
    });
    if (ext) await this.saveExt(contract.id, ext, tx);
    if (Array.isArray(attachments)) {
      await db.contractAttachment.createMany({
        data: attachments.map((a: any) => ({ contractId: contract.id, fileName: a.fileName, url: a.url, size: a.size })),
      });
    }
    // 需求 2.1/2.3：创建合同时可从物资基础库（项目物资清单数据源）选择物资，
    // 派生生成合同物资清单（唯一数据源），序号从 1 开始
    const materialIds = Array.isArray(data.materialIds) ? data.materialIds : [];
    if (materialIds.length) {
      if (!tx) await this.material.derive(contract.id, materialIds); // 导入事务中不派生，避免跨连接锁等待
    }
    return this.findOne(contract.id);
  }

  async update(id: string, data: any, user: any) {
    const before = await this.findOne(id);
    assertVersion(before, data); // 乐观锁：版本号不一致说明已被他人修改
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
        version: { increment: 1 },
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

  // ==================== 合同起草（需求 2.1） ====================

  /** 草稿判定：执行情况为 DRAFT 或尚未填写，且为当前用户创建（projectId 缺省时不限项目） */
  private draftWhere(userId: string, projectId?: string) {
    const where: any = {
      createdBy: userId,
      OR: [{ execStatus: 'DRAFT' }, { execStatus: null }],
    };
    if (projectId) where.projectId = projectId;
    return where;
  }

  /** 当前用户的草稿列表（数据隔离：仅本人创建） */
  async findDrafts(userId: string, projectId?: string) {
    return this.prisma.contract.findMany({
      where: this.draftWhere(userId, projectId),
      orderBy: { updatedAt: 'desc' },
      include: { supplier: { select: { id: true, name: true } } },
    });
  }

  /** 删除草稿：仅本人创建且未提交的合同可删（物理删除，草稿无关联业务数据） */
  async removeDraft(id: string, userId: string) {
    const c = await this.prisma.contract.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('草稿不存在');
    if (c.createdBy !== userId) throw new BadRequestException('只能删除本人创建的草稿');
    if (c.execStatus && c.execStatus !== 'DRAFT') throw new BadRequestException('该合同已提交，不能作为草稿删除');
    await this.prisma.contract.delete({ where: { id } });
    return true;
  }

  async saveExt(contractId: string, data: any, tx?: TxClient) {
    const db: any = tx || this.prisma;
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
    const exist = await db.contractExt.findUnique({ where: { contractId } });
    if (exist) return db.contractExt.update({ where: { contractId }, data: payload });
    return db.contractExt.create({ data: { contractId, ...payload } });
  }

  async getExt(contractId: string) {
    return this.prisma.contractExt.findUnique({ where: { contractId } });
  }

  // ---------------- Excel ----------------
  /**
   * 批量导入（需求 2.1）：全成功或全失败
   * 先全量校验（必填 + 合同编号唯一 + 供应商关联），任一失败不写库；全部通过后在事务内写入
   */
  async import(buffer: Buffer, projectId: string, user: any, fileName?: string) {
    const rows = await this.excel.parse(buffer, [2]);
    const resolve = async (type: string, val: any) => {
      if (!val) return null;
      const items = await this.dict.options(type);
      const hit = items.find((i: any) => i.itemCode === val || i.itemName === val);
      return hit ? hit.itemCode : null;
    };
    const notDup = this.runner.batchDup();
    return this.tasks.submit<any>({ module: 'contract', moduleName: '合同台账', projectId, fileName, userId: user?.userId, username: user?.username }, rows, {
      plan: async (r) => {
        const code = String(r['合同编号'] ?? '').trim();
        if (!code) throw new RowError('合同编号为必填项', '合同编号');
        notDup(code, `批内重复：合同编号 ${code} 在导入文件中出现多次`, '合同编号');
        const { exists } = await this.checkCode(code, projectId);
        if (exists) throw new RowError(`唯一性校验失败：合同编号 ${code} 已存在`, '合同编号');
        const supplierName = String(r['供应商'] ?? '').trim();
        if (!supplierName) throw new RowError('供应商为必填项', '供应商');
        const supplier = await this.prisma.supplier.findFirst({ where: { name: supplierName } });
        if (!supplier) throw new RowError(`关联校验失败：供应商库中不存在「${supplierName}」`, '供应商');
        const amount = num(r['合同额']);
        if (amount === null) throw new RowError('合同额为必填数字', '合同额');
        const taxRaw = num(r['税率(%)']) ?? num(r['税率']);
        return {
          code,
          name: r['合同名称'] || code,
          typeCode: await resolve('contract_type', r['合同类型']),
          supplierId: supplier.id,
          signDate: r['签订日期'] || null,
          amount,
          taxRate: taxRaw !== null ? (taxRaw > 1 ? taxRaw / 100 : taxRaw) : null,
          remark: r['备注'] || null,
        };
      },
      write: async (plans, tx: TxClient) => {
        for (const p of plans) await this.create(p, projectId, user, tx);
        return { created: plans.length };
      },
    });
  }

  /** 合同台账填写模板（需求 3.3，实际字段口径） */
  async template(projectId: string) {
    const types = await this.dict.options('contract_type');
    const columns: TemplateColumn[] = [
      { label: '合同编号', key: 'code', required: true, width: 20, example: 'HT-2026-0001', desc: '项目内唯一，按编号规则填写' },
      { label: '合同名称', key: 'name', required: true, width: 28, example: '螺纹钢采购合同' },
      { label: '合同类型', key: 'typeCode', type: 'select', width: 16, example: '采购合同', options: types.map((i: any) => i.itemName).filter(Boolean) },
      { label: '供应商', key: 'supplier', required: true, width: 26, example: '某某钢铁贸易有限公司', desc: '须为供应商库中已存在的供应商名称' },
      { label: '签订日期', key: 'signDate', type: 'date', width: 14, example: '2026-08-20' },
      { label: '合同额', key: 'amount', required: true, type: 'money', width: 16, example: 6900000 },
      { label: '税率(%)', key: 'taxRatePct', type: 'number', width: 10, example: 13, desc: '百分比数字，常见值 13、9、6、3、1' },
      { label: '备注', key: 'remark', type: 'text', width: 20, example: '示例行：导入时自动忽略' },
    ];
    return this.tpl.buildTemplate({ moduleName: '合同台账', sheetName: '数据', columns });
  }
}

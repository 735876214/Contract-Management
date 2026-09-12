import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { paginate, buildResult, fmtDate, num } from '../../common/utils/helpers';
import { amountToChineseCapital } from '../../common/utils/money';
import { pickFields } from '../../common/pick-fields';
import { DictService } from '../dict/dict.service';

const TPL_FIELDS = ['name', 'categoryCode', 'tags', 'status', 'content', 'pageSetup', 'projectId', 'parentId', 'createdBy'];
const CLAUSE_FIELDS = ['title', 'content', 'categoryCode', 'type', 'sortOrder', 'status', 'createdBy'];

/** 需求 2.3：合同条款固定四种类型 */
export const CLAUSE_TYPES = [
  { value: 'technical', label: '技术条款' },
  { value: 'quality', label: '质量条款' },
  { value: 'payment', label: '付款条件' },
  { value: 'acceptance', label: '验收方式' },
];

@Injectable()
export class TemplateService {
  constructor(private prisma: PrismaClient, private dict: DictService) {}

  async findAll(query: any = {}, projectId?: string) {
    const { skip, take } = paginate(query);
    const where: any = {};
    const and: any[] = [];
    if (query.keyword) and.push({ OR: [{ name: { contains: query.keyword } }, { tags: { contains: query.keyword } }] });
    if (query.categoryCode) and.push({ categoryCode: query.categoryCode });
    if (projectId) and.push({ OR: [{ projectId: null }, { projectId }] });
    const includeHistory = query.includeHistory === 'true' || query.includeHistory === true;
    if (!includeHistory) {
      and.push({ status: query.status !== undefined && query.status !== '' ? Number(query.status) : 1 });
    }
    if (and.length) where.AND = and;
    const [list, total] = await Promise.all([
      this.prisma.contractTemplate.findMany({ where, skip, take, orderBy: [{ version: 'desc' }, { createdAt: 'desc' }], include: { variables: true } }),
      this.prisma.contractTemplate.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const t = await this.prisma.contractTemplate.findUnique({ where: { id }, include: { variables: true } });
    if (!t) throw new NotFoundException('模板不存在');
    return t;
  }

  async create(data: any, user: any) {
    await this.dict.validate('contract_template_category', data.categoryCode);
    const { variables, ...rest } = data;
    const payload = pickFields(rest, TPL_FIELDS, { label: '合同模板' });
    return this.prisma.contractTemplate.create({
      data: {
        ...payload,
        version: 1,
        parentId: null,
        createdBy: user?.userId,
        variables: variables?.length ? { create: variables } : undefined,
      },
      include: { variables: true },
    });
  }

  /** 修改后生成新版本：旧版本停用，新版本启用 */
  async update(id: string, data: any, user: any) {
    const old = await this.findOne(id);
    await this.dict.validate('contract_template_category', data.categoryCode);
    const rootId = old.parentId || old.id;
    const max = await this.prisma.contractTemplate.aggregate({
      where: { OR: [{ id: rootId }, { parentId: rootId }] },
      _max: { version: true },
    });
    const { variables, ...rest } = data;
    const payload = pickFields(rest, TPL_FIELDS, { label: '合同模板' });
    const created = await this.prisma.contractTemplate.create({
      data: {
        ...payload,
        name: data.name || old.name,
        categoryCode: data.categoryCode || old.categoryCode,
        version: (max._max.version || 1) + 1,
        parentId: rootId,
        status: 1,
        createdBy: user?.userId,
        variables: variables?.length
          ? { create: variables.map((v: any) => ({ varKey: v.varKey, varLabel: v.varLabel, sourceType: v.sourceType, defaultValue: v.defaultValue })) }
          : undefined,
      },
      include: { variables: true },
    });
    await this.prisma.contractTemplate.update({ where: { id: old.id }, data: { status: 0 } });
    return created;
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.contractTemplate.delete({ where: { id } });
    return true;
  }

  async toggle(id: string) {
    const t = await this.findOne(id);
    return this.prisma.contractTemplate.update({ where: { id }, data: { status: t.status === 1 ? 0 : 1 } });
  }

  async versions(id: string) {
    const t = await this.findOne(id);
    const rootId = t.parentId || t.id;
    return this.prisma.contractTemplate.findMany({
      where: { OR: [{ id: rootId }, { parentId: rootId }] },
      orderBy: { version: 'desc' },
    });
  }

  /** 回滚：以目标版本内容生成新版本 */
  async rollback(id: string, targetId: string, user: any) {
    const target = await this.findOne(targetId);
    return this.update(id, {
      name: target.name,
      categoryCode: target.categoryCode,
      tags: target.tags,
      content: target.content,
      variables: target.variables?.map((v: any) => ({ varKey: v.varKey, varLabel: v.varLabel, sourceType: v.sourceType, defaultValue: v.defaultValue })),
    }, user);
  }

  /**
   * 生成合同向导 · 步骤三：根据前两步选择筛选可用模板分类
   * 是否框架协议=是 -> 仅框架协议
   * 是否补充协议=是 -> 各类补充协议
   * 否则 -> 根据合同类型映射
   */
  async guideCategories(params: { isFramework?: string; isSupplement?: string; contractType?: string }) {
    const all = await this.dict.options('contract_template_category');
    if (params.isFramework === 'Y') return all.filter((i: any) => i.itemCode === 'FRAMEWORK');
    if (params.isSupplement === 'Y') {
      return all.filter((i: any) => ['PRICE_UP', 'PRICE_DOWN', 'ITEM_ADD', 'QTY_ADD', 'OTHER_SUPP'].includes(i.itemCode));
    }
    const typeMap: Record<string, string[]> = {
      FRAMEWORK: ['FRAMEWORK'],
      PURCHASE: ['PURCHASE'],
      PURCHASE_EXEC: ['PURCHASE_EXEC'],
      LEASE: ['LEASE'],
      LEASE_EXEC: ['LEASE_EXEC'],
    };
    const codes = typeMap[params.contractType] || [];
    return all.filter((i: any) => codes.includes(i.itemCode));
  }

  /** 构建规范 HTML 表格（含表头），用于占位符表格替换 */
  private buildTableHtml(headers: string[], rows: (string | number | null | undefined)[][]): string {
    const esc = (v: any) =>
      String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const thead = `<tr>${headers.map((h) => `<th style="border:1px solid #000;padding:4px 6px;background:#f2f2f2;">${esc(h)}</th>`).join('')}</tr>`;
    const tbody = rows.length
      ? rows
          .map(
            (r) =>
              `<tr>${r
                .map((c) => `<td style="border:1px solid #000;padding:4px 6px;text-align:center;">${esc(c)}</td>`)
                .join('')}</tr>`,
          )
          .join('')
      : `<tr><td style="border:1px solid #000;padding:4px 6px;text-align:center;" colspan="${headers.length}">暂无数据</td></tr>`;
    return `<table style="border-collapse:collapse;width:100%;">${thead}${tbody}</table>`;
  }

  /** 按合同物资清单派生两张子表 HTML（行号重新从 1 编号）；导出 Word 时兜底使用（需求 2.2） */
  async buildMaterialTables(contractId: string): Promise<{ codeTable: string; itemTable: string; materialTotal: number }> {
    const rows = await this.prisma.contractMaterial.findMany({
      where: { contractId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { materialBase: true },
    });
    const fmt = (v: any) => (v === null || v === undefined || v === '' ? '' : String(v));
    const fmtNum = (v: any) => (v === null || v === undefined ? '' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 4 }));

    // 派生子表1：物料编码清单（来自物资基础库）
    const codeTable = this.buildTableHtml(
      ['序号', '物资名称', '规格型号', 'MDM编码', 'DSC编码'],
      rows.map((r: any, i: number) => [
        i + 1,
        r.materialBase?.name || '',
        r.materialBase?.spec || '',
        fmt(r.materialBase?.mdmCode),
        fmt(r.materialBase?.dscCode),
      ]),
    );

    // 派生子表2：合同清单（排除 MDM/DSC 编码与内部成本字段）
    const itemTable = this.buildTableHtml(
      ['序号', '物资名称', '规格型号', '计量单位', '暂定数量', '税前单价', '增值税(%)', '含税单价', '暂定含税合价', '备注'],
      rows.map((r: any, i: number) => [
        i + 1,
        r.materialBase?.name || '',
        r.materialBase?.spec || '',
        fmt(r.unit),
        fmtNum(r.qty),
        fmtNum(r.priceBeforeTax),
        fmtNum(r.taxRatePct),
        fmtNum(r.priceWithTax),
        fmtNum(r.totalWithTax),
        fmt(r.remark),
      ]),
    );

    // 暂定含税合价合计（用于「合同额大写」）
    const materialTotal = rows.reduce((sum: number, r: any) => sum + (Number(r.totalWithTax) || 0), 0);

    return { codeTable, itemTable, materialTotal };
  }

  /**
   * 生成合同正文：变量替换。
   * 表格占位符：新规范 {{物料编码清单}} / {{合同清单}}（双花括号）；
   * 兼容旧模板 {{MATERIAL_CODE_TABLE}} / {{CONTRACT_ITEM_TABLE}} 与单花括号 {物料编码清单} / {合同清单}。
   */
  async generate(params: { templateId: string; contractId: string; manual?: Record<string, any> }, projectId: string) {
    const template = await this.findOne(params.templateId);
    const contract = await this.prisma.contract.findUnique({
      where: { id: params.contractId },
      include: { supplier: true, project: true },
    });
    if (!contract) throw new NotFoundException('合同不存在');
    if (contract.projectId !== projectId) throw new BadRequestException('合同不属于当前项目');

    const typeMap = await this.dict.nameMap('contract_type');
    const payMap = await this.dict.nameMap('payment_method');
    const sup: any = (contract as any).supplier || {};
    const taxRate = num(contract.taxRate);

    // 模板变量中配置了默认值的，作为兜底值（系统值与手工填写值优先）
    const varDefaults: Record<string, any> = {};
    (template.variables || []).forEach((v: any) => {
      if (v.defaultValue !== null && v.defaultValue !== undefined && v.defaultValue !== '') {
        varDefaults[v.varKey] = v.defaultValue;
      }
    });

    // 表格占位符先生成，并据合同清单「暂定含税合价」合计计算合同额大写
    const tables = await this.buildMaterialTables(params.contractId);
    const materialTotal = (tables as any).materialTotal || 0;
    const capitalBase = materialTotal > 0 ? materialTotal : num(contract.amount) ?? 0;

    const values: Record<string, any> = {
      ...varDefaults,
      合同编号: contract.code,
      合同名称: contract.name,
      合同类型: typeMap[contract.typeCode]?.name || contract.typeCode || '',
      合同子类型: (contract as any).subTypeCode || '',
      合同额: num(contract.amount) ?? 0,
      合同额大写: amountToChineseCapital(capitalBase),
      税率: taxRate !== null ? `${(taxRate * 100).toFixed(2)}%` : '',
      签订日期: fmtDate(contract.signDate) || '',
      合同约定付款方式: payMap[contract.paymentMethodCode]?.name || contract.paymentMethodCode || '',
      项目名称: (contract as any).project?.name || '',
      物资产地: (contract as any).project?.materialOrigin || '',
      供应商名称: sup.name || '',
      公司地址: sup.address || '',
      银行名称: sup.bankName || '',
      银行账号: sup.bankAccount || '',
      法人姓名: sup.legalPerson || '',
      法人电话: sup.legalPhone || '',
      合同授权人姓名: sup.contractAuthPerson || '',
      合同授权人电话: sup.contractAuthPhone || '',
      合同授权人身份证号: sup.contractAuthIdNo || '',
      联系人姓名: sup.contactName || '',
      联系人电话: sup.contactPhone || '',
      联系人邮箱: sup.contactEmail || '',
      甲方名称: (contract as any).partyAName || sup.partyAName || '中国建筑第八工程局有限公司',
      乙方名称: sup.name || '',
      当前日期: fmtDate(new Date()),
      ...(params.manual || {}),
    };

    // 表格占位符：双花括号（先于单花括号变量替换，避免嵌套冲突）
    let html = template.content || '';
    // 新规范中文占位符
    html = html.split('{{物料编码清单}}').join(tables.codeTable);
    html = html.split('{{合同清单}}').join(tables.itemTable);
    // 兼容旧英文占位符
    html = html.split('{{MATERIAL_CODE_TABLE}}').join(tables.codeTable);
    html = html.split('{{CONTRACT_ITEM_TABLE}}').join(tables.itemTable);
    // 兼容单花括号中文别名
    html = html.split('{物料编码清单}').join(tables.codeTable);
    html = html.split('{合同清单}').join(tables.itemTable);
    // 合同额大写（双花括号与单花括号均支持）
    html = html.split('{{合同额大写}}').join(String(values['合同额大写'] ?? ''));
    html = html.split('{合同额大写}').join(String(values['合同额大写'] ?? ''));

    Object.entries(values).forEach(([key, value]) => {
      html = html.split(`{${key}}`).join(String(value ?? ''));
    });

    // 补充协议占位符：前端在 formData.supplement 中已解析好可直接注入的值（含表格 HTML 与各项汇总）
    const supp = this.parseSupplement(contract);
    Object.entries(supp).forEach(([key, value]) => {
      html = html.split(`{{${key}}}`).join(String(value ?? ''));
      html = html.split(`{${key}}`).join(String(value ?? ''));
    });
    Object.assign(values, supp);

    return { html, values, tables, templateName: template.name, variables: template.variables, pageSetup: (template as any).pageSetup || null };
  }

  /** 读取合同 formData.supplement 中由前端解析好的补充协议占位符值（已含表格 HTML 与各项汇总） */
  private parseSupplement(contract: any): Record<string, any> {
    try {
      const data = JSON.parse(contract?.formData || '{}');
      const sup = data?.supplement;
      if (!sup || typeof sup !== 'object') return {};
      // 仅注入已知补充协议占位符键，避免无关字段泄漏到正文
      const keys = [
        '补充协议编号', '补充协议类型', '原合同编号', '原合同名称', '补充协议表',
        '原合同金额总价大写', '新增合同金额总价大写', '数量汇总', '累计补充协议占比', '其他补充协议内容',
      ];
      const out: Record<string, any> = {};
      keys.forEach((k) => {
        if (sup[k] !== undefined) out[k] = sup[k];
      });
      return out;
    } catch {
      return {};
    }
  }

  /** 将旧模板中的英文表格占位符批量替换为中文占位符（一键迁移） */
  migratePlaceholders(content: string): string {
    if (!content) return content;
    return content
      .split('{{MATERIAL_CODE_TABLE}}')
      .join('{{物料编码清单}}')
      .split('{{CONTRACT_ITEM_TABLE}}')
      .join('{{合同清单}}');
  }

  // ---------------- 合同条款（需求 2.2/2.3：原条款库统一命名，固定四种类型） ----------------
  async clauses(query: any = {}) {
    const where: any = {};
    if (query.keyword) where.title = { contains: query.keyword };
    if (query.categoryCode) where.categoryCode = query.categoryCode;
    if (query.type) where.type = query.type;
    return this.prisma.clause.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
  }

  /** 条款类型固定枚举（供前端下拉使用） */
  clauseTypes() {
    return CLAUSE_TYPES;
  }

  async createClause(data: any, user: any) {
    return this.prisma.clause.create({ data: { ...pickFields(data, CLAUSE_FIELDS, { label: '条款' }), createdBy: user?.userId } });
  }

  async updateClause(id: string, data: any) {
    return this.prisma.clause.update({ where: { id }, data: pickFields(data, CLAUSE_FIELDS, { label: '条款' }) });
  }

  async removeClause(id: string) {
    await this.prisma.clause.delete({ where: { id } });
    return true;
  }
}

import io, sys, pathlib

ROOT = pathlib.Path('/Users/stromboid/WorkBuddy/2026-09-07-15-59-39/cms/server/src/modules')

def rep(path, old, new, count=1):
    p = ROOT / path
    s = p.read_text(encoding='utf-8')
    n = s.count(old)
    assert n == count, f'FAIL {path}: expected {count} got {n} for >>>{old[:90]}<<<'
    s = s.replace(old, new)
    p.write_text(s, encoding='utf-8')
    print(f'OK  {path}  <- {old[:60]!r}')

RUNNER_IMPORT = "import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';"

# ============================================================ 1. supplier
rep('supplier/supplier.service.ts',
    "import { paginate, buildResult, assertImportRows } from '../../common/utils/helpers';",
    "import { paginate, buildResult, assertVersion } from '../../common/utils/helpers';\n" + RUNNER_IMPORT)

rep('supplier/supplier.service.ts',
    "    private tpl: ImportTemplateService,\n  ) {}",
    "    private tpl: ImportTemplateService,\n    private runner: ImportRunnerService,\n  ) {}")

rep('supplier/supplier.service.ts',
"""  async update(id: string, data: any) {
    await this.findOne(id);
    if (data.name && data.name !== (await this.findOne(id)).name) {
      const exist = await this.prisma.supplier.findUnique({ where: { name: data.name } });
      if (exist) throw new BadRequestException('供应商名称已存在（系统内唯一）');
    }
    return this.prisma.supplier.update({ where: { id }, data: pickFields(data, SUPPLIER_FIELDS, { label: '供应商' }) });
  }""",
"""  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    if (data.name && data.name !== before.name) {
      const exist = await this.prisma.supplier.findUnique({ where: { name: data.name } });
      if (exist) throw new BadRequestException('供应商名称已存在（系统内唯一）');
    }
    const payload: any = pickFields(data, SUPPLIER_FIELDS, { label: '供应商' });
    delete payload.version;
    return this.prisma.supplier.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }""")

rep('supplier/supplier.service.ts',
"""  async import(buffer: Buffer, projectId?: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    assertImportRows(rows);
    let created = 0;
    let updated = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      const rowNo = index + 3;
      const name = String(r['供应商名称'] ?? '').trim();
      if (!name) {
        errors.push(`第 ${rowNo} 行：供应商名称为必填项`);
        continue;
      }
      const data: any = {
        name,
        legalPerson: r['法人姓名'] || null,
        legalPhone: r['法人电话'] || null,
        contractAuthPerson: r['合同授权人姓名'] || null,
        contractAuthPhone: r['合同授权人电话'] || null,
        contractAuthIdNo: r['合同授权人身份证号'] || null,
        contactName: r['联系人姓名'] || null,
        contactPhone: r['联系人电话'] || null,
        contactEmail: r['联系人邮箱'] || null,
        bankName: r['银行名称'] || null,
        bankAccount: r['银行账号'] || null,
        address: r['公司地址'] || null,
        remark: r['备注'] || null,
        status: String(r['状态'] ?? '启用') === '停用' ? 0 : 1,
      };
      const exist = await this.prisma.supplier.findUnique({ where: { name } });
      if (exist) {
        await this.prisma.supplier.update({ where: { id: exist.id }, data });
        updated++;
      } else {
        await this.create(data, projectId);
        created++;
      }
    }
    return { created, updated, errors };
  }""",
"""  /** 供应商信息导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async import(buffer: Buffer, projectId?: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const scope = await this.sysParam.get('supplier.share.scope', 'GLOBAL');
    const ownerProjectId = scope === 'PROJECT' ? projectId || null : null;
    const notDup = this.runner.batchDup();
    return this.runner.run<any>(rows, {
      plan: async (r, { rowNo }) => {
        const name = String(r['供应商名称'] ?? '').trim();
        if (!name) throw new RowError('供应商名称为必填项', '供应商名称');
        notDup(name, `供应商名称「${name}」在本次导入中重复`, '供应商名称');
        return {
          name,
          payload: {
            name,
            legalPerson: r['法人姓名'] || null,
            legalPhone: r['法人电话'] || null,
            contractAuthPerson: r['合同授权人姓名'] || null,
            contractAuthPhone: r['合同授权人电话'] || null,
            contractAuthIdNo: r['合同授权人身份证号'] || null,
            contactName: r['联系人姓名'] || null,
            contactPhone: r['联系人电话'] || null,
            contactEmail: r['联系人邮箱'] || null,
            bankName: r['银行名称'] || null,
            bankAccount: r['银行账号'] || null,
            address: r['公司地址'] || null,
            remark: r['备注'] || null,
            status: String(r['状态'] ?? '启用') === '停用' ? 0 : 1,
          },
        };
      },
      write: async (plans, tx) => {
        let created = 0;
        let updated = 0;
        for (const p of plans) {
          const exist = await tx.supplier.findUnique({ where: { name: p.name } });
          if (exist) {
            await tx.supplier.update({ where: { id: exist.id }, data: { ...p.payload, version: { increment: 1 } } });
            updated++;
          } else {
            await tx.supplier.create({ data: { ...p.payload, projectId: ownerProjectId } });
            created++;
          }
        }
        return { created, updated };
      },
    });
  }""")

# ============================================================ 2. daily-report
rep('daily-report/daily-report.service.ts',
    "import { paginate, buildResult, num, toDate } from '../../common/utils/helpers';",
    "import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';\n" + RUNNER_IMPORT)

rep('daily-report/daily-report.service.ts',
    "    private styled: StyledExcelService,\n  ) {}",
    "    private styled: StyledExcelService,\n    private runner: ImportRunnerService,\n  ) {}")

rep('daily-report/daily-report.service.ts',
"""  async create(data: any, projectId: string) {
    await this.validate(data);
    return this.prisma.dailyReport.create({ data: { ...this.normalize(data), projectId } });
  }

  async update(id: string, data: any) {
    await this.findOne(id);
    await this.validate(data);
    return this.prisma.dailyReport.update({ where: { id }, data: this.normalize(data) });
  }""",
"""  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.validate(data);
    return db.dailyReport.create({ data: { ...this.normalize(data), projectId } });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    await this.validate(data);
    const payload: any = this.normalize(data);
    delete payload.version;
    return this.prisma.dailyReport.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }""")

old_dr_import = open(ROOT / 'daily-report/daily-report.service.ts', encoding='utf-8').read()
start = old_dr_import.index('  async import(buffer: Buffer, projectId: string) {')
end = old_dr_import.index('    return { created, errors };\n  }', start) + len('    return { created, errors };\n  }')
old_block = old_dr_import[start:end]
assert '第 ${index + 2} 行' in old_block, 'daily-report import block anchor not matched'

new_block = """  /** 物资日报导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async import(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer);
    const [yesNo, assetStatus, source, category, type, unit] = await Promise.all([
      this.dict.options('yes_no'), this.dict.options('asset_status'), this.dict.options('material_source'),
      this.dict.options('material_category'), this.dict.options('material_type'), this.dict.options('measurement_unit'),
    ]);
    const codeOf = (items: any[], name: string) => {
      const hit = items.find((i: any) => i.itemName === name || i.itemCode === name);
      return hit?.itemCode || null;
    };
    return this.runner.run<any>(rows, {
      startRowNo: 2,
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        const supplierName = String(r['供应单位'] ?? '').trim();
        const contract = contractCode
          ? await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } })
          : null;
        if (contractCode && !contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const supplier = supplierName
          ? await this.prisma.supplier.findFirst({ where: { name: supplierName } })
          : null;
        if (supplierName && !supplier) throw new RowError(`关联校验失败：供应商库中不存在「${supplierName}」`, '供应单位');
        // 物资名称/规格型号统一取自物资基础库，日报通过 materialBaseId 关联（需求 2.5）
        const materialName = String(r['物资名称'] ?? '').trim() || null;
        const spec = String(r['规格型号'] ?? '').trim() || null;
        let materialBaseId: string | null = null;
        if (materialName && spec) {
          const base = await this.prisma.materialBase.findFirst({ where: { name: materialName, spec } });
          if (!base) throw new RowError(`关联校验失败：物资基础库中不存在「${materialName} / ${spec}」，请先维护物资基础库`, '物资名称');
          materialBaseId = base.id;
        }
        const data: any = {
          periodYear: Number(r['账期/年']) || null,
          periodMonth: Number(r['账期/月']) || null,
          entryDate: r['进场日期'] ? new Date(r['进场日期']) : null,
          contractId: contract?.id,
          isAsset: codeOf(yesNo, r['是否资产']),
          assetSupervision: r['资产监管'] || null,
          department: r['部门'] || null,
          personnel: r['人员'] || null,
          assetStatus: codeOf(assetStatus, r['资产状态']),
          sourceCode: codeOf(source, r['来源']),
          materialCategory: codeOf(category, r['材料类别']),
          materialType: codeOf(type, r['物资种类']),
          materialBaseId,
          materialName,
          steelBrand: r['钢筋品牌'] || null,
          steelCount: Number(r['钢筋件数']) || null,
          spec,
          unit: codeOf(unit, r['计量单位']),
          weighQty: num(r['过磅数量/t']),
          deductQty: num(r['扣重/t']),
          settleQty: num(r['结算数量']),
          isWeighed: codeOf(yesNo, r['是否过磅']),
          noAcceptReason: r['未云筑验收原因'] || null,
          priceBeforeTax: num(r['单价/元(税前)']),
          taxRate: num(r['税率']),
          priceAfterTax: num(r['单价/元(税后)']),
          amountBeforeTax: num(r['金额/元(税前)']),
          amountAfterTax: num(r['金额/元(税后)']),
          supplierId: supplier?.id,
          receiveUnit: r['领用单位'] || null,
          receiver: r['领料人'] || null,
          laborContract: r['劳务合同'] || null,
          usePosition: r['使用部位'] || null,
          isProxy: codeOf(yesNo, r['是否代购']),
          plateNo: r['车牌号'] || null,
          receiptNo: r['收领单编号'] || null,
          remark: r['备注'] || null,
          subcontractPeriod: r['分包计价账期'] || null,
          incomePrice: num(r['收入单价']),
          incomeAmount: num(r['收入合价']),
          stdPrice: num(r['标准单价']),
          stdAmount: num(r['标准合价']),
        };
        await this.validate(data);
        return { data };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.create(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }"""

rep('daily-report/daily-report.service.ts', old_block, new_block)

print('\nALL DONE (part 1)')

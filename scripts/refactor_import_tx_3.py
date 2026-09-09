import pathlib

ROOT = pathlib.Path('/Users/stromboid/WorkBuddy/2026-09-07-15-59-39/cms/server/src/modules')

def rep(path, old, new, count=1):
    p = ROOT / path
    s = p.read_text(encoding='utf-8')
    n = s.count(old)
    assert n == count, f'FAIL {path}: expected {count} got {n} for >>>{old[:90]}<<<'
    p.write_text(s.replace(old, new), encoding='utf-8')
    print(f'OK  {path}  <- {old[:60]!r}')

RUNNER_IMPORT = "import { ImportRunnerService, RowError, TxClient } from '../../common/services/import-runner.service';"

# ============================================================ 5. settlement
rep('settlement/settlement.service.ts',
    "import { paginate, buildResult, num, toDate, assertImportRows } from '../../common/utils/helpers';",
    "import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';\n" + RUNNER_IMPORT)

rep('settlement/settlement.service.ts',
    "  async create(data: any, projectId: string) {\n    await this.dict.validate('settlement_type', data.typeCode);",
    "  async create(data: any, projectId: string, tx?: TxClient) {\n    const db: any = tx || this.prisma;\n    await this.dict.validate('settlement_type', data.typeCode);")

rep('settlement/settlement.service.ts',
    "    return this.prisma.settlement.create({",
    "    return db.settlement.create({")

rep('settlement/settlement.service.ts',
"""  async update(id: string, data: any) {
    await this.findOne(id);
    await this.dict.validate('settlement_type', data.typeCode);""",
"""  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    await this.dict.validate('settlement_type', data.typeCode);""")

rep('settlement/settlement.service.ts',
"""    if (data.settleDate) payload.settleDate = toDate(data.settleDate);
    return this.prisma.settlement.update({ where: { id }, data: payload });""",
"""    if (data.settleDate) payload.settleDate = toDate(data.settleDate);
    delete payload.version;
    return this.prisma.settlement.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });""")

rep('settlement/settlement.service.ts',
"""  async createLedger(data: any, projectId: string) {
    await this.dict.validate('yes_no', data.isOnAccount);""",
"""  async createLedger(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.dict.validate('yes_no', data.isOnAccount);""")

rep('settlement/settlement.service.ts',
"    return this.prisma.settlementLedger.create({ data: payload });",
"    return db.settlementLedger.create({ data: payload });")

rep('settlement/settlement.service.ts',
"""  async updateLedger(id: string, data: any) {
    const old = await this.ledgerOne(id);
    await this.dict.validate('yes_no', data.isOnAccount);""",
"""  async updateLedger(id: string, data: any) {
    const old = await this.ledgerOne(id);
    assertVersion(old, data);
    await this.dict.validate('yes_no', data.isOnAccount);""")

rep('settlement/settlement.service.ts',
"""    return this.prisma.settlementLedger.update({ where: { id }, data: payload });""",
"""    delete payload.version;
    return this.prisma.settlementLedger.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });""")

rep('settlement/settlement.service.ts',
"""  /** 结算台账上传导入（需求 3.4）：新增不覆盖，逐行校验并输出错误报告 */
  async importLedger(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    assertImportRows(rows);
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      const rowNo = index + 3;
      try {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new Error('合同编号为必填项（关联校验）');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new Error(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`);
        const month = String(r['结算月份'] ?? '').trim();
        if (!/^\\d{4}-\\d{2}$/.test(month)) throw new Error('结算月份为必填项，格式 YYYY-MM（如 2026-08）');
        const dup = await this.prisma.settlementLedger.findFirst({
          where: { projectId, contractId: contract.id, settleMonth: month },
        });
        if (dup) throw new Error(`唯一性校验失败：该合同 ${month} 的结算台账已存在，导入不覆盖已有数据`);
        const isOnAccount = String(r['是否挂账'] ?? '').trim();
        await this.createLedger(
          {""",
"""  /** 结算台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importLedger(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const notDup = this.runner.batchDup();
    return this.runner.run<any>(rows, {
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const month = String(r['结算月份'] ?? '').trim();
        if (!/^\\d{4}-\\d{2}$/.test(month)) throw new RowError('结算月份为必填项，格式 YYYY-MM（如 2026-08）', '结算月份');
        notDup(`${contract.id}|${month}`, `唯一性校验失败：该合同 ${month} 的记录在本次导入中重复`, '结算月份');
        const dup = await this.prisma.settlementLedger.findFirst({
          where: { projectId, contractId: contract.id, settleMonth: month },
        });
        if (dup) throw new RowError(`唯一性校验失败：该合同 ${month} 的结算台账已存在，导入不覆盖已有数据`, '结算月份');
        const isOnAccount = String(r['是否挂账'] ?? '').trim();
        return {
          data: {""")

rep('settlement/settlement.service.ts',
"""            isOnAccount: isOnAccount || null,
            remark: String(r['备注'] ?? '').trim() || null,
          },
          projectId,
        );
        created++;
      } catch (e: any) {
        errors.push(`第 ${rowNo} 行：${e.message}`);
      }
    }
    return { created, errors };
  }""",
"""            isOnAccount: isOnAccount || null,
            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.createLedger(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }""")

# ============================================================ 6. asset
rep('asset/asset.service.ts',
    "import { paginate, buildResult, num, assertImportRows } from '../../common/utils/helpers';",
    "import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';\n" + RUNNER_IMPORT)

rep('asset/asset.service.ts',
"""  async create(data: any, projectId: string) {
    this.validate(data);""",
"""  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    this.validate(data);""")

rep('asset/asset.service.ts',
"    return this.prisma.assetLedger.create({ data: payload });",
"    return db.assetLedger.create({ data: payload });")

rep('asset/asset.service.ts',
"""  async update(id: string, data: any) {
    const old = await this.prisma.assetLedger.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('资产台账记录不存在');
    this.validate({ ...old, ...data });""",
"""  async update(id: string, data: any) {
    const old = await this.prisma.assetLedger.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('资产台账记录不存在');
    assertVersion(old, data);
    this.validate({ ...old, ...data });""")

rep('asset/asset.service.ts',
"""  /** 资产管理台账上传导入（需求 3.4）：字典名称→编码解析、状态数量校验、新增不覆盖 */
  async importAssets(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    assertImportRows(rows);
    const [source, catL1, catFocus, unit] = await Promise.all([""",
"""  /** 资产管理台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importAssets(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const [source, catL1, catFocus, unit] = await Promise.all([""")

rep('asset/asset.service.ts',
"""      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      const rowNo = index + 3;
      try {
        const name = String(r['资产名称'] ?? '').trim();
        if (!name) throw new Error('资产名称为必填项');
        const sourceVal = String(r['来源'] ?? '').trim();
        if (!sourceVal) throw new Error('来源为必填项');
        const sourceCode = codeOf(source, sourceVal);
        if (!sourceCode) throw new Error(`下拉校验失败：「${sourceVal}」不在资产来源选项范围内`);
        const catL1Val = String(r['资产类别（一级）'] ?? '').trim();
        if (!catL1Val) throw new Error('资产类别（一级）为必填项');
        const categoryL1Code = codeOf(catL1, catL1Val);
        if (!categoryL1Code) throw new Error(`下拉校验失败：「${catL1Val}」不在资产类别选项范围内`);
        const price = num(r['进/出场单价（金额）']);
        if (price === null) throw new Error('进/出场单价（金额）为必填数字');
        const qty = num(r['进/出场数量']);
        const statusSum = (num(r['在用数量']) || 0) + (num(r['闲置数量']) || 0) + (num(r['报废数量']) || 0) + (num(r['丢失数量']) || 0);
        if (qty !== null && statusSum > 0 && Math.abs(statusSum - qty) > 0.0001) {
          throw new Error(`在用/闲置/报废/丢失数量合计（${statusSum}）应等于进/出场数量（${qty}）`);
        }
        await this.create(
          {""",
"""      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    return this.runner.run<any>(rows, {
      plan: async (r) => {
        const name = String(r['资产名称'] ?? '').trim();
        if (!name) throw new RowError('资产名称为必填项', '资产名称');
        const sourceVal = String(r['来源'] ?? '').trim();
        if (!sourceVal) throw new RowError('来源为必填项', '来源');
        const sourceCode = codeOf(source, sourceVal);
        if (!sourceCode) throw new RowError(`下拉校验失败：「${sourceVal}」不在资产来源选项范围内`, '来源');
        const catL1Val = String(r['资产类别（一级）'] ?? '').trim();
        if (!catL1Val) throw new RowError('资产类别（一级）为必填项', '资产类别（一级）');
        const categoryL1Code = codeOf(catL1, catL1Val);
        if (!categoryL1Code) throw new RowError(`下拉校验失败：「${catL1Val}」不在资产类别选项范围内`, '资产类别（一级）');
        const price = num(r['进/出场单价（金额）']);
        if (price === null) throw new RowError('进/出场单价（金额）为必填数字', '进/出场单价（金额）');
        const qty = num(r['进/出场数量']);
        const statusSum = (num(r['在用数量']) || 0) + (num(r['闲置数量']) || 0) + (num(r['报废数量']) || 0) + (num(r['丢失数量']) || 0);
        if (qty !== null && statusSum > 0 && Math.abs(statusSum - qty) > 0.0001) {
          throw new RowError(`在用/闲置/报废/丢失数量合计（${statusSum}）应等于进/出场数量（${qty}）`, '在用数量');
        }
        return {
          data: {""")

rep('asset/asset.service.ts',
"""            remark: String(r['备注'] ?? '').trim() || null,
          },
          projectId,
        );
        created++;
      } catch (e: any) {
        errors.push(`第 ${rowNo} 行：${e.message}`);
      }
    }
    return { created, errors };
  }""",
"""            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.create(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }""")

# ============================================================ 7. project
rep('project/project.service.ts',
    "import { paginate, buildResult, num, assertImportRows } from '../../common/utils/helpers';",
    "import { paginate, buildResult, num, assertVersion } from '../../common/utils/helpers';\n" + RUNNER_IMPORT)

rep('project/project.service.ts',
"""  async create(data: any) {
    if (!data.code) throw new BadRequestException('项目编码不能为空');""",
"""  async create(data: any, tx?: TxClient) {
    const db: any = tx || this.prisma;
    if (!data.code) throw new BadRequestException('项目编码不能为空');""")

rep('project/project.service.ts',
"    return this.prisma.project.create({ data: pickFields(data, PROJECT_FIELDS, { label: '项目' }) });",
"    return db.project.create({ data: pickFields(data, PROJECT_FIELDS, { label: '项目' }) });")

rep('project/project.service.ts',
"""  async update(id: string, data: any) {
    await this.findOne(id);
    if (data.status) await this.dict.validate('project_status', data.status);
    await this.dict.validate('industry_type', data.industryType);
    await this.assertCodeAbbr(data.codeAbbr, id);
    return this.prisma.project.update({ where: { id }, data: pickFields(data, PROJECT_FIELDS, { label: '项目' }) });
  }""",
"""  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    if (data.status) await this.dict.validate('project_status', data.status);
    await this.dict.validate('industry_type', data.industryType);
    await this.assertCodeAbbr(data.codeAbbr, id);
    const payload: any = pickFields(data, PROJECT_FIELDS, { label: '项目' });
    delete payload.version;
    return this.prisma.project.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }""")

rep('project/project.service.ts',
"""  /** 项目信息上传导入（需求 3.4）：新增不覆盖，逐行校验并输出错误报告 */
  async importProjects(buffer: Buffer) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    assertImportRows(rows);
    const [industry, status] = await Promise.all([""",
"""  /** 项目信息导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importProjects(buffer: Buffer) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const [industry, status] = await Promise.all([""")

rep('project/project.service.ts',
"""      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      const rowNo = index + 3;
      try {
        const code = String(r['项目编码'] ?? '').trim();
        if (!code) throw new Error('项目编码为必填项');
        const name = String(r['项目名称'] ?? '').trim();
        if (!name) throw new Error('项目名称为必填项');
        const exist = await this.prisma.project.findUnique({ where: { code } });
        if (exist) throw new Error(`唯一性校验失败：项目编码 ${code} 已存在，导入不覆盖已有数据`);
        const industryVal = String(r['项目业态'] ?? '').trim();
        const industryType = codeOf(industry, industryVal);
        if (industryVal && industryType === null) throw new Error(`下拉校验失败：「${industryVal}」不在项目业态选项范围内`);
        const statusVal = String(r['状态'] ?? '').trim();
        const statusCode = codeOf(status, statusVal);
        if (statusVal && statusCode === null) throw new Error(`下拉校验失败：「${statusVal}」不在项目状态选项范围内`);
        await this.create({""",
"""      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    const notDup = this.runner.batchDup();
    return this.runner.run<any>(rows, {
      plan: async (r) => {
        const code = String(r['项目编码'] ?? '').trim();
        if (!code) throw new RowError('项目编码为必填项', '项目编码');
        const name = String(r['项目名称'] ?? '').trim();
        if (!name) throw new RowError('项目名称为必填项', '项目名称');
        notDup(code, `项目编码「${code}」在本次导入中重复`, '项目编码');
        const exist = await this.prisma.project.findUnique({ where: { code } });
        if (exist) throw new RowError(`唯一性校验失败：项目编码 ${code} 已存在，导入不覆盖已有数据`, '项目编码');
        const industryVal = String(r['项目业态'] ?? '').trim();
        const industryType = codeOf(industry, industryVal);
        if (industryVal && industryType === null) throw new RowError(`下拉校验失败：「${industryVal}」不在项目业态选项范围内`, '项目业态');
        const statusVal = String(r['状态'] ?? '').trim();
        const statusCode = codeOf(status, statusVal);
        if (statusVal && statusCode === null) throw new RowError(`下拉校验失败：「${statusVal}」不在项目状态选项范围内`, '状态');
        return {
          data: {""")

rep('project/project.service.ts',
"""          description: String(r['描述'] ?? '').trim() || null,
        });
        created++;
      } catch (e: any) {
        errors.push(`第 ${rowNo} 行：${e.message}`);
      }
    }
    return { created, errors };
  }""",
"""          description: String(r['描述'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.create(p.data, tx);
        return { created: plans.length };
      },
    });
  }""")

# ============================================================ 8. dict
rep('dict/dict.service.ts',
    "import { paginate, buildResult } from '../../common/utils/helpers';",
    "import { paginate, buildResult } from '../../common/utils/helpers';\n" + RUNNER_IMPORT)

rep('dict/dict.service.ts',
"""  async importItems(typeCode: string, buffer: Buffer) {
    const rows = await this.excel.parse(buffer);
    let created = 0;
    let updated = 0;
    for (const r of rows) {
      const itemCode = String(r['字典项编码'] ?? '').trim();
      const itemName = String(r['字典项名称'] ?? '').trim();
      if (!itemCode || !itemName) continue;
      const data: any = {
        itemName,
        sortOrder: Number(r['排序号']) || 0,
        status: String(r['状态'] ?? '启用') === '停用' ? 0 : 1,
        color: r['颜色'] || null,
        extField1: r['扩展字段1'] || null,
        remark: r['备注'] || null,
      };
      const exist = await this.prisma.dictItem.findUnique({ where: { typeCode_itemCode: { typeCode, itemCode } } });
      if (exist) {
        await this.prisma.dictItem.update({ where: { id: exist.id }, data });
        updated++;
      } else {
        await this.prisma.dictItem.create({ data: { typeCode, itemCode, ...data } });
        created++;
      }
    }
    await this.refreshCache(typeCode);
    return { created, updated };
  }""",
"""  /** 字典项导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importItems(typeCode: string, buffer: Buffer) {
    const rows = await this.excel.parse(buffer);
    const type = await this.prisma.dictType.findUnique({ where: { typeCode } });
    if (!type) throw new NotFoundException(`字典类型 ${typeCode} 不存在`);
    const notDup = this.runner.batchDup();
    const outcome = await this.runner.run<any>(rows, {
      startRowNo: 2,
      plan: async (r) => {
        const itemCode = String(r['字典项编码'] ?? '').trim();
        const itemName = String(r['字典项名称'] ?? '').trim();
        if (!itemCode || !itemName) return null;
        notDup(itemCode, `字典项编码「${itemCode}」在本次导入中重复`, '字典项编码');
        return {
          itemCode,
          payload: {
            itemName,
            sortOrder: Number(r['排序号']) || 0,
            status: String(r['状态'] ?? '启用') === '停用' ? 0 : 1,
            color: r['颜色'] || null,
            extField1: r['扩展字段1'] || null,
            remark: r['备注'] || null,
          },
        };
      },
      write: async (plans, tx) => {
        let created = 0;
        let updated = 0;
        for (const p of plans) {
          const exist = await tx.dictItem.findUnique({ where: { typeCode_itemCode: { typeCode, itemCode: p.itemCode } } });
          if (exist) {
            await tx.dictItem.update({ where: { id: exist.id }, data: p.payload });
            updated++;
          } else {
            await tx.dictItem.create({ data: { typeCode, itemCode: p.itemCode, ...p.payload } });
            created++;
          }
        }
        return { created, updated };
      },
    });
    await this.refreshCache(typeCode);
    return outcome;
  }""")

print('\nALL DONE (part 3)')

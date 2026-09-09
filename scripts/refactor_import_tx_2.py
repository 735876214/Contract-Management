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

# ============================================================ 3. invoice
rep('invoice/invoice.service.ts',
    "import { paginate, buildResult, num, toDate, assertImportRows } from '../../common/utils/helpers';",
    "import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';\n" + RUNNER_IMPORT)

rep('invoice/invoice.service.ts',
    "    private tpl: ImportTemplateService,\n  ) {}",
    "    private tpl: ImportTemplateService,\n    private runner: ImportRunnerService,\n  ) {}")

rep('invoice/invoice.service.ts',
"""  async create(data: any, projectId: string) {
    await this.validate(data);""",
"""  async create(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.validate(data);""")

rep('invoice/invoice.service.ts',
"""    return this.prisma.invoice.create({ data: payload });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);""",
"""    return db.invoice.create({ data: payload });
  }

  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);""")

rep('invoice/invoice.service.ts',
"""    if (data.receiveDate) payload.receiveDate = toDate(data.receiveDate);
    return this.prisma.invoice.update({ where: { id }, data: payload });""",
"""    if (data.receiveDate) payload.receiveDate = toDate(data.receiveDate);
    delete payload.version;
    return this.prisma.invoice.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });""")

rep('invoice/invoice.service.ts',
"""  async import(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    assertImportRows(rows);
    const [goods, review, finance, status, types] = await Promise.all([""",
"""  /** 发票台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async import(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const [goods, review, finance, status, types] = await Promise.all([""")

rep('invoice/invoice.service.ts',
"""    const codeOf = (items: any[], name: string) => items.find((i: any) => i.itemName === name || i.itemCode === name)?.itemCode || null;
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      const rowNo = index + 3;
      try {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new Error('合同编号为必填项（关联校验）');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new Error(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`);
        // 税率支持两种口径：13（百分比）或 0.13（小数）
        const taxRaw = num(r['税率(%)']) ?? num(r['税率']);
        const taxRate = taxRaw !== null && taxRaw > 1 ? taxRaw / 100 : taxRaw;
        await this.create(
          {""",
"""    const codeOf = (items: any[], name: string) => items.find((i: any) => i.itemName === name || i.itemCode === name)?.itemCode || null;
    return this.runner.run<any>(rows, {
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        // 税率统一取自合同台账（需求 2.4）：子表未填时继承合同税率
        const taxRaw = num(r['税率(%)']) ?? num(r['税率']);
        let taxRate = taxRaw !== null && taxRaw > 1 ? taxRaw / 100 : taxRaw;
        if (taxRate === null && (contract as any).taxRate != null) {
          const ct = Number((contract as any).taxRate);
          taxRate = ct > 1 ? ct / 100 : ct;
        }
        return {
          data: {""")

rep('invoice/invoice.service.ts',
"""            contractId: contract.id,
            goodsCategory: codeOf(goods, r['商品类别']),
            settlePeriod: r['结算账期'] || null,
            issuer: r['开票单位'] || null,
            invoiceDate: r['开票日期'] ? new Date(r['开票日期']) : null,
            invoiceCode: r['发票代码'] || null,
            invoiceNo: r['发票号码'] || null,
            amountBeforeTax: num(r['税前金额']),
            taxRate,
            amountWithTax: num(r['含税金额']),
            receiveDate: r['发票收取时间'] ? new Date(r['发票收取时间']) : null,
            reviewStatus: codeOf(review, r['发票信息审核']),
            responsiblePerson: r['责任人'] || null,
            financeTransferStatus: codeOf(finance, r['财务移交情况']),
            typeCode: codeOf(types, r['发票类型']),
            statusCode: codeOf(status, r['状态']),
            remark: r['备注'] || null,
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
"""            contractId: contract.id,
            goodsCategory: codeOf(goods, r['商品类别']),
            settlePeriod: r['结算账期'] || null,
            issuer: r['开票单位'] || null,
            invoiceDate: r['开票日期'] ? new Date(r['开票日期']) : null,
            invoiceCode: r['发票代码'] || null,
            invoiceNo: r['发票号码'] || null,
            amountBeforeTax: num(r['税前金额']),
            taxRate,
            amountWithTax: num(r['含税金额']),
            receiveDate: r['发票收取时间'] ? new Date(r['发票收取时间']) : null,
            reviewStatus: codeOf(review, r['发票信息审核']),
            responsiblePerson: r['责任人'] || null,
            financeTransferStatus: codeOf(finance, r['财务移交情况']),
            typeCode: codeOf(types, r['发票类型']),
            statusCode: codeOf(status, r['状态']),
            remark: r['备注'] || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.create(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }""")

# ============================================================ 4. payment
rep('payment/payment.service.ts',
    "import { paginate, buildResult, num, toDate, assertImportRows } from '../../common/utils/helpers';",
    "import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';\n" + RUNNER_IMPORT)

rep('payment/payment.service.ts',
    "    private tpl: ImportTemplateService,\n  ) {}",
    "    private tpl: ImportTemplateService,\n    private runner: ImportRunnerService,\n  ) {}")

rep('payment/payment.service.ts',
"""  async createRecord(data: any, projectId: string) {
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    return this.prisma.paymentRecord.create({""",
"""  async createRecord(data: any, projectId: string, tx?: TxClient) {
    const db: any = tx || this.prisma;
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    return db.paymentRecord.create({""")

rep('payment/payment.service.ts',
"""  async updateRecord(id: string, data: any) {
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    const payload: any = pickFields(data, RECORD_FIELDS, { label: '付款记录' });
    if (payload.amount !== undefined) payload.amount = num(payload.amount);
    if (payload.payDate) payload.payDate = toDate(payload.payDate);
    return this.prisma.paymentRecord.update({ where: { id }, data: payload });
  }""",
"""  async updateRecord(id: string, data: any) {
    const before = await this.prisma.paymentRecord.findUnique({ where: { id } });
    assertVersion(before, data);
    await this.dict.validate('payment_method', data.methodCode);
    await this.dict.validate('payment_status', data.statusCode);
    const payload: any = pickFields(data, RECORD_FIELDS, { label: '付款记录' });
    if (payload.amount !== undefined) payload.amount = num(payload.amount);
    if (payload.payDate) payload.payDate = toDate(payload.payDate);
    delete payload.version;
    return this.prisma.paymentRecord.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }""")

rep('payment/payment.service.ts',
"""  /** 付款台账上传导入（需求 3.4）：新增不覆盖，逐行校验并输出错误报告 */
  async importRecords(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    assertImportRows(rows);
    const methods = await this.dict.options('payment_method');""",
"""  /** 付款台账导入（需求 2.1）：两阶段校验 + 事务写入，全成功或全失败 */
  async importRecords(buffer: Buffer, projectId: string) {
    const rows = await this.excel.parse(buffer, [2]); // 第 2 行为填写模板示例行
    const methods = await this.dict.options('payment_method');""")

rep('payment/payment.service.ts',
"""      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    let created = 0;
    const errors: string[] = [];
    for (const [index, r] of rows.entries()) {
      const rowNo = index + 3;
      try {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new Error('合同编号为必填项（关联校验）');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new Error(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`);
        const payMonth = String(r['付款月份'] ?? '').trim();
        if (!/^\\d{4}-\\d{2}$/.test(payMonth)) throw new Error('付款月份为必填项，格式 YYYY-MM（如 2026-09）');
        const amount = num(r['付款金额']);
        if (amount === null) throw new Error('付款金额为必填数字');
        const methodName = String(r['付款方式'] ?? '').trim();
        if (methodName && codeOf(methods, methodName) === null) {
          throw new Error(`下拉校验失败：「${methodName}」不在付款方式选项范围内`);
        }
        const statusName = String(r['状态'] ?? '').trim();
        if (statusName && codeOf(status, statusName) === null) {
          throw new Error(`下拉校验失败：「${statusName}」不在状态选项范围内`);
        }
        await this.createRecord(
          {""",
"""      val ? (items.find((i: any) => i.itemName === val || i.itemCode === val)?.itemCode ?? null) : null;
    return this.runner.run<any>(rows, {
      plan: async (r) => {
        const contractCode = String(r['合同编号'] ?? '').trim();
        if (!contractCode) throw new RowError('合同编号为必填项（关联校验）', '合同编号');
        const contract = await this.prisma.contract.findFirst({ where: { projectId, code: contractCode } });
        if (!contract) throw new RowError(`关联校验失败：合同台账中不存在合同编号「${contractCode}」`, '合同编号');
        const payMonth = String(r['付款月份'] ?? '').trim();
        if (!/^\\d{4}-\\d{2}$/.test(payMonth)) throw new RowError('付款月份为必填项，格式 YYYY-MM（如 2026-09）', '付款月份');
        const amount = num(r['付款金额']);
        if (amount === null) throw new RowError('付款金额为必填数字', '付款金额');
        const methodName = String(r['付款方式'] ?? '').trim();
        if (methodName && codeOf(methods, methodName) === null) {
          throw new RowError(`下拉校验失败：「${methodName}」不在付款方式选项范围内`, '付款方式');
        }
        const statusName = String(r['状态'] ?? '').trim();
        if (statusName && codeOf(status, statusName) === null) {
          throw new RowError(`下拉校验失败：「${statusName}」不在状态选项范围内`, '状态');
        }
        return {
          data: {""")

rep('payment/payment.service.ts',
"""            contractId: contract.id,
            payMonth,
            amount,
            methodCode: codeOf(methods, methodName),
            payDate: r['付款日期'] || null,
            statusCode: codeOf(status, statusName),
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
"""            contractId: contract.id,
            payMonth,
            amount,
            methodCode: codeOf(methods, methodName),
            payDate: r['付款日期'] || null,
            statusCode: codeOf(status, statusName),
            remark: String(r['备注'] ?? '').trim() || null,
          },
        };
      },
      write: async (plans, tx) => {
        for (const p of plans) await this.createRecord(p.data, projectId, tx);
        return { created: plans.length };
      },
    });
  }""")

print('\nALL DONE (part 2)')

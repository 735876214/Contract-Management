import pathlib

SRV = pathlib.Path('/Users/stromboid/WorkBuddy/2026-09-07-15-59-39/cms/server/src/modules')
WEB = pathlib.Path('/Users/stromboid/WorkBuddy/2026-09-07-15-59-39/cms/web/src')

def rep(path, old, new, count=1, base=SRV):
    p = base / path
    s = p.read_text(encoding='utf-8')
    n = s.count(old)
    assert n == count, f'FAIL {path}: expected {count} got {n} for >>>{old[:90]}<<<'
    p.write_text(s.replace(old, new), encoding='utf-8')
    print(f'OK  {path}  <- {old[:55]!r}')

# ---------------- 还款协议：事务 + 乐观锁 ----------------
rep('repayment/repayment.service.ts',
    "import { paginate, buildResult, num, toDate } from '../../common/utils/helpers';",
    "import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';")

rep('repayment/repayment.service.ts',
"""  async update(id: string, data: any) {
    const before = await this.findOne(id);
    if (data.code && data.code !== before.code) {""",
"""  async update(id: string, data: any) {
    const before = await this.findOne(id);
    assertVersion(before, data);
    if (data.code && data.code !== before.code) {""")

rep('repayment/repayment.service.ts',
"""    const { details: _d, ...rest } = data;
    await this.prisma.repaymentAgreement.update({ where: { id }, data: this.normalize(rest) });
    if (details) {
      await this.prisma.repaymentDetail.deleteMany({ where: { agreementId: id } });
      await this.prisma.repaymentDetail.createMany({
        data: details.map((d: any, i: number) => ({ agreementId: id, ...this.normalizeDetail(d, i) })),
      });
    }
    return this.findOne(id);
  }""",
"""    const { details: _d, ...rest } = data;
    const payload: any = this.normalize(rest);
    delete payload.version;
    // 需求 2.1：主表 + 明细在同一事务内写入，任一步失败整体回滚
    await this.prisma.$transaction(async (tx) => {
      await tx.repaymentAgreement.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
      if (details) {
        await tx.repaymentDetail.deleteMany({ where: { agreementId: id } });
        await tx.repaymentDetail.createMany({
          data: details.map((d: any, i: number) => ({ agreementId: id, ...this.normalizeDetail(d, i) })),
        });
      }
    });
    return this.findOne(id);
  }""")

# ---------------- 资金费用：乐观锁 ----------------
rep('finance/finance.service.ts',
    "import { paginate, buildResult, num, toDate } from '../../common/utils/helpers';",
    "import { paginate, buildResult, num, toDate, assertVersion } from '../../common/utils/helpers';")

rep('finance/finance.service.ts',
"""  async updateFactoring(id: string, data: any) {
    const old = await this.prisma.factoringCost.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('保理费用记录不存在');
    const payload = this.factoringPayload(data, old);
    return this.prisma.factoringCost.update({ where: { id }, data: payload });
  }""",
"""  async updateFactoring(id: string, data: any) {
    const old = await this.prisma.factoringCost.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('保理费用记录不存在');
    assertVersion(old, data);
    const payload: any = this.factoringPayload(data, old);
    delete payload.version;
    return this.prisma.factoringCost.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
  }""")

rep('finance/finance.service.ts',
"""  async updateOverdue(id: string, data: any) {
    const old = await this.prisma.overdueInterest.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('逾期利息记录不存在');
    await this.validateOverdue(data, old);""",
"""  async updateOverdue(id: string, data: any) {
    const old = await this.prisma.overdueInterest.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('逾期利息记录不存在');
    assertVersion(old, data);
    await this.validateOverdue(data, old);""")

rep('finance/finance.service.ts',
"""    await this.prisma.overdueInterest.update({ where: { id }, data: payload });
    await this.recalcOverdue(old.contractId);""",
"""    delete payload.version;
    await this.prisma.overdueInterest.update({ where: { id }, data: { ...payload, version: { increment: 1 } } });
    await this.recalcOverdue(old.contractId);""")

# ---------------- 前端：结构化错误报告 ----------------
rep('components/ImportButton.tsx',
"""export interface ImportResult {
  created?: number;
  updated?: number;
  errors?: string[];
}""",
"""export interface ImportRowError {
  /** Excel 中的实际行号 */
  row?: number;
  /** 出错字段（表头名） */
  field?: string;
  message?: string;
}

export interface ImportResult {
  created?: number;
  updated?: number;
  errors?: (ImportRowError | string)[];
}

/** 统一渲染一条错误（兼容旧的字符串格式） */
function renderError(e: ImportRowError | string): string {
  if (typeof e === 'string') return e;
  const parts: string[] = [];
  if (e.row) parts.push(`第 ${e.row} 行`);
  if (e.field) parts.push(`【${e.field}】`);
  return `${parts.join(' ')}${parts.length ? '：' : ''}${e.message || '未知错误'}`;
}""", base=WEB)

rep('components/ImportButton.tsx',
"""      setResult(res || {});
      setStage('result');
      const errs = res?.errors || [];
      if (errs.length) message.warning(`导入完成，${errs.length} 行失败，详见报告`);
      else message.success(`导入成功：新增 ${res?.created ?? 0}${res?.updated != null ? `，更新 ${res?.updated}` : ''}`);""",
"""      setResult(res || {});
      setStage('result');
      const errs = res?.errors || [];
      if (errs.length) message.warning(`导入未完成：${errs.length} 行校验失败，已全部回滚，未写入任何数据`);
      else message.success(`导入成功：新增 ${res?.created ?? 0}${res?.updated != null ? `，更新 ${res?.updated}` : ''}`);""", base=WEB)

rep('components/ImportButton.tsx',
"""              message={`导入完成：新增 ${result?.created ?? 0}${result?.updated != null ? `，更新 ${result?.updated}` : ''}${errCount ? `，失败 ${errCount} 行` : ''}`}""",
"""              message={
                errCount
                  ? `导入未完成：${errCount} 行校验失败，已全部回滚，未写入任何数据`
                  : `导入完成：新增 ${result?.created ?? 0}${result?.updated != null ? `，更新 ${result?.updated}` : ''}`
              }""", base=WEB)

rep('components/ImportButton.tsx',
"""                message="错误报告（行号 + 原因）"
                description={
                  <ul style={{ maxHeight: 240, overflowY: 'auto', paddingLeft: 18, margin: '4px 0 0' }}>
                    {result!.errors!.map((e, i) => (
                      <li key={i} style={{ color: '#d4380d', lineHeight: '20px' }}>{e}</li>
                    ))}
                  </ul>
                }""",
"""                message="错误报告（行号 + 字段 + 原因）"
                description={
                  <ul style={{ maxHeight: 240, overflowY: 'auto', paddingLeft: 18, margin: '4px 0 0' }}>
                    {result!.errors!.map((e, i) => (
                      <li key={i} style={{ color: '#d4380d', lineHeight: '20px' }}>{renderError(e)}</li>
                    ))}
                  </ul>
                }""", base=WEB)

rep('components/ImportButton.tsx',
"""              单次导入最多 5000 行；导入默认为新增数据，不覆盖已有数据。{extraHint || ''}""",
"""              单次导入最多 5000 行；采用「全成功或全失败」策略：任一行校验失败即整体回滚，不会写入部分数据。{extraHint || ''}""", base=WEB)

print('\nALL DONE (part 5)')

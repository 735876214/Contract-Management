import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as ExcelJS from 'exceljs';
import { bootIntApp, makeContract, makeProject, uniq, type IntContext } from './helpers';
import { AnalyticsService } from '../src/modules/ai/analytics/analytics.service';
import { AiService } from '../src/modules/ai/ai.service';
import type { JwtUser } from '../src/common/decorators/user.decorator';

/**
 * 集成 · AI 经营数据助手（Phase 4）：多 sheet 工作簿落库/下载 + 行级表格填充。
 */
describe('集成 · AI 经营数据助手 工作簿与行级填充', () => {
  let ctx: IntContext;
  let analytics: AnalyticsService;
  let ai: AiService;

  before(async () => {
    ctx = await bootIntApp();
    analytics = ctx.get<AnalyticsService>(AnalyticsService);
    ai = ctx.get<AiService>(AiService);
  });
  after(async () => {
    await ctx.app.close();
  });

  async function setup() {
    const project = await makeProject(ctx.prisma, 'ANA-WB');
    const user = await ctx.prisma.user.create({
      data: { username: uniq('int-ana-wb'), password: 'x', realName: '工作簿用户', isSuperAdmin: false } as any,
    });
    const jwt = {
      userId: user.id,
      username: user.username,
      realName: user.realName,
      isSuperAdmin: false,
      permissions: ['ai:use', 'ai:view', 'contract:view', 'settlement:view', 'payment:view', 'invoice:view', 'daily:view'],
    } as JwtUser;
    await ctx.prisma.projectMember.create({ data: { projectId: project.id, userId: user.id } });
    const main = await makeContract(ctx.prisma, { projectId: project.id, amount: 120000, status: 'SIGNED' });
    await ctx.prisma.contract.update({ where: { id: main.id }, data: { signDate: new Date() } as any });
    return { project, jwt };
  }

  it('生成工作簿并落库；下载内容是合法 xlsx；可挂到已有报告记录', async () => {
    const { project, jwt } = await setup();
    const report = await analytics.report(
      { scope: { mode: 'current' }, period: { preset: 'this_year' }, datasets: ['contract.summary'], compare: 'none', narrative: false },
      project.id,
      jwt,
    );
    const wb = await analytics.workbook(
      { scope: { mode: 'current' }, period: { preset: 'this_year' }, datasets: ['contract.summary'], compare: 'none', reportId: report.id! },
      project.id,
      jwt,
    );
    assert.equal(wb.reportId, report.id);
    assert.ok(wb.size > 1000);
    assert.ok(wb.sheets.includes('经营总览'));
    assert.ok(wb.sheets.includes('合同汇总'));

    const row = await analytics.detail(report.id!, jwt);
    assert.equal(row.hasReport, true);
    assert.equal(row.hasWorkbook, true);
    assert.ok(row.workbookKey);

    const file = await analytics.workbookFile(report.id!, jwt);
    assert.ok(file.buffer.length > 1000);
    assert.equal(file.buffer.subarray(0, 2).toString('latin1'), 'PK');
  });

  it('行级填充：表头 + 空行 → 按列映射写入数据集行；空值跳过并计数', async () => {
    const { project, jwt } = await setup();
    const book = new ExcelJS.Workbook();
    const ws = book.addWorksheet('明细');
    ws.getRow(1).values = ['项目', '本期新签合同', '本期新签金额', '备注'];
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    const file = {
      buffer,
      originalname: 'row-fill.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: buffer.length,
    };

    const res = await ai.fillTable(
      file,
      {
        datasetKey: 'contract.summary',
        sheet: '明细',
        headerRow: '1',
        startRow: '2',
        columns: JSON.stringify([
          { col: 1, source: '项目' },
          { col: 3, source: '本期新签金额' },
        ]),
      },
      { projectId: project.id, scope: { mode: 'current', projectIds: [project.id] }, period: { from: '2026-01-01', to: '2026-12-31' } },
      jwt,
    );
    assert.equal(res.filledRows, 1, '一个项目应写一行');
    assert.equal(res.skippedCells, 0, '两列都有值时不跳过');
    assert.ok(res.fileName.endsWith('-已填表.xlsx'));

    const out = new ExcelJS.Workbook();
    await out.xlsx.load(res.buffer as any);
    const outSheet = out.getWorksheet('明细')!;
    assert.ok(String(outSheet.getCell(2, 1).value).includes(project.code));
    assert.equal(outSheet.getCell(2, 3).value, 120000);
  });

  it('行级填充同样受数据集读取权限约束：无 material:view 不能导出合同物资清单', async () => {
    const { project, jwt } = await setup();
    const book = new ExcelJS.Workbook();
    const ws = book.addWorksheet('明细');
    ws.getRow(1).values = ['项目', '物资名称'];
    const buffer = Buffer.from(await book.xlsx.writeBuffer());
    await assert.rejects(
      () =>
        ai.fillTable(
          {
            buffer,
            originalname: 'deny.xlsx',
            mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            size: buffer.length,
          },
          { datasetKey: 'material.contract', sheet: '明细', headerRow: '1', startRow: '2', columns: JSON.stringify([{ col: 1, source: '项目' }]) },
          { projectId: project.id, scope: { mode: 'current', projectIds: [project.id] } },
          jwt,
        ),
      /读取权限/,
    );
  });
});

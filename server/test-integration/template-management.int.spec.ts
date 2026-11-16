import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { bootIntApp, uniq, type IntContext } from './helpers';
import { TemplateService } from '../src/modules/template/template.service';
import { ProcurementTemplateService } from '../src/modules/procurement/procurement-template.service';
import { DocTemplateService } from '../src/modules/doc-template/doc-template.service';
import { StorageService } from '../src/common/services/storage.service';

/**
 * 集成测试 · 三套模板管理的语义（2026-10-18）。
 *
 * 纯函数测不了的东西：
 * - 合同模板的**行式版本链**（编辑建新行、旧行停用）、删除是否整链删除、状态是否真的生效；
 * - 采购模板的筛选/分页返回形态与状态校验；
 * - 单据模板的 **fileUrl 归一**（历史 `/api/files/...` URL → 相对键）与 Excel 扩展名/解析校验，
 *   以及生成时真的能读盘替换占位符（此前存 URL 会被安全校验拒绝，上传成功却生成 400）。
 */

describe('集成 · 模板管理（合同 / 采购 / 单据）', () => {
  let ctx: IntContext;
  let contractTpl: TemplateService;
  let procurementTpl: ProcurementTemplateService;
  let docTpl: DocTemplateService;
  let storage: StorageService;

  before(async () => {
    ctx = await bootIntApp();
    contractTpl = ctx.get<TemplateService>(TemplateService);
    procurementTpl = ctx.get<ProcurementTemplateService>(ProcurementTemplateService);
    docTpl = ctx.get<DocTemplateService>(DocTemplateService);
    storage = ctx.get<StorageService>(StorageService);
  });
  after(async () => {
    await ctx.app.close();
  });

  describe('合同模板：版本链 / 状态 / 删除', () => {
    it('新建接受 Y/N（归一为 1/0），编辑生成新版本且状态真的生效，删除整链', async () => {
      const user = { userId: 'int-user' };
      const created: any = await contractTpl.create(
        { name: uniq('合同模板'), categoryCode: 'PURCHASE_EXEC', content: '第一版 {{项目名称}}', status: 'Y' },
        user,
      );
      assert.equal(created.status, 1, 'Y 应归一为启用（1）');
      assert.equal(created.version, 1);

      const v2: any = await contractTpl.update(
        created.id,
        {
          name: created.name,
          categoryCode: 'PURCHASE_EXEC',
          content: '第二版',
          status: 0,
          version: created.version,
        },
        user,
      );
      assert.equal(v2.version, 2);
      assert.equal(v2.status, 0, '编辑时选停用应真的停用（改造前被强制改成启用）');

      const versions: any[] = await contractTpl.versions(v2.id);
      assert.equal(versions.length, 2, '版本历史应包含根版本与新版本');
      assert.equal(versions.find((r) => r.id === created.id)?.status, 0, '旧版本应被停用');

      // 过期 version 提交 → 乐观锁 409
      await assert.rejects(
        contractTpl.update(v2.id, { name: v2.name, categoryCode: 'PURCHASE_EXEC', version: 1 }, user),
        (e: any) => e instanceof ConflictException,
      );

      await contractTpl.remove(v2.id);
      const left = await ctx.prisma.contractTemplate.findMany({
        where: { OR: [{ id: created.id }, { parentId: created.id }] },
      });
      assert.equal(left.length, 0, '删除应移除整条版本链（与界面文案一致）');
    });
  });

  describe('采购模板：筛选 / 分页 / 状态校验 / 覆盖快照', () => {
    it('列表支持 keyword/moduleType/status 且返回 {list,total}；非法状态 400', async () => {
      const tag = uniq('采购模板');
      const a: any = await procurementTpl.create(
        { moduleType: 'NOTICE', templateName: `${tag}-公告`, content: '{{项目名称}}', variables: ['项目名称'], tags: '公告' },
        'u1',
      );
      await procurementTpl.create(
        { moduleType: 'DOCUMENT', templateName: `${tag}-文件`, content: '{{项目名称}}' },
        'u1',
      );

      const byKeyword: any = await procurementTpl.findAll({ keyword: tag, page: 1, pageSize: 10 });
      assert.equal(byKeyword.total, 2);
      assert.ok(Array.isArray(byKeyword.list));
      assert.equal(byKeyword.page, 1);

      const byType: any = await procurementTpl.findAll({ keyword: tag, moduleType: 'NOTICE' });
      assert.equal(byType.total, 1);
      assert.equal(byType.list[0].moduleType, 'NOTICE');

      await assert.rejects(
        procurementTpl.create(
          { moduleType: 'NOTICE', templateName: 'x', content: 'y', status: 2 as any },
          'u1',
        ),
        (e: any) => e instanceof BadRequestException,
      );

      // 同类型再次创建 = 覆盖，旧版本进入快照表
      // ⚠️ 采购模板是全局按 moduleType 唯一的，测试库不清理 → 版本号/快照数会跨次累加，
      //    这里断言「相对增量」而不是绝对数字。
      const versionsBefore = (await procurementTpl.versions(a.id)).length;
      const overwritten: any = await procurementTpl.create(
        { moduleType: 'NOTICE', templateName: `${tag}-公告v2`, content: '新版' },
        'u1',
      );
      assert.equal(overwritten.id, a.id);
      assert.equal(overwritten.version, a.version + 1);
      const versions: any[] = await procurementTpl.versions(a.id);
      assert.equal(versions.length, versionsBefore + 1);

      // 停用模板不应出现在 status=1 的查询里（导出取模板用的就是这条口径）
      await procurementTpl.update(a.id, { status: 0, version: overwritten.version }, 'u1');
      const enabled: any = await procurementTpl.findAll({ moduleType: 'NOTICE', status: 1 });
      assert.equal(enabled.total, 0);

      // 测试库不清理：恢复启用，避免影响后续用例/重复运行
      await procurementTpl.update(a.id, { status: 1, version: overwritten.version + 1 }, 'u1');
    });
  });

  describe('单据模板：文件键归一 + Excel 校验 + 生成', () => {
    async function makeXlsx(value: string): Promise<{ key: string; url: string }> {
      const wb = new ExcelJS.Workbook();
      wb.addWorksheet('单据').getCell('A1').value = value;
      const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
      return storage.save(buf, { ext: '.xlsx', sub: 'int-doc-templates' });
    }

    it('历史 URL 形态入库时归一为相对键，生成时能读盘并替换占位符', async () => {
      const saved = await makeXlsx('编号：{{单据编号}}');
      const docName = uniq('单据模板');
      const created: any = await docTpl.create(
        {
          name: docName,
          categoryCode: 'SETTLEMENT',
          status: 1,
          fileUrl: saved.url, // 模拟历史前端：存的是 /api/files/... 公开 URL
          fileName: '结算单模板.xlsx',
        },
        '',
        { userId: 'u1' },
      );
      const row = await ctx.prisma.contractTemplate.findUnique({ where: { id: created.id } });
      assert.equal(row?.fileUrl, saved.key, '落库必须是相对键，不能是 /api/files/... URL');

      // 合同模板列表必须排除单据分类（两套模板共用一张表）
      const contractList: any = await contractTpl.findAll({ keyword: docName });
      assert.equal(contractList.total, 0, '单据模板不应出现在合同模板列表里');

      // findOne 输出也应是相对键（前端展示时再补一次前缀）
      const detail: any = await docTpl.findOne(created.id);
      assert.equal(detail.fileUrl, saved.key);

      const { buffer, pending } = await docTpl.renderExcel({
        categoryCode: 'SETTLEMENT',
        categoryLabel: '结算单',
        values: { 单据编号: 'JS-001' },
        filename: 'x.xlsx',
      });
      assert.equal(pending.length, 0);
      assert.equal(buffer.subarray(0, 2).toString(), 'PK', '输出应是 xlsx（zip）');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer as any);
      assert.equal(wb.worksheets[0].getCell('A1').value, '编号：JS-001');
    });

    it('非 .xlsx / 损坏文件 / 不存在的文件一律 400', async () => {
      const saved = await makeXlsx('x');
      await assert.rejects(
        docTpl.create(
          { name: uniq('坏模板'), categoryCode: 'SETTLEMENT', fileUrl: saved.key, fileName: 'bad.docx' },
          '',
          { userId: 'u1' },
        ),
        (e: any) => e instanceof BadRequestException,
      );

      const corrupt = await storage.save(Buffer.from('not an excel'), {
        ext: '.xlsx',
        sub: 'int-doc-templates',
      });
      await assert.rejects(
        docTpl.create(
          { name: uniq('坏模板'), categoryCode: 'SETTLEMENT', fileUrl: corrupt.key, fileName: 'corrupt.xlsx' },
          '',
          { userId: 'u1' },
        ),
        (e: any) => e instanceof BadRequestException,
      );

      await assert.rejects(
        docTpl.create(
          { name: uniq('坏模板'), categoryCode: 'SETTLEMENT', fileUrl: '2026-10/not-exists.xlsx', fileName: 'x.xlsx' },
          '',
          { userId: 'u1' },
        ),
        (e: any) => e instanceof BadRequestException,
      );
    });
  });
});

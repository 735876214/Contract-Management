import { PrismaClient } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { StorageService } from '../../common/services/storage.service';

/**
 * 「分包材料员授权信息表」导出（附件需求 2026-10-17 修正 6）：
 * **签字截图 / 身份证照片直接嵌进单元格**（exceljs `addImage`），不把照片单独导出成文件。
 * 表样（用户提供截图）：序号 | 施工单位 | 法人代表 | 授权委托人 | (授权材料员签字 + 身份证) × 4 组。
 *
 * 数据源 = `LaborAuthLedger` 自身（原分包商库已并入本表，2026-10-17；不再 join 旧档案表）。
 * ⚠️ 现有字段一行只有 1 名材料员（signatureScreenshot + idCardFront），
 * 表样的"材料员 2/3/4"列在数据不足时留空；是否扩成多材料员子表由业务确认后再改。
 */

const storage = new StorageService();

/** 单行要嵌的图片（StorageService 键 → 缩放到单元格宽高） */
const CELL_W = 110;
const CELL_H = 64;

export async function exportLaborAuthWorkbook(prisma: PrismaClient, projectId: string): Promise<Buffer> {
  const rows = await prisma.laborAuthLedger.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('分包材料员授权信息表', { views: [{ state: 'frozen', ySplit: 2 }] });
  const headers = [
    '序号', '施工单位', '法人代表', '授权委托人',
    '授权材料员签字 1', '授权材料员身份证 1',
    '授权材料员签字 2', '授权材料员身份证 2',
    '授权材料员签字 3', '授权材料员身份证 3',
    '授权材料员签字 4', '授权材料员身份证 4',
  ];
  // 标题行（A1:L1 合并）
  ws.mergeCells(1, 1, 1, headers.length);
  const title = ws.getCell(1, 1);
  title.value = '分包材料员授权信息表';
  title.font = { size: 16, bold: true };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).values = headers;
  ws.getRow(2).font = { bold: true };
  ws.getRow(2).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  ws.getRow(2).height = 42;
  ws.columns.forEach((c, i) => (c.width = i === 0 ? 6 : i <= 3 ? 22 : CELL_W / 7));

  let r = 3;
  for (const row of rows) {
    ws.getRow(r).values = [
      r - 2,
      row.subcontractorName,
      row.legalPerson ?? '',
      row.authorizedPerson ?? '',
    ];
    ws.getRow(r).height = CELL_H + 8;
    r += 1;
    // 嵌图：材料员 1（现有字段只有一名材料员），签字截图 + 身份证正面
    let col = 5;
    for (const key of [row.signatureScreenshot, row.idCardFront].filter(Boolean) as string[]) {
      try {
        const buf = await storage.read(normalizeKey(key));
        const ext = guessExt(key);
        const imageId = wb.addImage({ buffer: buf as unknown as ExcelJS.Buffer, extension: ext });
        ws.addImage(imageId, {
          tl: { col: col - 1 + 0.05, row: r - 1 + 0.05 },
          ext: { width: CELL_W, height: CELL_H },
        });
      } catch {
        // 图片缺失/损坏：留空单元格，不阻断整个导出
      }
      col += 2;
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 档案里存的可能是完整 URL（/api/files/<键>），归一成相对键 */
function normalizeKey(urlOrKey: string): string {
  const s = String(urlOrKey || '');
  const i = s.indexOf('/api/files/');
  return i >= 0 ? s.slice(i + '/api/files/'.length) : s.replace(/^\//, '');
}

function guessExt(keyOrName: string): 'jpeg' | 'png' | 'gif' {
  const name = String(keyOrName || '').toLowerCase();
  if (name.endsWith('.png')) return 'png';
  if (name.endsWith('.gif')) return 'gif';
  return 'jpeg';
}

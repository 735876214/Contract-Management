import ExcelJS from 'exceljs';
import { BadRequestException } from '@nestjs/common';
import { amountToChineseCapital } from '@cms/calc/money';
import { FINAL_SETTLEMENT_TEMPLATE_BASE64 } from './final-settlement-template';

/**
 * 总结算书（《物资结算书》CSCEC-SW-B40806）Excel 渲染。
 *
 * 版式固定来自内置模板 `assets/final-settlement-template.xlsx`（5 个 sheet，见 final-settlement-template.ts）：
 *  - `总结算书`：主表。明细槽位固定 **行 8..43（36 行）**，合计行 **44**，审减行 **47**（审减金额 D47，审定金额 J47=I44-D47）。
 *  - 其余 4 个 sheet（供应商满意度调查表 / 合规性检查表 / 供应商考核评价表 / 封面第一册）通过跨表公式
 *    引用 `总结算书!D5/D6/I4/I44`，填好主表即自动带出。
 *
 * 为什么「固定 36 行 + 隐藏未用行」，而不是运行期插行：ExcelJS 的 `spliceRows` 不会平移合并单元格、
 * 插入行无样式（见方案调研）。固定槽位只在「用了几行」上做隐藏，版式/样式/合并全部原样保留。
 */

const SHEET = '总结算书';
const DETAIL_START = 8; // 首个明细行
/** 明细槽位总数：模板固定预留这么多行，超出即无法容纳（导出会丢行），故作为硬上限 */
export const FINAL_SETTLEMENT_MAX_ITEMS = 36;
const DETAIL_K = FINAL_SETTLEMENT_MAX_ITEMS;
const DETAIL_LAST = DETAIL_START + DETAIL_K - 1; // 43
const HROW = DETAIL_START + DETAIL_K; // 合计行 44
const REDUCE_ROW = 47; // 审减行

export interface FinalSettlementRenderDoc {
  code?: string | null;
  totalAmount?: any;
  reduceAmount?: any;
  items?: Array<{ settleMonth?: string | null; amount?: any }>;
}

export interface FinalSettlementRenderInput {
  doc: FinalSettlementRenderDoc;
  contract?: { code?: string | null; name?: string | null; amount?: any } | null;
  project?: { name?: string | null } | null;
  supplier?: { name?: string | null } | null;
  /** 结算书编号（表头 I6），形如 TMHB-项目编号-WZZJS-结算年份-流水号 */
  docNumber?: string | null;
}

function toNumber(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM' → 该月 1 号（UTC 正午，避免时区导致的月份漂移）。 */
function monthFirstDate(month: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})/.exec(String(month ?? ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!y || mo < 1 || mo > 12) return null;
  return new Date(Date.UTC(y, mo - 1, 1, 12, 0, 0));
}

function setText(ws: ExcelJS.Worksheet, addr: string, value: string | null | undefined) {
  ws.getCell(addr).value = value && String(value).trim() ? String(value).trim() : null;
}

export async function renderFinalSettlementXlsx(
  input: FinalSettlementRenderInput,
): Promise<{ buffer: Buffer; filename: string }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(FINAL_SETTLEMENT_TEMPLATE_BASE64, 'base64') as any);
  // 打开即重算所有公式（合计/大写/审定金额/各 sheet 跨表引用），否则 Excel 打开可能显示缓存空值
  wb.calcProperties.fullCalcOnLoad = true;

  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`总结算书模板缺少工作表「${SHEET}」`);

  const { doc, contract, project, supplier } = input;

  // —— 表头 —— //
  setText(ws, 'I4', contract?.name); // 合同名称
  setText(ws, 'I5', contract?.code); // 合同编号
  const contractAmount = toNumber(contract?.amount);
  setText(
    ws,
    'L4',
    contractAmount !== null
      ? `合同额 ${contractAmount.toLocaleString('zh-CN', { useGrouping: false, maximumFractionDigits: 2 })} 元`
      : null,
  );
  setText(ws, 'D5', supplier?.name); // 供方
  setText(ws, 'D6', project?.name); // 项目名称
  setText(ws, 'I6', input.docNumber); // 编号
  // D4 需方（中国建筑第八工程局有限公司）为常量，模板内保留，不覆盖

  // —— 明细 —— //
  const items = Array.isArray(doc.items) ? doc.items : [];
  if (items.length > DETAIL_K) {
    throw new BadRequestException(`结算明细最多 ${DETAIL_K} 行，当前 ${items.length} 行，无法导出（模板槽位固定）`);
  }
  for (let i = 0; i < DETAIL_K; i += 1) {
    const row = DETAIL_START + i;
    const item = items[i];
    const r = ws.getRow(row);
    if (item) {
      r.hidden = false;
      ws.getCell(`A${row}`).value = i + 1; // 序号
      const d = monthFirstDate(item.settleMonth);
      ws.getCell(`D${row}`).value = d as any; // 供货月份
      const amt = toNumber(item.amount);
      ws.getCell(`G${row}`).value = amt; // 供货金额
    } else {
      r.hidden = true;
      ws.getCell(`A${row}`).value = null;
      ws.getCell(`D${row}`).value = null;
      ws.getCell(`G${row}`).value = null;
    }
  }

  // —— 审减金额（手填） —— //
  const reduce = toNumber(doc.reduceAmount);
  ws.getCell(`D${REDUCE_ROW}`).value = reduce ?? 0;

  // 合计行（含 SUM 公式）保持在 HROW
  ws.getCell(`I${HROW}`).value = { formula: `SUM(G${DETAIL_START}:G${DETAIL_LAST})` } as any;

  // 合计大写：模板用 [dbnum2] 公式，但该格式在 LibreOffice/WPS 等非 Excel 环境不一定重算正确，
  // 因此这里直接用服务端口径算出大写金额写死（与参考表 Excel 计算值完全一致），无论用哪个软件打开都对。
  const totalForCapital = toNumber(doc.totalAmount) ?? items.reduce((t, it) => t + (toNumber(it.amount) || 0), 0);
  ws.getCell(`D${HROW}`).value = amountToChineseCapital(totalForCapital);

  const out = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(out as ArrayBuffer),
    filename: `${doc.code || '总结算书'}.xlsx`,
  };
}

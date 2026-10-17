/**
 * **总结算单模板变量**（单据模板的「总结算单」类，业务口径 2026-10-16）。
 *
 * 与付款单变量同一套路（见 `doc-template-vars.ts`）：纯函数、前后端镜像
 * （前端在 `web/src/constants/docVariables.ts`），由 `docVariables.spec.mts` 锁「变量名逐条一致」。
 *
 * ⚠️ 金额类变量名必须带单位后缀 `(元)`。
 * ⚠️ 明细表是**生成时的快照**（月度结算事后被改，不回头改已出的总结算单）。
 * 共享的 `DocVarDef` / 格式化函数在 `../doc-template/doc-var-shared.ts`（2026-10-17 收敛）。
 */

import { type DocVarDef, formatDocMoney, formatDocDate } from '../doc-template/doc-var-shared.ts';

export { formatDocMoney as formatMoney, formatDocDate as formatDate };
export type { DocVarDef };

export const FINAL_SETTLEMENT_DOC_VARIABLES: DocVarDef[] = [
  { name: '单据编号', desc: '总结算单编号' },
  { name: '供应商名称', desc: '取自合同关联的供应商' },
  { name: '合同编号', desc: '' },
  { name: '合同名称', desc: '' },
  { name: '总结算金额(元)', desc: '全部月度结算金额合计（生成时快照）' },
  { name: '结算月数', desc: '纳入总结算的月度结算期数' },
  { name: '结算明细表', desc: '月度结算明细表格（按月份列出金额）' },
  { name: '附件名称', desc: '上传的总结算附件文件名；未上传时保留占位符' },
  { name: '项目名称', desc: '' },
  { name: '项目简称', desc: '' },
  { name: '项目编码', desc: '' },
  { name: '备注', desc: '' },
  { name: '打印日期', desc: '生成单据的当天' },
];

/** 明细行（生成时抓到的月度结算快照） */
export interface FinalSettlementItemLike {
  settleMonth: string;
  amount?: unknown;
}

/** 月度结算明细表（HTML 表格；`table` 占位符 `{{结算明细表}}` 用它替换） */
export function buildItemsTable(items: FinalSettlementItemLike[]): string {
  const head = '<tr><th style="border:1px solid #999;padding:4px">结算月份</th><th style="border:1px solid #999;padding:4px">结算金额(元)</th></tr>';
  const body = (items || [])
    .map(
      (i) =>
        `<tr><td style="border:1px solid #999;padding:4px">${i.settleMonth || ''}</td>` +
        `<td style="border:1px solid #999;padding:4px">${formatDocMoney(i.amount)}</td></tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse">${head}${body}</table>`;
}

export interface FinalSettlementDocValuesInput {
  doc: {
    code?: string | null;
    totalAmount?: unknown;
    attachmentName?: string | null;
    remark?: string | null;
    items?: FinalSettlementItemLike[];
  };
  contract?: { code?: string | null; name?: string | null } | null;
  supplier?: { name?: string | null } | null;
  project?: { name?: string | null; nameAbbr?: string | null; code?: string | null } | null;
  now?: Date;
}

export function buildFinalSettlementDocValues(input: FinalSettlementDocValuesInput): Record<string, string> {
  const d = input.doc || {};
  const items = d.items || [];
  return {
    单据编号: String(d.code ?? ''),
    供应商名称: String(input.supplier?.name ?? ''),
    合同编号: String(input.contract?.code ?? ''),
    合同名称: String(input.contract?.name ?? ''),
    '总结算金额(元)': formatDocMoney(d.totalAmount),
    结算月数: String(items.length),
    附件名称: String(d.attachmentName ?? ''),
    项目名称: String(input.project?.name ?? ''),
    项目简称: String(input.project?.nameAbbr ?? ''),
    项目编码: String(input.project?.code ?? ''),
    备注: String(d.remark ?? ''),
    打印日期: formatDocDate(input.now ?? new Date()),
  };
}

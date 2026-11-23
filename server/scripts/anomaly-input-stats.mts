/**
 * 量化「结算/付款异常预警」的取数成本（**只读**，不改任何表、不调 LLM）。
 *
 * 用法（在 `server/` 下）：
 *   npm run stats:anomaly-input -- --project <项目id> [--from 2026-01-01] [--to 2026-12-31]
 *   npm run stats:anomaly-input -- --all [--json]
 *
 * 为什么要有它：`ai/anomaly/anomaly.service.ts` 的 9 处取数是**行级规则**（跨期累计、清单重合度、
 * 单笔与累计先后），不能换 `groupBy`（会静默失效）。要决定「缩小取数范围」还是「事实层物化」，
 * 得先知道**最坏项目**到底搬多少行、多少字节、跑多久——这些数字只能在有真实数据的环境里量。
 *
 * 口径与线上**完全共用** `anomaly-dataset.ts` 的 `buildAnomalyWhere` / `ANOMALY_SELECT` /
 * `ANOMALY_ORDER`，所以量出来的就是线上那条路径（含规则本身的耗时）。
 */
import { PrismaClient } from '@prisma/client';

import {
  ANOMALY_ORDER,
  ANOMALY_SELECT,
  buildAnomalyWhere,
  buildPaymentAnomalyInput,
  type AnomalyRows,
} from '../src/modules/ai-insight/anomaly/anomaly-dataset.ts';
import { evaluatePaymentAnomalies } from '../src/modules/ai-insight/anomaly/rules-payment.ts';
import { ANOMALY_PARAM_KEY_LIST, parseAnomalyConfig } from '../src/modules/ai-insight/anomaly/anomaly-config.ts';

interface Args {
  project?: string;
  all: boolean;
  from?: string;
  to?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf('--' + name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = argv.includes('--all');
  const project = get('project');
  if (!project && !all) {
    throw new Error('要么给 --project <项目id>，要么给 --all（逐项目统计，不跨项目混算）');
  }
  return { project, all, from: get('from'), to: get('to'), json: argv.includes('--json') };
}

function parseDay(raw: string | undefined, label: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(label + ' 不是合法日期：' + raw);
  return d;
}

/** 与线上 collect() 同口径：起点零点、终点当日 23:59:59.999 */
const dayStart = (d: Date | null): Date | null =>
  d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0) : null;
const dayEnd = (d: Date | null): Date | null =>
  d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999) : null;

const TABLE_LABELS: Record<keyof AnomalyRows, string> = {
  contracts: '合同',
  settlements: '结算单（区间内）',
  cumulativeSettlements: '结算单（累计）',
  payments: '付款流水',
  invoices: '发票',
  procedures: '付款手续',
  receipts: '收领单',
  finalSettlementItems: '总结算明细',
  materialRows: '合同物资行',
};

async function readConfig(prisma: PrismaClient) {
  const rows = await prisma.sysParam.findMany({ where: { key: { in: ANOMALY_PARAM_KEY_LIST } } });
  const byKey = new Map(rows.map((r) => [r.key, r.value ?? undefined]));
  const raw: Record<string, string | undefined> = {};
  for (const k of ANOMALY_PARAM_KEY_LIST) raw[k] = byKey.get(k) || undefined;
  return parseAnomalyConfig(raw);
}

async function measureProject(prisma: PrismaClient, projectId: string, range: { from: Date | null; to: Date | null }) {
  const rangeObj = { from: range.from, to: range.to, contractId: null, contractIds: null };
  const w = buildAnomalyWhere(rangeObj, projectId);

  const timed = async <T>(label: string, run: () => Promise<T[]>) => {
    const t0 = performance.now();
    const rows = await run();
    const ms = performance.now() - t0;
    const bytes = Buffer.byteLength(JSON.stringify(rows), 'utf8');
    return { label, rows: rows.length, ms, bytes, data: rows };
  };

  // 顺序发 9 条查询（线上是 Promise.all 并发，单条耗时更能说明"哪张表在拖"）
  const contracts = await timed('contracts', () => prisma.contract.findMany({ where: w.contractWhere, select: ANOMALY_SELECT.contract }) as any);
  const settlements = await timed('settlements', () => prisma.settlement.findMany({ where: w.settlementWhere, select: ANOMALY_SELECT.settlement, orderBy: ANOMALY_ORDER.settlement as any }) as any);
  const cumulativeSettlements = await timed('cumulativeSettlements', () => prisma.settlement.findMany({ where: w.settlementCumulativeWhere, select: ANOMALY_SELECT.settlement, orderBy: ANOMALY_ORDER.settlement as any }) as any);
  const payments = await timed('payments', () => prisma.paymentRecord.findMany({ where: w.paymentWhere, select: ANOMALY_SELECT.payment, orderBy: ANOMALY_ORDER.payment as any }) as any);
  const invoices = await timed('invoices', () => prisma.invoice.findMany({ where: w.invoiceWhere, select: ANOMALY_SELECT.invoice }) as any);
  const procedures = await timed('procedures', () => prisma.paymentProcedure.findMany({ where: w.procedureWhere, select: ANOMALY_SELECT.procedure, orderBy: ANOMALY_ORDER.procedure as any }) as any);
  const receipts = await timed('receipts', () => prisma.receiptOrder.findMany({ where: w.receiptWhere, select: ANOMALY_SELECT.receipt }) as any);
  const finalSettlementItems = await timed('finalSettlementItems', () => prisma.finalSettlementItem.findMany({ where: w.finalSettlementItemWhere, select: ANOMALY_SELECT.finalSettlementItem }) as any);
  const materialRows = await timed('materialRows', () => prisma.contractMaterial.findMany({ where: w.contractMaterialWhere, select: ANOMALY_SELECT.contractMaterial }) as any);

  const parts = [contracts, settlements, cumulativeSettlements, payments, invoices, procedures, receipts, finalSettlementItems, materialRows];
  const memAfterFetch = process.memoryUsage();

  // 规则本身的耗时（纯函数：形状搬运 + 9 条规则）
  const t0 = performance.now();
  const dataset = buildPaymentAnomalyInput(
    {
      contracts: contracts.data,
      settlements: settlements.data,
      cumulativeSettlements: cumulativeSettlements.data,
      payments: payments.data,
      invoices: invoices.data,
      procedures: procedures.data,
      receipts: receipts.data,
      finalSettlementItems: finalSettlementItems.data,
      materialRows: materialRows.data,
    } as AnomalyRows,
    rangeObj,
  );
  const evalResult = evaluatePaymentAnomalies(dataset.input);
  const ruleMs = performance.now() - t0;
  const memAfterRules = process.memoryUsage();

  return {
    projectId,
    tables: parts.map((p) => ({ label: TABLE_LABELS[p.label as keyof AnomalyRows], table: p.label, rows: p.rows, ms: Number(p.ms.toFixed(1)), kb: Number((p.bytes / 1024).toFixed(1)) })),
    totalRows: parts.reduce((s, p) => s + p.rows, 0),
    totalKb: Number((parts.reduce((s, p) => s + p.bytes, 0) / 1024).toFixed(1)),
    queryMs: Number(parts.reduce((s, p) => s + p.ms, 0).toFixed(1)),
    ruleMs: Number(ruleMs.toFixed(1)),
    findings: evalResult.findings.length,
    // 峰值内存（本次进程按 9 张表全量驻留的近似值：堆 + 外部）
    memMb: Number(((memAfterRules.heapUsed + memAfterRules.external) / 1024 / 1024).toFixed(1)),
    memAfterFetchMb: Number(((memAfterFetch.heapUsed + memAfterFetch.external) / 1024 / 1024).toFixed(1)),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    await readConfig(prisma); // 顺带校验参数表可读（与线上同源，本脚本不使用其值）
    const range = { from: dayStart(parseDay(args.from, '--from')), to: dayEnd(parseDay(args.to, '--to')) };
    const projects = args.all
      ? await prisma.project.findMany({ select: { id: true, code: true, name: true } })
      : await prisma.project.findMany({ where: { id: args.project }, select: { id: true, code: true, name: true } });
    if (!projects.length) throw new Error('没有匹配的项目：' + (args.project || '(all)'));

    const results = [];
    for (const p of projects) {
      const m = await measureProject(prisma, p.id, range);
      results.push({ project: p.code + ' / ' + p.name, ...m });
    }
    results.sort((a, b) => b.totalRows - a.totalRows);

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      for (const r of results) {
        console.log('');
        console.log('[项目] ' + r.project + '  (' + r.projectId + ')');
        for (const t of r.tables) console.log('  ' + t.label.padEnd(16, ' ') + String(t.rows).padStart(8) + ' 行  ' + String(t.kb).padStart(9) + ' KB  ' + String(t.ms).padStart(7) + ' ms');
        console.log('  ' + '合计'.padEnd(16, ' ') + String(r.totalRows).padStart(8) + ' 行  ' + String(r.totalKb).padStart(9) + ' KB  ' + String(r.queryMs).padStart(7) + ' ms（查询） + ' + r.ruleMs + ' ms（规则）');
        console.log('  规则命中：' + r.findings + ' 条；进程内存：' + r.memAfterFetchMb + ' MB（取数后）→ ' + r.memMb + ' MB（判定后）');
      }
      console.log('');
      console.log('提示：行数最多的是「' + (results[0] ? results[0].project : '-') + '」，共 ' + (results[0] ? results[0].totalRows : 0) + ' 行 / ' + (results[0] ? results[0].totalKb : 0) + ' KB。');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[stats:anomaly-input] 失败：', e && e.message ? e.message : e);
  process.exit(1);
});

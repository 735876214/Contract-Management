/**
 * 导出「结算/付款异常预警」评测数据集（**只读**，不改任何表）。
 *
 * 用法（在 `server/` 下）：
 *   npm run anomaly:export -- --project <项目id> [--out tmp/anomaly-dataset.json] [--from 2026-01-01] [--to 2026-12-31] [--contract <合同id>]
 *
 * 为什么要有这个脚本：
 * 规则层的召回率最终必须用**真实单据**验证，而真实单据只存在于有业务数据的环境里。
 * 之前数据库不可达、生产库又是空表，所以只能跑合成夹具；一旦有人能在有数据的环境执行，
 * 这条命令就能把「取数 → 判定 → 人工标注 → 评分」串起来，无需改代码。
 *
 * 取数形状与线上接口**共用** `anomaly-dataset.ts`，因此评测对象就是线上跑的那套规则。
 */
import { PrismaClient } from '@prisma/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import {
  ANOMALY_ORDER,
  ANOMALY_SELECT,
  buildAnomalyWhere,
  buildPaymentAnomalyInput,
  type AnomalyRows,
} from '../src/modules/ai/anomaly/anomaly-dataset.ts';
import { evaluatePaymentAnomalies } from '../src/modules/ai/anomaly/rules-payment.ts';
import { centsToYuan } from '../src/modules/ai/anomaly/anomaly-types.ts';
import { ANOMALY_PARAM_KEY_LIST, parseAnomalyConfig } from '../src/modules/ai/anomaly/anomaly-config.ts';

interface Args {
  project: string;
  out: string;
  from?: string;
  to?: string;
  contract?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const project = get('project');
  if (!project) {
    throw new Error('缺少 --project <项目id>（本脚本刻意不提供"导出全库"模式：跨项目混算会让口径失真）');
  }
  return {
    project,
    out: get('out') ?? 'tmp/anomaly-dataset.json',
    from: get('from'),
    to: get('to'),
    contract: get('contract'),
  };
}

function parseDay(raw: string | undefined, label: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} 不是合法日期：${raw}`);
  return d;
}

/** 与线上 `anomaly.service.collect()` 同口径：起点零点、终点当日 23:59:59.999 */
function dayStart(d: Date | null): Date | null {
  return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0) : null;
}
function dayEnd(d: Date | null): Date | null {
  return d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999) : null;
}

/** 读系统参数并解析成与线上完全相同的配置（容差/开关都按库里配置，不从代码默认值来） */
async function readAnomalyConfig(prisma: PrismaClient) {
  const rows = await prisma.sysParam.findMany({ where: { key: { in: ANOMALY_PARAM_KEY_LIST } } });
  const byKey = new Map(rows.map((r) => [r.key, r.value ?? undefined]));
  const raw: Record<string, string | undefined> = {};
  for (const k of ANOMALY_PARAM_KEY_LIST) raw[k] = byKey.get(k) || undefined;
  return parseAnomalyConfig(raw);
}

/** 下钻合同时补齐整条补充协议链（与线上 `resolveChainIds` 同口径） */
async function resolveChainIds(prisma: PrismaClient, projectId: string, contractId: string | null) {
  if (!contractId) return null;
  const seed = await prisma.contract.findFirst({
    where: { id: contractId, projectId },
    select: { id: true, parentContractId: true },
  });
  if (!seed) throw new Error(`合同不存在或不属于项目 ${projectId}：${contractId}`);
  const ids = new Set<string>([seed.id]);
  let cursor: string | null = seed.parentContractId ?? null;
  for (let depth = 0; cursor && depth < 32; depth += 1) {
    const parent = await prisma.contract.findFirst({
      where: { id: cursor, projectId },
      select: { id: true, parentContractId: true },
    });
    if (!parent || ids.has(parent.id)) break;
    ids.add(parent.id);
    cursor = parent.parentContractId ?? null;
  }
  let frontier = [...ids];
  for (let depth = 0; frontier.length && depth < 32; depth += 1) {
    const children = await prisma.contract.findMany({
      where: { projectId, parentContractId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((c) => c.id).filter((id) => !ids.has(id));
    for (const id of frontier) ids.add(id);
  }
  return [...ids];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) {
    // Prisma 在拿不到连接串时会直接吐一屏 validation dump，对使用者毫无指向性
    throw new Error(
      '未检测到 DATABASE_URL：先把后端使用的连接串放进环境变量（如 `set -a && source .env && set +a`），再重跑本脚本',
    );
  }
  const from = dayStart(parseDay(args.from, '--from'));
  const to = dayEnd(parseDay(args.to, '--to'));
  if (from && to && from > to) throw new Error('--from 不能晚于 --to');

  const prisma = new PrismaClient();
  try {
    const chainIds = await resolveChainIds(prisma, args.project, args.contract ?? null);
    const w = buildAnomalyWhere({ from, to, contractId: args.contract ?? null, contractIds: chainIds }, args.project);
    const [
      contracts,
      settlements,
      cumulativeSettlements,
      payments,
      invoices,
      procedures,
      receipts,
      finalSettlementItems,
      materialRows,
    ] = await Promise.all([
      prisma.contract.findMany({ where: w.contractWhere, select: ANOMALY_SELECT.contract }),
      prisma.settlement.findMany({
        where: w.settlementWhere,
        select: ANOMALY_SELECT.settlement,
        orderBy: ANOMALY_ORDER.settlement as any,
      }),
      // 累计口径：区间之前的结算单也要，否则 R2/R4/R6 的分母被区间裁窄
      prisma.settlement.findMany({
        where: w.settlementCumulativeWhere,
        select: ANOMALY_SELECT.settlement,
        orderBy: ANOMALY_ORDER.settlement as any,
      }),
      prisma.paymentRecord.findMany({
        where: w.paymentWhere,
        select: ANOMALY_SELECT.payment,
        orderBy: ANOMALY_ORDER.payment as any,
      }),
      prisma.invoice.findMany({ where: w.invoiceWhere, select: ANOMALY_SELECT.invoice }),
      prisma.paymentProcedure.findMany({
        where: w.procedureWhere,
        select: ANOMALY_SELECT.procedure,
        orderBy: ANOMALY_ORDER.procedure as any,
      }),
      prisma.receiptOrder.findMany({ where: w.receiptWhere, select: ANOMALY_SELECT.receipt }),
      prisma.finalSettlementItem.findMany({
        where: w.finalSettlementItemWhere,
        select: ANOMALY_SELECT.finalSettlementItem,
      }),
      prisma.contractMaterial.findMany({
        where: w.contractMaterialWhere,
        select: ANOMALY_SELECT.contractMaterial,
      }),
    ]);

    const rows: AnomalyRows = {
      contracts: contracts as any[],
      settlements: settlements as any[],
      cumulativeSettlements: cumulativeSettlements as any[],
      payments: payments as any[],
      invoices: invoices as any[],
      procedures: procedures as any[],
      receipts: receipts as any[],
      finalSettlementItems: finalSettlementItems as any[],
      materialRows: materialRows as any[],
    };

    // 容差与开关必须读**系统参数**：线上是按库里配置判的，脚本用默认值就会得出另一套结论
    const cfg = await readAnomalyConfig(prisma);
    const { input, sample } = buildPaymentAnomalyInput(rows, { from, to, contractId: args.contract ?? null });
    const evaluation = evaluatePaymentAnomalies({ ...input, tolerances: cfg.tolerances });

    const payload = {
      meta: {
        projectId: args.project,
        from: args.from ?? null,
        to: args.to ?? null,
        contractId: args.contract ?? null,
        contractIds: chainIds,
        exportedAt: new Date().toISOString(),
        sample,
        tolerances: {
          amount: centsToYuan(cfg.tolerances.amount),
          qtyPct: cfg.tolerances.qtyPct,
          jaccard: cfg.tolerances.jaccard,
        },
        enabled: cfg.enabled,
        problems: cfg.problems,
        note: 'rows 是原始取数（评分脚本会用它重算规则，保证评测对象 = 线上代码）；candidates 是规则初判，只供标注时参考，不得直接采信。',
      },
      rows,
      input,
      candidates: evaluation.findings.map((f) => ({
        code: f.code,
        level: f.level,
        entityId: f.entityId,
        title: f.title,
      })),
      notEvaluated: evaluation.notEvaluated,
    };

    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

    console.log(`已导出 ${outPath}`);
    console.log(`样本量：${Object.entries(sample).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
    console.log(`规则初判：${evaluation.findings.length} 条（高风险 ${evaluation.summary.high} 条）`);
    if (evaluation.notEvaluated.length > 0) {
      console.log(`未判定：${evaluation.notEvaluated.length} 项（${evaluation.notEvaluated[0]}${evaluation.notEvaluated.length > 1 ? ' …' : ''}）`);
    }
    console.log('');
    console.log('下一步（人工标注，禁止直接采信规则初判）：');
    console.log('  1) 复制 candidates 到 tmp/anomaly-truth.json 的 annotations，逐条把 hit 改成 true/false 并写 note；');
    console.log('  2) 补充 candidates 里没有、但你知道确实异常的单据（entityId 用单据 id）；');
    console.log('  3) npm run anomaly:score -- --dataset ' + args.out + ' --truth tmp/anomaly-truth.json');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: any) => {
  console.error(`导出失败：${err?.message ?? err}`);
  process.exitCode = 1;
});

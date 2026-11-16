/**
 * 用人工标注的真值文件，给「结算/付款异常预警」出召回率/误报报告（**只读**，不连数据库）。
 *
 * 用法（在 `server/` 下）：
 *   npm run anomaly:score -- --dataset tmp/anomaly-dataset.json --truth tmp/anomaly-truth.json \
 *     [--min-recall 0.9] [--max-fp 2] [--out docs/评测报告-结算异常.md]
 *
 * 关键设计：**用 `rows` 重算规则**，而不是信数据集里的 `candidates`。
 * 这样"评测报告"永远描述当前代码的行为——代码改了但没重跑导出的情况会被立刻暴露，
 * 而不是拿一份旧初判冒充新结果（这是评测最容易自欺的一步）。
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { buildPaymentAnomalyInput, type AnomalyRows } from '../src/modules/ai/anomaly/anomaly-dataset.ts';
import { evaluatePaymentAnomalies } from '../src/modules/ai/anomaly/rules-payment.ts';
import { gateStatus, parseTruth, scoreFindings, scoreToMarkdown, type ScoreMeta } from '../src/modules/ai/anomaly/anomaly-score.ts';

interface Args {
  dataset: string;
  truth: string;
  minRecall: number;
  maxFp: number;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dataset = get('dataset');
  const truth = get('truth');
  if (!dataset || !truth) {
    throw new Error('用法：--dataset <导出的 json> --truth <真值 json> [--min-recall 0.9] [--max-fp 2] [--out <md>]');
  }
  const num = (raw: string | undefined, def: number, label: string): number => {
    if (raw == null) return def;
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${label} 必须是数字：${raw}`);
    return v;
  };
  return {
    dataset,
    truth,
    minRecall: num(get('min-recall'), 0.9, '--min-recall'),
    maxFp: num(get('max-fp'), 2, '--max-fp'),
    out: get('out'),
  };
}

function readJson(path: string, label: string): any {
  const abs = resolve(path);
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    throw new Error(`${label} 读不到：${abs}`);
  }
  try {
    return JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${label} 不是合法 JSON：${abs}（${err?.message ?? err}）`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dataset = readJson(args.dataset, '数据集');
  const truthRaw = readJson(args.truth, '真值');
  const truth = parseTruth(truthRaw);

  if (!dataset?.meta?.sample) throw new Error('数据集缺少 meta.sample：请用 npm run anomaly:export 重新导出');
  const rows = dataset.rows as AnomalyRows | undefined;
  if (!rows) throw new Error('数据集缺少 rows：评分必须重算规则，不接受只有 candidates 的文件');

  // 评分必须用**导出时同一套口径**重算：窗口（区间/单合同）与容差都从数据集 meta 里取，
  // 否则「线上有区间、评分没有」会让 R3 之类按窗口裁剪的规则得出另一套结论。
  // 日期必须还原成**本地当日起止**——导出侧写的是 dayStart/dayEnd，
  // 这里若用 `new Date('YYYY-MM-DD')`（UTC 零点）在负时区会整体错一天
  const dayStart = (raw?: string | null): Date | null => {
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error(`数据集 meta 里的日期不合法：${raw}`);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  };
  const dayEnd = (raw?: string | null): Date | null => {
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new Error(`数据集 meta 里的日期不合法：${raw}`);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  };
  const range = {
    from: dayStart(dataset.meta.from),
    to: dayEnd(dataset.meta.to),
    contractId: dataset.meta.contractId ?? null,
    contractIds: Array.isArray(dataset.meta.contractIds) ? dataset.meta.contractIds : null,
  };
  if (dataset.meta.enabled === false) {
    // 线上停用时接口直接返回空命中，拿停用期导出的数据算召回率没有意义
    console.warn(
      '⚠ 导出时预警在系统参数里处于**停用**状态：该数据集不代表线上行为（线上会直接返回空命中），结论仅供参考。',
    );
  }
  const { input, sample } = buildPaymentAnomalyInput(rows, range);
  const tolerances =
    dataset.meta.tolerances && typeof dataset.meta.tolerances.amount === 'string'
      ? {
          amount: BigInt(Math.round(Number(dataset.meta.tolerances.amount) * 100)),
          qtyPct: Number(dataset.meta.tolerances.qtyPct),
          jaccard: Number(dataset.meta.tolerances.jaccard),
        }
      : undefined;
  if (!tolerances) {
    // 静默回落默认容差 = 用另一套判据评估线上，必须提示
    console.warn('⚠ 数据集 meta 里没有可解析的 tolerances，已回落到代码默认容差：结论可能与线上判据不一致。');
  }
  const evaluation = evaluatePaymentAnomalies({ ...input, ...(tolerances ? { tolerances } : {}) });
  const report = scoreFindings(evaluation.findings, truth);

  const meta: ScoreMeta = {
    datasetNote: `项目 ${dataset.meta.projectId}${
      dataset.meta.from || dataset.meta.to ? `，结算日期 ${dataset.meta.from ?? '不限'} ~ ${dataset.meta.to ?? '不限'}` : ''
    }${dataset.meta.contractId ? `，单合同 ${dataset.meta.contractId}` : ''}（导出时间 ${dataset.meta.exportedAt}）`,
    annotatedBy: truth.annotatedBy,
    datasetSize: sample,
    minRecall: args.minRecall,
    maxFp: args.maxFp,
  };
  const gate = gateStatus(report, meta);
  const markdown = scoreToMarkdown(report, meta);

  console.log(markdown);
  console.log('');
  console.log(`未判定规则：${evaluation.notEvaluated.length} 项`);

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${markdown}\n`, 'utf8');
    console.log(`报告已写入 ${outPath}`);
  }

  if (!gate.passed) {
    console.error(`门槛未通过：${gate.reasons.join('；')}`);
    process.exitCode = 1;
  }
}

main().catch((err: any) => {
  console.error(`评分失败：${err?.message ?? err}`);
  process.exitCode = 1;
});

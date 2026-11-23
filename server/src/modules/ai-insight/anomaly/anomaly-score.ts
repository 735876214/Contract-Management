import type { Finding } from './anomaly-types.ts';

/**
 * **真值对账 / 评分层**（纯函数，零 IO）。给 `scripts/score-anomaly.mts` 与单测共用。
 *
 * 为什么单独一层：评测结论要有意义，必须回答三个可复核的问题——
 * 1. **漏报**（真值里 hit=true 的异常，规则没报）—— 这是出事的来源，权重最高；
 * 2. **误报**（规则报了，人工判定"业务上正常"）—— 消耗信任，攒几次就没人看预警了；
 * 3. **按规则拆开看** —— 合计 90% 召回没有意义，若 R2 只有 40%，那一条规则就是不能用。
 *
 * 所以评分单位是 `(code, entityId)` 唯一键，而不是"条数"。
 */

/** 人工标注的一条真值：`hit=true` 表示"业务上确实该报"，`hit=false` 表示"报了也不该报" */
export interface TruthAnnotation {
  code: string;
  entityId: string;
  hit: boolean;
  /** 标注理由（给复核的人看，也是将来写进评测报告的"口径争议"证据） */
  note?: string;
}

export interface TruthFile {
  /** 项目 id（导出时写入，评分时只做一致性校验，不做业务判断） */
  projectId?: string;
  exportedAt?: string;
  annotatedBy?: string;
  annotations: TruthAnnotation[];
}

export interface CodeScore {
  code: string;
  /** 真值里判该报的条数 */
  truthHits: number;
  /** 规则报出的条数 */
  predicted: number;
  tp: number;
  fp: number;
  fn: number;
  recall: number | null;
  precision: number | null;
}

export interface ScoreReport {
  tp: number;
  fp: number;
  fn: number;
  truthHits: number;
  predicted: number;
  /** 召回率 = tp / (tp + fn)；真值为空时为 null（不是 0，避免"0 召回"误导） */
  recall: number | null;
  precision: number | null;
  byCode: CodeScore[];
  /** 漏报清单（真值 hit=true 但没命中） */
  missed: TruthAnnotation[];
  /** 误报清单（报了但真值 hit=false，或真值里根本没标 = 大概率不该报） */
  unexpected: Array<{ code: string; entityId: string; reason: 'annotated_false' | 'unannotated' }>;
}

/** 评分唯一键：规则码 + 实体 id（同一条规则在同一实体上只算一次） */
export function findingKey(code: string, entityId: string): string {
  return `${code}#${entityId}`;
}

const CODE_LABELS: Record<string, string> = {
  R1_DUP_ACROSS_PERIOD: 'R1-a 跨期重复结算',
  R1_DUP_MATERIAL_QTY: 'R1-b 清单量重复结算',
  R1_FINAL_SNAPSHOT_DRIFT: 'R1-c 终期结算与月度台账不一致',
  R2_OVERPAY: 'R2 超付',
  R3_PAY_WITHOUT_CONTRACT: 'R3 无有效合同付款',
  R4_INVOICE_MISMATCH: 'R4 票款不一致',
  R5_SETTLE_BEFORE_RECEIPT: 'R5 结算早于验收',
  R6_PROCEDURE_SNAPSHOT_DRIFT: 'R6 付款手续累计数倒挂',
};

export function codeLabel(code: string): string {
  return CODE_LABELS[code] ?? code;
}

/**
 * 校验并规整真值文件。**故意严格**：真值是人工资产，多一个字段错一个类型就该立刻炸，
 * 否则"标了但没生效"会伪装成"规则漏报"。
 */
export function parseTruth(raw: unknown): TruthFile {
  const fail = (msg: string): never => {
    throw new Error(`真值文件不合法：${msg}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('顶层必须是对象');
  const obj = raw as Record<string, unknown>;
  const list = obj.annotations;
  if (!Array.isArray(list)) fail('缺少 annotations 数组');
  const seen = new Set<string>();
  const annotations: TruthAnnotation[] = (list as unknown[]).map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(`annotations[${idx}] 不是对象`);
    const row = item as Record<string, unknown>;
    const code = typeof row.code === 'string' ? row.code.trim() : '';
    const entityId = typeof row.entityId === 'string' ? row.entityId.trim() : '';
    // 索引签名上的 typeof 收窄在对象字面量里会丢失（nest build TS2322），故先判型再取布尔值
    const hit = row.hit === true;
    if (!code) fail(`annotations[${idx}].code 为空`);
    if (!entityId) fail(`annotations[${idx}].entityId 为空`);
    if (typeof row.hit !== 'boolean') fail(`annotations[${idx}].hit 必须是 true/false`);
    const key = findingKey(code, entityId);
    if (seen.has(key)) fail(`重复标注：${key}`);
    seen.add(key);
    return {
      code,
      entityId,
      hit,
      note: typeof row.note === 'string' && row.note.trim() ? row.note.trim() : undefined,
    };
  });
  return {
    projectId: typeof obj.projectId === 'string' ? obj.projectId : undefined,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : undefined,
    annotatedBy: typeof obj.annotatedBy === 'string' ? obj.annotatedBy : undefined,
    annotations,
  };
}

const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export function scoreFindings(
  predicted: ReadonlyArray<Pick<Finding, 'code' | 'entityId'>>,
  truth: TruthFile,
): ScoreReport {
  const predKeys = new Set<string>();
  for (const f of predicted) predKeys.add(findingKey(f.code, f.entityId));

  const truthByKey = new Map<string, TruthAnnotation>();
  for (const a of truth.annotations) truthByKey.set(findingKey(a.code, a.entityId), a);

  const hitTruthKeys = [...truthByKey.values()].filter((a) => a.hit).map((a) => findingKey(a.code, a.entityId));
  const hitTruthSet = new Set(hitTruthKeys);

  let tp = 0;
  let fp = 0;
  const missed: TruthAnnotation[] = [];
  for (const key of hitTruthKeys) {
    if (predKeys.has(key)) tp++;
    else missed.push(truthByKey.get(key)!);
  }

  const unexpected: ScoreReport['unexpected'] = [];
  for (const key of predKeys) {
    const a = truthByKey.get(key);
    if (!a) {
      fp++;
      unexpected.push(splitKey(key, 'unannotated'));
    } else if (!a.hit) {
      fp++;
      unexpected.push(splitKey(key, 'annotated_false'));
    }
  }
  const fn = missed.length;

  const codes = [...new Set([...hitTruthKeys, ...predKeys].map(codeOf))];
  const byCode: CodeScore[] = codes.map((code) => {
    const tKeys = hitTruthKeys.filter((k) => codeOf(k) === code);
    const pKeys = [...predKeys].filter((k) => codeOf(k) === code);
    const ctp = tKeys.filter((k) => predKeys.has(k)).length;
    const cfp = pKeys.filter((k) => !hitTruthSet.has(k)).length;
    return {
      code,
      truthHits: tKeys.length,
      predicted: pKeys.length,
      tp: ctp,
      fp: cfp,
      fn: tKeys.length - ctp,
      recall: ratio(ctp, tKeys.length),
      precision: ratio(ctp, pKeys.length),
    };
  });

  // 按规则排序（R 码字典序 ≈ 规则编号），保证报告稳定可 diff
  byCode.sort((a, b) => a.code.localeCompare(b.code));
  missed.sort((a, b) => findingKey(a.code, a.entityId).localeCompare(findingKey(b.code, b.entityId)));
  unexpected.sort((a, b) => findingKey(a.code, a.entityId).localeCompare(findingKey(b.code, b.entityId)));

  return {
    tp,
    fp,
    fn,
    truthHits: hitTruthKeys.length,
    predicted: predKeys.size,
    recall: ratio(tp, hitTruthKeys.length),
    precision: ratio(tp, predKeys.size),
    byCode,
    missed,
    unexpected,
  };
}

function splitKey(key: string, reason: 'annotated_false' | 'unannotated'): ScoreReport['unexpected'][number] {
  const at = key.lastIndexOf('#');
  return { code: key.slice(0, at), entityId: key.slice(at + 1), reason };
}

function codeOf(key: string): string {
  return key.slice(0, key.lastIndexOf('#'));
}

const pct = (v: number | null): string => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

export interface ScoreMeta {
  /** 数据来源描述（项目/时间范围/库名），写进报告抬头，避免"这份数字是哪来的" */
  datasetNote?: string;
  annotatedBy?: string;
  datasetSize?: Record<string, number>;
  /** 门槛：召回率低于它就算不通过 */
  minRecall?: number;
  /** 门槛：误报条数上限（预警系统的误报成本是"用户不再看"，必须硬卡） */
  maxFp?: number;
}

/** 门槛判定：召回不达标或误报超限 → `passed=false`（脚本据此退非 0） */
export function gateStatus(report: ScoreReport, meta: ScoreMeta): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const minRecall = meta.minRecall ?? 0.9;
  const maxFp = meta.maxFp ?? 2;
  if (report.recall == null) reasons.push('真值里没有 hit=true 的标注，无法计算召回率');
  else if (report.recall < minRecall) reasons.push(`召回率 ${pct(report.recall)} < 门槛 ${pct(minRecall)}`);
  if (report.fp > maxFp) reasons.push(`误报 ${report.fp} 条 > 门槛 ${maxFp} 条`);
  return { passed: reasons.length === 0, reasons };
}

export function scoreToMarkdown(report: ScoreReport, meta: ScoreMeta): string {
  const gate = gateStatus(report, meta);
  const lines: string[] = [];
  lines.push('# 结算/付款异常预警 · 真值对账评测报告');
  lines.push('');
  lines.push(`- 数据来源：${meta.datasetNote ?? '（未注明）'}`);
  if (meta.datasetSize) {
    const parts = Object.entries(meta.datasetSize).map(([k, v]) => `${k} ${v}`);
    lines.push(`- 样本量：${parts.join(' / ')}`);
  }
  lines.push(`- 标注人：${meta.annotatedBy ?? '（未注明）'}`);
  lines.push(`- 门槛：召回率 ≥ ${pct(meta.minRecall ?? 0.9)}，误报 ≤ ${meta.maxFp ?? 2} 条`);
  lines.push(`- 结论：**${gate.passed ? '通过' : '不通过'}**${gate.passed ? '' : `（${gate.reasons.join('；')}）`}`);
  lines.push('');
  lines.push('## 总体');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('| --- | --- |');
  lines.push(`| 真值判该报（hit=true） | ${report.truthHits} |`);
  lines.push(`| 规则报出 | ${report.predicted} |`);
  lines.push(`| 命中（tp） | ${report.tp} |`);
  lines.push(`| 漏报（fn） | ${report.fn} |`);
  lines.push(`| 误报（fp） | ${report.fp} |`);
  lines.push(`| 召回率 | ${pct(report.recall)} |`);
  lines.push(`| 查准率 | ${pct(report.precision)} |`);
  lines.push('');
  lines.push('## 按规则');
  lines.push('');
  lines.push('| 规则 | 真值该报 | 规则报出 | tp | fp | fn | 召回 | 查准 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of report.byCode) {
    lines.push(
      `| ${codeLabel(c.code)} | ${c.truthHits} | ${c.predicted} | ${c.tp} | ${c.fp} | ${c.fn} | ${pct(c.recall)} | ${pct(c.precision)} |`,
    );
  }
  lines.push('');
  lines.push('## 漏报清单');
  lines.push('');
  if (report.missed.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| 规则 | 实体 | 标注理由 |');
    lines.push('| --- | --- | --- |');
    for (const m of report.missed) {
      lines.push(`| ${codeLabel(m.code)} | \`${m.entityId}\` | ${m.note ?? ''} |`);
    }
  }
  lines.push('');
  lines.push('## 误报清单');
  lines.push('');
  if (report.unexpected.length === 0) {
    lines.push('无。');
  } else {
    lines.push('| 规则 | 实体 | 起因 |');
    lines.push('| --- | --- | --- |');
    for (const u of report.unexpected) {
      lines.push(
        `| ${codeLabel(u.code)} | \`${u.entityId}\` | ${u.reason === 'annotated_false' ? '人工判定不应报' : '真值未标注'} |`,
      );
    }
  }
  return lines.join('\n');
}

import type { LlmMessage } from '../llm-client';
import {
  auditNarrativeNumbers,
  collectFindingNumbers,
  type NarratableFinding,
} from '../common/narrative.ts';
import {
  type AnomalyEvaluation,
  type Finding,
  ANOMALY_CODE_LABELS,
  ANOMALY_LEVEL_LABELS,
} from './anomaly-types.ts';

/**
 * 预警措辞层：**模型只组织语言，不参与判定、不参与算术**。
 *
 * 这是本项目对财务类 AI 的红线（与 `report.service.ts` 同一口径）：
 * 命中与否由 `rules-payment.ts` 的纯函数决定，数字由 `facts` 决定，
 * 模型的任务只有一件——把「R2 超付 5000.00 元」翻译成财务能直接转发的业务语言。
 *
 * 所以这个文件只有两个纯函数：
 * 1. `buildAnomalyMessages`：拼提示词（把 findings 序列化进去，数值原样带单位）；
 * 2. `auditNarrative`：把模型输出里**凭空出现的数字**挑出来——出现即视为对账失败，
 *    service 会丢弃模型结论、回落到模板串（`fallbackNarrative`）。
 */

export interface AnomalyNarrative {
  /** 总体结论（≤200 字，面向财务/项目负责人） */
  conclusion: string;
  /** 建议动作（3~5 条，每条落到具体单据/合同编号） */
  actions: string[];
}

export interface AnomalyNarrativeInput {
  period: { from: string | null; to: string | null };
  /** 本次参与判定的事实样本量（面板要显示「基于多少单据算的」） */
  sample: Record<string, number>;
  /** 阈值（已格式化，如 `容差 1.00 元 / 数量 +2% / 明细重合度 0.8`） */
  toleranceText: string;
  evaluation: AnomalyEvaluation;
}

/**
 * 数字归一 / 抽取 / 对账的通用实现在 `ai/common/narrative.ts`（M4 起两个课题共用一套口径）。
 * 这里保留原有导出名与签名，既有调用方与单测不受影响。
 */
export { extractNumbers, normalizeNumberToken } from '../common/narrative.ts';

/** 允许模型引用的数字全集（facts 键值 + 标题 + 差额） */
export function collectFactNumbers(evaluation: AnomalyEvaluation): Set<string> {
  return collectFindingNumbers(evaluation.findings as NarratableFinding[]);
}

/**
 * 对账：模型结论里出现的数字，必须全部能在 `facts` 里找到。
 *
 * 为什么这条比「提示词里写不许编数字」管用：模型对「不要编」的遵守率大概 90%，
 * 但财务场景 10% 的编造就是事故。这里把「编没编」变成可判定的集合差，
 * 空集才放行——和 `report.service.ts` 的 `unknownNumbers` 是同一套思路。
 */
export function auditNarrative(narrative: AnomalyNarrative, evaluation: AnomalyEvaluation): string[] {
  return auditNarrativeNumbers(narrative, evaluation.findings as NarratableFinding[]);
}

/**
 * 模板串兜底：**面板永不空窗**。
 *
 * 三处会用到：模型没配（`enabled:false`）、模型调用失败、对账失败。
 * 文案全部由 `evaluation` 里的数字拼成，所以永远不会「编造」，
 * 只是比模型版本干一些——财务照样能直接照着核查。
 */
export function fallbackNarrative(evaluation: AnomalyEvaluation): AnomalyNarrative {
  const { summary, findings, notEvaluated } = evaluation;
  if (!summary.total) {
    const tail = notEvaluated.length ? `（其中 ${notEvaluated.length} 条规则因口径缺失未参与判定，见「未判定」清单）` : '';
    return {
      conclusion: `本次判定未发现疑点${tail}。这表示在现有数据与阈值下三条主链路（结算—付款—发票）对得上，不代表原始凭证一定合规。`,
      actions: ['如需更强保证，请抽查金额最大的 3 份结算单，核对合同条款与验收记录。'],
    };
  }
  const parts: string[] = [];
  parts.push(`本次共命中 ${summary.total} 项疑点，其中高风险 ${summary.high} 项、中风险 ${summary.medium} 项。`);
  const codes = Object.keys(summary.byCode) as (keyof typeof ANOMALY_CODE_LABELS)[];
  if (codes.length) {
    parts.push(
      `按类型分布：${codes.map((c) => `${ANOMALY_CODE_LABELS[c]} ${summary.byCode[c]} 项`).join('；')}。`,
    );
  }
  const highTop = findings.filter((f) => f.level === 'HIGH').slice(0, 3);
  if (highTop.length) {
    parts.push(`优先处理：${highTop.map((f) => f.title).join('；')}。`);
  }
  if (notEvaluated.length) {
    parts.push(`另有 ${notEvaluated.length} 条规则因口径缺失未参与判定，结论不覆盖这部分。`);
  }
  return {
    conclusion: parts.join(''),
    actions: [
      '按风险等级从高到低逐条核查，先看高风险项对应的结算单与付款流水。',
      '对「重复结算 / 重复物资」类命中，核对是否为跨期补录或分期结算，确认后在该单据备注里写明依据。',
      '对「超付 / 票款不一致」类命中，先停止后续付款，补齐发票或冲抵单再继续。',
      '核查完成后把结论登记到合同备注，避免下次扫描仍报同一项。',
    ],
  };
}

const SYSTEM_PROMPT = `你是工程/采购企业的结算与付款内审助手。用户会给你一批**已由程序判定**的疑点（JSON），你只负责把它们写成给财务和项目负责人看的结论与动作建议。

铁律（必须全部遵守）：
1. 只使用用户消息里出现过的数字与单据编号，**不得计算任何新的数字**（不要算合计、占比、差额、平均值，程序已经算好了）。fact 里给什么就写什么。
2. 不得更改金额单位（元就是元，不要换算成万元）。
3. 不得给出法律、税务定性结论（不要写「构成违法」「涉嫌犯罪」「可以税前扣除」），只做业务核查建议。
4. 允许使用的计数词仅限 0~10（如「3 项」「2 份单据」）。
5. 不得声称已核对原始凭证——你只看到系统数据。
6. 若"未判定规则"非空，结论里必须明确说明未覆盖的范围，不要让读者以为「没命中＝没问题」。

输出格式（只输出 JSON，不要 markdown 围栏、不要解释）：
{"conclusion": "总体结论，120~200 字，按风险从高到低讲清是什么问题、影响哪份合同/结算单", "actions": ["动作 1", "动作 2", "动作 3"]}

actions 3~5 条，每条落到具体单据编号或合同编号，且是可执行动作（核查什么、暂停什么、补什么、登记什么）。`;

/** 把一条命中压成提示词里的一行事实（金额已带单位，模型只需抄写） */
function findingLine(f: Finding): string {
  const facts = Object.entries(f.facts ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('，');
  return `- [${ANOMALY_LEVEL_LABELS[f.level]}] ${ANOMALY_CODE_LABELS[f.code]}｜${f.title}${facts ? `｜${facts}` : ''}`;
}

/**
 * 拼提示词。
 *
 * 结构：system（铁律） + user（期间/样本量/阈值 → 风险摘要 → 命中清单 → 未判定清单）。
 * 命中清单**不截断**：截断等于让模型漏报，宁可提示词长一点（这类项目的命中量是几十条量级）。
 */
export function buildAnomalyMessages(input: AnomalyNarrativeInput): LlmMessage[] {
  const { period, sample, toleranceText, evaluation } = input;
  const sampleText = Object.entries(sample)
    .map(([k, v]) => `${k} ${v}`)
    .join('，');
  const periodText =
    period.from || period.to ? `结算日期 ${period.from ?? '起'} ~ ${period.to ?? '今'}` : '全部历史数据（未限定期间）';

  const lines: string[] = [];
  lines.push('【判定范围】');
  lines.push(`期间：${periodText}`);
  lines.push(`样本：${sampleText || '（无）'}`);
  lines.push(`阈值：${toleranceText}`);
  lines.push('');
  lines.push('【风险摘要】');
  lines.push(
    `共 ${evaluation.summary.total} 项（高风险 ${evaluation.summary.high}，中风险 ${evaluation.summary.medium}）`,
  );
  lines.push('');
  lines.push('【命中清单】');
  if (!evaluation.findings.length) lines.push('（无）');
  for (const f of evaluation.findings) lines.push(findingLine(f));
  lines.push('');
  lines.push('【未判定规则】');
  if (!evaluation.notEvaluated.length) lines.push('（无，全部规则已判定）');
  for (const note of evaluation.notEvaluated) lines.push(`- ${note}`);
  lines.push('');
  lines.push('请按 system 里的铁律与输出格式给出 JSON。');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

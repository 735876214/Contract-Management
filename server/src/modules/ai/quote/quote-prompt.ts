/**
 * 课题 3-9 · **措辞层**：模型只负责把已判定的疑点写成采购/招标人能直接转发的话。
 *
 * 与 6-9 的 `anomaly-prompt.ts` 同一红线：命中与否由 `rules-quote.ts` 决定，数字由 `facts` 决定；
 * 这里只做两件事——拼提示词、对账（`common/narrative.ts` 的集合差，出现未知数字即丢弃模型结论）。
 */

import type { LlmMessage } from '../llm-client';
import {
  auditNarrativeNumbers,
  type NarratableFinding,
  type Narrative,
  sampleText,
} from '../common/narrative.ts';
import {
  QUOTE_CODE_LABELS,
  QUOTE_LEVEL_LABELS,
  type QuoteEvaluation,
  type QuoteFinding,
} from './quote-types.ts';

export type QuoteNarrative = Narrative;

export interface QuoteNarrativeInput {
  /** 判定范围（任务编号 / 期间），已格式化的中文 */
  scope: string;
  /** 本次参与判定的样本量（面板显示「基于多少数据算的」） */
  sample: Record<string, number>;
  /** 阈值描述（`quoteToleranceText` 的输出，两处共用同一句） */
  toleranceText: string;
  evaluation: QuoteEvaluation;
}

/**
 * 对账：模型措辞里不许出现 facts 之外的数字。
 *
 * 采购编号（`PROC-20261001-001`）是动作建议必须引用的东西，所以把 `taskNo` 一并放进
 * 放行集合——否则模型老老实实抄了编号，系统反而判它编数字。
 */
export function auditQuoteNarrative(
  narrative: QuoteNarrative,
  evaluation: QuoteEvaluation,
  extras: Array<string | number | null | undefined> = [],
): string[] {
  const items: NarratableFinding[] = evaluation.findings.map((f) => ({
    title: `${f.taskNo ?? ''} ${f.title}`,
    amountDiff: f.amountDiff ?? null,
    facts: f.facts,
  }));
  return auditNarrativeNumbers(narrative, items, extras);
}

/**
 * 模板串兜底：**面板永不空窗**。
 *
 * 用于：模型未配置 / 调用失败 / 对账失败。文案全部由 `evaluation` 里的数字拼成，不会编造。
 */
export function fallbackQuoteNarrative(evaluation: QuoteEvaluation): QuoteNarrative {
  const { findings, summary, notEvaluated } = evaluation;
  if (!findings.length) {
    const parts = ['本次扫描未命中疑点'];
    parts.push(`共检查 ${summary.total === 0 ? '全部已判定规则' : '相关规则'}，未发现异常报价或价差异常。`);
    if (notEvaluated.length) {
      parts.push(`但有 ${notEvaluated.length} 条规则因数据不足未参与判定，结论不覆盖这部分。`);
    }
    return {
      conclusion: parts.join('，').replace('，，', '，'),
      actions: ['无需处理；下次有新报价或新的总采购清单时重新扫描即可。'],
    };
  }

  const high = findings.filter((f) => f.level === 'HIGH');
  const codes = Object.keys(summary.byCode).sort();
  const parts: string[] = [];
  parts.push(`本次扫描命中 ${summary.total} 项疑点（高风险 ${summary.high} 项、需复核 ${summary.medium} 项）。`);
  if (codes.length) {
    parts.push(
      `按类型：${codes.map((c) => `${QUOTE_CODE_LABELS[c as QuoteFinding['code']]} ${summary.byCode[c]} 项`).join('；')}。`,
    );
  }
  if (high.length) {
    parts.push(`优先处理：${high.slice(0, 3).map((f) => f.title).join('；')}。`);
  }
  if (notEvaluated.length) {
    parts.push(`另有 ${notEvaluated.length} 条规则因口径缺失未参与判定，结论不覆盖这部分。`);
  }
  return {
    conclusion: parts.join(''),
    actions: [
      '按风险等级从高到低逐条核查，先看高风险项对应的采购任务与报价人。',
      '对「两轮降幅异常 / 二轮倒挂」类命中，核对第二轮降价依据（是否有书面议价记录）。',
      '对「成交价超控制价 / 单行单价超控制价」类命中，先暂停定标审批，补齐控制价调整依据再继续。',
      '对「首轮离散系数过低」类命中，复核是否同一实际控制人参与（仅作核查线索，不作定性结论）。',
      '核查完成后在采购任务备注里登记结论，避免下次扫描仍报同一项。',
    ],
  };
}

const SYSTEM_PROMPT = `你是工程/采购企业的招标与报价内审助手。用户会给你一批**已由程序判定**的报价疑点（JSON），你只负责把它们写成给采购负责人和审计看的话。

铁律（必须全部遵守）：
1. 只使用用户消息里出现过的数字与编号，**不得计算任何新的数字**（不要算降幅、均值、占比、合计，程序已经算好了）。facts 里给什么就写什么。
2. 不得更改单位与量纲（元就是元，% 就是 %，不要换算）。
3. 不得给出法律定性结论（不要写「构成串标」「涉嫌围标」「违法」），只能写「存在…迹象，建议核查…」这类业务表述。
4. 允许使用的计数词仅限 0~10（如「3 项」「2 家」）。
5. 不得声称已核对原始报价单或开标记录——你只看到系统数据。
6. 若"未判定规则"非空，结论里必须说明未覆盖范围，不要让读者以为「没命中＝没问题」。

输出格式（只输出 JSON，不要 markdown 围栏、不要解释）：
{"conclusion": "总体结论，120~200 字，按风险从高到低讲清是什么问题、涉及哪个采购编号", "actions": ["动作 1", "动作 2", "动作 3"]}

actions 3~5 条，每条落到具体采购编号或报价人，且是可执行动作（核查什么、暂停什么、补什么、登记什么）。`;

/** 一条命中压成提示词里的一行事实（金额/比例已格式化，模型只需抄写） */
function findingLine(f: QuoteFinding): string {
  const facts = (f.facts ?? []).join('，');
  return `- [${QUOTE_LEVEL_LABELS[f.level]}] ${QUOTE_CODE_LABELS[f.code]}｜${f.title}${facts ? `｜${facts}` : ''}`;
}

/**
 * 拼提示词：system（铁律）+ user（范围/样本/阈值 → 摘要 → 命中清单 → 未判定清单）。
 *
 * 命中清单**不截断**：截断等于让模型漏报；这类项目的命中量是几十条量级。
 */
export function buildQuoteMessages(input: QuoteNarrativeInput): LlmMessage[] {
  const { scope, sample, toleranceText, evaluation } = input;
  const lines: string[] = [];
  lines.push('【判定范围】');
  lines.push(scope || '全部采购任务');
  lines.push(`样本：${sampleText(sample)}`);
  lines.push(`阈值：${toleranceText}`);
  lines.push('');
  lines.push('【风险摘要】');
  lines.push(`共 ${evaluation.summary.total} 项（高风险 ${evaluation.summary.high}，需复核 ${evaluation.summary.medium}）`);
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

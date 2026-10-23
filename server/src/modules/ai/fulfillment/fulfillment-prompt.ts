/**
 * 课题 4-9 · **措辞层**：模型只负责把已判定的履约偏差写成项管/合同管理员能直接转发的话。
 *
 * 与前两个课题同一红线：命中与否由 `rules-fulfillment.ts` 决定，数字由 `facts` 决定；
 * 这里只做两件事——拼提示词、对账（`common/narrative.ts` 的集合差，出现未知数字即丢弃模型结论）。
 *
 * 本课题最容易翻车的地方是「让模型算逾期天数/完成率」——那些数规则层已经算好写进 facts，
 * 提示词里明确禁止模型自行相减。
 */

import type { LlmMessage } from '../llm-client';
import type { FulfillmentEvaluation } from './rules-fulfillment.ts';
import { auditNarrativeNumbers, type NarratableFinding, type Narrative, sampleText } from '../common/narrative.ts';
import {
  FULFILLMENT_CODE_LABELS,
  FULFILLMENT_LEVEL_LABELS,
  type FulfillmentFinding,
} from './fulfillment-types.ts';

export type FulfillmentNarrative = Narrative;

export interface FulfillmentNarrativeInput {
  /** 判定范围（项目 / 期间 / 指定合同），已格式化的中文 */
  scope: string;
  /** 参与判定的样本量（面板显示「基于多少数据算的」） */
  sample: Record<string, number>;
  /** 阈值描述（`fulfillmentToleranceText` 的输出，两处共用同一句） */
  toleranceText: string;
  evaluation: FulfillmentEvaluation;
}

/**
 * 对账：模型措辞里不许出现 facts 之外的数字。
 *
 * 合同编号（`HT-2026-101`）与节点名是动作建议必须引用的东西，所以把 `title` 一并放进
 * 放行集合——否则模型老实抄了编号，系统反而判它编数字。
 */
export function auditFulfillmentNarrative(
  narrative: FulfillmentNarrative,
  evaluation: FulfillmentEvaluation,
): string[] {
  const items: NarratableFinding[] = evaluation.findings.map((f) => ({
    title: f.title,
    amountDiff: f.amountDiff ?? null,
    facts: f.facts,
  }));
  return auditNarrativeNumbers(narrative, items);
}

/**
 * 模板串兜底：**面板永不空窗**，用于模型未配置 / 调用失败 / 对账失败。
 * 文案全部由 `evaluation` 里的数字拼成，不会编造。
 */
export function fallbackFulfillmentNarrative(evaluation: FulfillmentEvaluation): FulfillmentNarrative {
  const { findings, summary, notEvaluated } = evaluation;

  if (!findings.length) {
    const parts = ['本次扫描未命中履约偏差'];
    parts.push('，规则已覆盖逾期、完成滞后、顺序倒挂、付款进度背离等八类。');
    if (notEvaluated.length) {
      parts.push(`但有 ${notEvaluated.length} 条规则因数据不足未参与判定，结论不覆盖这部分。`);
    }
    return {
      conclusion: parts.join(''),
      actions: ['无需处理；后续节点更新或新增付款后重新扫描即可。'],
    };
  }

  const high = findings.filter((f) => f.level === 'HIGH');
  const codes = Object.keys(summary.byCode).sort();
  const parts: string[] = [];
  parts.push(`本次扫描命中 ${summary.total} 项履约偏差（高风险 ${summary.high} 项、需复核 ${summary.medium} 项）。`);
  if (codes.length) {
    parts.push(
      `按类型：${codes
        .map((c) => `${FULFILLMENT_CODE_LABELS[c as FulfillmentFinding['code']]} ${summary.byCode[c]} 项`)
        .join('；')}。`,
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
      '按风险等级从高到低逐条核查，先看高风险项目对应的合同与节点。',
      '对「节点逾期」类命中，联系责任人确认实际进度，重新排计划或在系统里登记延期原因。',
      '对「完成滞后 / 完成未填实际日期」类命中，补齐节点的实际完成日期，否则进度统计不可信。',
      '对「付款快于履约」类命中，暂缓后续付款审批，先核实形象进度或要求补充证明材料。',
      '核查完成后在合同备注里登记结论，避免下次扫描仍报同一项。',
    ],
  };
}

const SYSTEM_PROMPT = `你是工程/采购企业的合同履约内审助手。用户会给你一批**已由程序判定**的履约偏差（JSON），你只负责把它们写成给项目经理、合同管理员和审计看的话。

铁律（必须全部遵守）：
1. 只使用用户消息里出现过的数字与编号，**不得计算任何新的数字**（不要算逾期天数、完成率、差额、合计，程序已经算好了）。facts 里给什么就写什么。
2. 不得更改单位与量纲（天就是天，% 就是 %，元就是元，不要换算）。
3. 不得给出法律定性结论（不要写「违约」「索赔成立」「应承担责任」），只能写「存在…风险，建议核实…」这类业务表述。
4. 允许使用的计数词仅限 0~10（如「3 项」「2 个节点」）。
5. 不得声称已与项目经理或现场核实过——你只看到系统数据。
6. 若"未判定规则"非空，结论里必须说明未覆盖范围，不要让读者以为「没命中＝没问题」。

输出格式（只输出 JSON，不要 markdown 围栏、不要解释）：
{"conclusion": "总体结论，120~200 字，按风险从高到低讲清是什么问题、涉及哪个合同与节点", "actions": ["动作 1", "动作 2", "动作 3"]}

actions 3~5 条，每条落到具体合同编号或节点，且是可执行动作（核实什么、补什么、暂缓什么、登记什么）。`;

/** 一条命中压成提示词里的一行事实（天数/比例已格式化，模型只需抄写） */
function findingLine(f: FulfillmentFinding): string {
  const facts = (f.facts ?? []).join('，');
  return `- [${FULFILLMENT_LEVEL_LABELS[f.level]}] ${FULFILLMENT_CODE_LABELS[f.code]}｜${f.title}${facts ? `｜${facts}` : ''}`;
}

/**
 * 拼提示词：system（铁律）+ user（范围/样本/阈值 → 摘要 → 命中清单 → 未判定清单）。
 * 命中清单**不截断**：截断等于让模型漏报。
 */
export function buildFulfillmentMessages(input: FulfillmentNarrativeInput): LlmMessage[] {
  const { scope, sample, toleranceText, evaluation } = input;
  const lines: string[] = [];
  lines.push('【判定范围】');
  lines.push(scope || '本项目全部在履行合同');
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

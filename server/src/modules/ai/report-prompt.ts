import type { LlmMessage } from './llm-client';
import { REPORT_KINDS, factsToMarkdown, type ReportFacts, type ReportKind } from './report-facts';
import { templatePromptText } from './report-templates';

/**
 * 汇报材料的 prompt（零依赖纯函数）。
 *
 * 关键约定：**数字只能抄事实清单**。模型被允许做的只有「组织语言、归纳、给建议」，
 * 不允许计算、不允许补全、不允许写清单之外的数据。
 * 产出后由 `auditReport()` 逐个数字回查，编造的数字会被摆到页面上让人看见。
 */
export const REPORT_SYSTEM_PROMPT = [
  '你是企业合同管理系统的汇报材料撰写助手，服务对象是公司管理层。',
  '',
  '硬性规则：',
  '1. 只能引用【事实清单】里给出的数字，**一个都不许自行计算或补全**；清单里没有的数据，宁可不写。',
  '2. 不要写「同比增长 xx%」「环比提升」这类需要历史数据才能得出的结论——清单里没有基期数据。',
  '3. 金额写「元」或「万元」时用清单里的原值，不要四舍五入成另一个数。',
  '4. 输出 Markdown：用 `##` 分节、`-` 列要点，可在正文里用 `**加粗**` 强调结论。',
  '5. 结构：先给一句话总体结论，再分节展开，最后给「下阶段建议」（建议可以基于数据给判断，但不能编数）。',
  '6. 不要写「以上」「综上所述」之类的空话；不要输出与清单无关的行业背景。',
  '7. 不要提到「事实清单」「系统」「模型」这类词——它就是一份正常的工作汇报。',
].join('\n');

export function buildReportMessages(input: {
  kind: ReportKind;
  facts: ReportFacts;
  /** 用户补充要求（例如「重点写付款风险」） */
  extra?: string;
}): LlmMessage[] {
  const kind = REPORT_KINDS[input.kind] ?? REPORT_KINDS.monthly;
  const user = [
    `【材料类型】${kind.label}`,
    `【写作要求】${kind.hint}`,
    input.extra ? `【补充要求】${input.extra}` : null,
    '',
    '【公文骨架】**必须原样使用下面的节标题**（含中文序号），不得改写、增删或调整顺序：',
    templatePromptText(input.kind),
    '',
    '【事实清单】',
    factsToMarkdown(input.facts),
    '',
    `【标题】请以「${input.facts.project.name}${kind.label}」为中心起标题，正文第一行用 \`# \` 输出标题。`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  return [
    { role: 'system', content: REPORT_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

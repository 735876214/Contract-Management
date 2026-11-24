/**
 * **AI 问数（问答）的措辞层**（P3-A，零依赖纯函数）。
 *
 * 与汇报材料（`analytics-prompt.ts` / `report-prompt.ts`）的分工：
 * - 报告：多节公文、表格由程序生成，模型只写段落；
 * - 问答：一段话直接回答，**同一套数字对账**（`auditNumbers`）。
 *
 * 两条不能松的红线（沿用本仓既有立场）：
 * 1. **数字只能来自事实清单**：模型不许算合计、增速、占比、差额；清单里没有就说不掌握。
 * 2. **对不上就整段丢弃**：`buildChatAnswer()` 回查失败时退回确定性事实摘要，
 *    并把对不上的数字交给前端展示——宁可答得笨，不许答得假。
 */
import type { AiAnalyticsFacts } from '../../ai-core/dataset/analytics.types.ts';
import type { LlmMessage } from '../../ai-core/llm-client.ts';
import { auditNumbers, numbersInText } from '../report-facts.ts';
import { analyticsFactNumbers, analyticsFactsToMarkdown } from './dataset-facts.ts';

export const CHAT_SYSTEM_PROMPT = [
  '你是企业合同管理系统（CMS）的数据问答助手，用中文回答使用者关于合同/结算/付款/发票/日报/采购等业务数据的问题。',
  '',
  '硬性规则（违反任何一条即为废答）：',
  '1. 只能引用【事实清单】里已经出现的数字。**禁止任何计算**：不求合计、不算增速、不算占比、不做差额推导——',
  '   清单里没写出来的数字，一个都不许出现。需要汇总而清单没给，就说明「清单未提供该汇总」。',
  '2. 金额照抄清单原值，不要换算单位（元就是元，不要自行换算成万元）。',
  '3. 事实清单不覆盖这个问题时，**直接说「系统当前数据不包含这个信息」**，并列出清单里实际有什么，不要用常识补齐。',
  '4. 不做法律、税务定性；不判断合同是否违约；不写「涉嫌」「构成」这类结论。',
  '5. 不得声称已核对原始凭证、已与业务核对、已现场核实——你只看到系统里的汇总数据。',
  '6. 输出 ≤200 字的一段话（可用 `- ` 列 2~4 条要点）。**不要写标题、不要写表格、不要写代码块**。',
  '7. 不要提「事实清单」「模型」「系统提示」这类词；如果引用了数字，就用自然语言说出来。',
].join('\n');

export interface ChatAnswerInput {
  facts: AiAnalyticsFacts;
  /** 用户原问题（回查时它的数字也放行：用户问「500 万那笔」时模型复述不算编造） */
  question: string;
  scopeLabel: string;
  periodLabel: string;
}

export function buildChatAnswerMessages(input: ChatAnswerInput): LlmMessage[] {
  const user = [
    `【统计范围】${input.scopeLabel}`,
    `【统计期间】${input.periodLabel}`,
    '',
    '【事实清单】（唯一可用的数字来源）',
    analyticsFactsToMarkdown(input.facts),
    '',
    '【问题】',
    input.question.slice(0, 2000),
  ].join('\n');
  return [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

export interface ChatAnswerResult {
  /** 最终给用户看的正文（模型答案，或对账失败后的确定性摘要） */
  answer: string;
  /** 对不上事实的数字（非空 = 模型答案整段丢弃） */
  discarded: string[];
  /** true = 采用模型答案；false = 退回确定性摘要 */
  accepted: boolean;
  warnings: string[];
}

/** 确定性兜底：模型答案不可用时，直接把事实清单摆出来（诚实但笨） */
export function chatFallbackAnswer(facts: AiAnalyticsFacts, reason: string): string {
  return [`> ${reason}`, '', analyticsFactsToMarkdown(facts)].join('\n');
}

/** 段落清洗：问答允许 `- ` 列表与加粗，但去掉标题/表格/引用块/代码块（模型偶尔自作主张） */
function sanitizeAnswer(raw: string): string {
  return String(raw ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#{1,6}\s|\||``)/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 组合问答：清洗 → 数字回查 → 通过则采用，否则整段丢弃并退回事实摘要。
 *
 * 注意回查的放行集合 = 事实清单里的数字 **+ 用户问题里的数字**：
 * 用户问「那笔 500 万的合同」，模型复述 500 万不该被判编造（与 `buildNarratedReport` 同口径）。
 */
export function buildChatAnswer(
  facts: AiAnalyticsFacts,
  raw: string,
  question = '',
  /**
   * 额外放行的数字：来自**工具返回的事实文本**（P3-B）。
   * 工具结果是后端算的、已展示给用户，所以模型复述它不算编造；
   * 但只放行工具原文里出现过的数字——不接受模型自己拼接的数。
   */
  extraNumbers: number[] = [],
): ChatAnswerResult {
  const answer = sanitizeAnswer(raw);
  if (!answer) {
    return {
      answer: chatFallbackAnswer(facts, '模型没有给出可用回答，以下是本期间的事实汇总。'),
      discarded: [],
      accepted: false,
      warnings: ['模型返回空回答，已改为事实摘要'],
    };
  }
  const allowed = [...analyticsFactNumbers(facts), ...numbersInText(question), ...extraNumbers];
  const audit = auditNumbers(answer, allowed);
  if (audit.unknown.length) {
    const shown = audit.unknown.slice(0, 5).join('、');
    const more = audit.unknown.length > 5 ? ' 等' : '';
    return {
      answer: chatFallbackAnswer(facts, `模型回答包含无法对账的数字（${shown}${more}），已改为事实汇总。`),
      discarded: audit.unknown,
      accepted: false,
      warnings: [`模型回答含 ${audit.unknown.length} 个无法对账的数字，已整段丢弃`],
    };
  }
  return { answer, discarded: [], accepted: true, warnings: [] };
}

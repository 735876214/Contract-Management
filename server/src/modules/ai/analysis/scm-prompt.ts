/**
 * 课题 7-11 · **措辞层**：模型只负责把已算好的全景事实写成领导能看的材料。
 *
 * 与前三个课题同一红线：**数字全部由 `scm-facts.ts` 算好**，模型只许引用、不许计算。
 * 差别在于产出形态——预警是「命中清单 + 结论」，全景是**一篇四节的小报告**，
 * 所以这里的提示词要求按固定小节写作，且节标题逐字一致（前端据此判定「材料是否缺节」）。
 */

import type { LlmMessage } from '../llm-client';
import { scmFactsToMarkdown } from './scm-facts.ts';
import type { ScmFacts } from './scm-types.ts';

/** 固定小节（逐字匹配；缺节会在响应 `missingSections` 里报给用户） */
export const SCM_SECTIONS = ['一、总体情况', '二、项目对照', '三、供应商集中度', '四、风险与建议'] as const;

const SYSTEM_PROMPT = [
  '你是工程/采购型企业的供应链运营分析助理。你要根据「系统已算好的事实清单」写一份供经营层阅读的供应链全景报告。',
  '',
  '铁律（违反任何一条即为废稿）：',
  '1. 只能引用事实清单里**已经出现的数字**。禁止做任何计算：不求合计、不算增速、不算占比、不做差额推导——清单里没写出来的数字，一个都不许出现。',
  '2. 禁止编造项目名、供应商名、合同编号。清单里没有的实体不要提。',
  '3. 数据缺口必须说清楚：清单里标注「未填」「数据缺口」「无法计算」的，照说，不要用 0 或「均正常」掩盖。',
  '4. 不做法律定性、不做税务结论、不判断合同是否违约；只描述数据反映的经营与资金状况。',
  '5. 不得声称已核对原始凭证、已与业务核对、已现场核实。',
  '6. 只输出 Markdown 正文：一级标题 + 四个二级小节，节标题逐字使用下面给出的文字；不要输出解释、不要输出代码块围栏。',
].join('\n');

/**
 * 拼提示词。事实清单直接复用 `scmFactsToMarkdown()`——
 * 同一份事实既能在 AI 不可用时当兜底产出，也能当模型的事实底稿，
 * 两条路径看到的数字**同源同形**，不会出现「兜底版和 AI 版数字不一致」。
 */
export function buildScmMessages(facts: ScmFacts): LlmMessage[] {
  const user = [
    '# 事实清单（程序汇总，唯一可用数字来源）',
    '',
    scmFactsToMarkdown(facts),
    '',
    '# 写作要求',
    '',
    `1. 一级标题固定为「# 供应链运营全景」，副标题写基准日 ${facts.asOf}。`,
    `2. 二级小节依次为：${SCM_SECTIONS.map((s) => `「## ${s}」`).join('、')}，顺序与文字不得改动。`,
    '3. 每节 2–5 条要点，先结论后数字；项目对照一节用 Markdown 表格（与事实清单同列）。',
    facts.empty
      ? '4. 本次事实清单为空：如实说明「所选范围内没有可统计的合同数据」，不要虚构任何项目或金额。'
      : '4. 风险与建议一节只许转述清单里「风险与建议」已有的条目；清单没列风险时，写「程序未发现可判定的异常」并提示数据完整性仍需人工确认。',
    '5. 全文控制在 600–1200 字，不要重复同一组数字。',
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

/** 产出里缺少的小节（前端据此提示，不阻断展示） */
export function missingScmSections(markdown: string): string[] {
  const text = String(markdown ?? '');
  return SCM_SECTIONS.filter((s) => !text.includes(s));
}

/**
 * MCP `prompts` 原语：把本系统的**口径提示词原文**暴露给外部 AI。
 *
 * 为什么需要：外部 AI 通过 MCP 查本系统数据时不知道本企业口径——于是出现「自己算合计」
 * 「编造增长率」「没命中的当成没问题」。系统内的 prompt 已把红线写死（数字只能抄事实清单、
 * 不许计算、不许定性、缺数据必须说明），这里让外部 AI 用**同一份原文**。
 *
 * 边界：
 * - 本文件**只声明结构**（key / 标题 / 一句话描述 / 参数），正文一律向服务端取
 *   （`GET /api/ai/prompts/:key`，单一事实源在 `server/src/modules/ai-insight/prompt-catalog.ts`）；
 * - 所以系统更新口径后，外部 AI 下次 `prompts/get` 自动拿到新版本，本包不需要跟着发版；
 * - `key` 与参数名由 `server/test/aiPrompts.spec.mts` 锁住（多余/缺失都会红）；
 *   标题与描述是**本包侧的提示文字**，允许此处更口语化。
 */
export interface McpPromptArg {
  name: string;
  description: string;
  required: boolean;
}

export interface McpPromptSpec {
  /** 与 server 侧 catalog 的 key 一致（锁死） */
  key: string;
  title: string;
  description: string;
  args: McpPromptArg[];
}

export const PROMPTS: McpPromptSpec[] = [
  {
    key: 'cms_report',
    title: '汇报材料口径',
    description:
      '写经营/项目汇报材料前先读这个：数字只能抄事实清单、不许自己算、缺数据必须说清、按固定公文骨架输出。',
    args: [
      { name: 'kind', description: '材料类型：monthly（月度）/ project（项目履约）/ brief（领导摘要），默认 monthly', required: false },
      { name: 'extra', description: '补充写作要求，例如「重点写付款风险」', required: false },
    ],
  },
  {
    key: 'cms_payment_anomaly',
    title: '结算/付款异常预警口径',
    description:
      '把程序判定出的结算/付款疑点写成结论时的红线：不许计算新数字、不许法律税务定性、未参与判定的规则必须说明。',
    args: [],
  },
  {
    key: 'cms_supply_chain',
    title: '供应链运营全景口径',
    description: '写供应链运营全景报告时的红线与四节固定结构（总体情况 / 项目对照 / 供应商集中度 / 风险与建议）。',
    args: [],
  },
];

export function getPromptSpec(key: string): McpPromptSpec {
  const spec = PROMPTS.find((p) => p.key === key);
  if (!spec) throw new Error(`未知提示词：${key}（可用：${PROMPTS.map((p) => p.key).join(', ')}）`);
  return spec;
}

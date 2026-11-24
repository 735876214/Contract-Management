/**
 * **口径提示词的单一事实源**（对外暴露给 MCP 的 `prompts` 原语）。
 *
 * 为什么要有这东西：外部 AI（Claude Desktop / Cursor / 任意 MCP 客户端）通过 MCP 查本系统数据时，
 * 它自己并不知道本企业的口径——于是会出现「自己算合计」「编造增长率」「把没命中的当成没问题」。
 * 本系统的 prompt 里已经把红线写死了（数字只能抄事实清单、不许计算、不许定性、缺数据必须说）。
 * 把这些**原文**通过 MCP `prompts/list` / `prompts/get` 暴露出去，外部 AI 就能用同一套口径，
 * 而不是每次让使用者在聊天框里口述一遍。
 *
 * 边界：
 * - 这里只有**静态文本**，不含任何业务数据、不含密钥；
 * - 提示词正文仍然是各 prompt 文件里那一份（`REPORT_SYSTEM_PROMPT` / `ANOMALY_SYSTEM_PROMPT` /
 *   `SCM_SYSTEM_PROMPT`），本文件只做「曝光 + 补取数说明」，**不复制正文**；
 * - 加新提示词 = 往 `AI_PROMPT_CATALOG` 加一项 + 在 `mcp/src/prompts.ts` 登记 key，
 *   `server/test/aiPrompts.spec.mts` 会锁住两边一致。
 */
import { SCM_SECTIONS, SCM_SYSTEM_PROMPT } from './analysis/scm-prompt.ts';
import { ANOMALY_SYSTEM_PROMPT } from './anomaly/anomaly-prompt.ts';
import { REPORT_KINDS, type ReportKind } from './report-facts.ts';
import { REPORT_SYSTEM_PROMPT } from './report-prompt.ts';
import { templatePromptText } from './report-templates.ts';

export interface AiPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface AiPromptDef {
  /** MCP prompt 名（`prompts/list` 里的 name） */
  key: string;
  title: string;
  description: string;
  arguments: AiPromptArgument[];
  /** 需要先取哪些数据（写给外部 AI 的取数建议，对应 mcp 的资源 key） */
  dataSources: string[];
  /** 把口径渲染成可直接喂给模型的提示词正文 */
  render: (args: Record<string, string | undefined>) => string;
}

/** 每份提示词的公共前缀：说明来源、取数方式、以及「数字从哪来」这条最容易越界的约束 */
function withPreamble(scope: string, dataSources: string[], body: string): string {
  return [
    `# ${scope}（企业合同管理系统 CMS 的口径原文）`,
    '',
    '这份提示词由本系统的维护者定义、随系统版本发布，**不是**模型自由发挥的产物。',
    '它与系统内 AI 助手用的是同一份原文，所以按它产出的结论与系统内产出可比。',
    '',
    '## 取数方式',
    '- 数据只能用本 MCP 的工具取：`cms_query` / `cms_get` / `cms_export` / `cms_export_contract_word`。',
    '- 取不到的数据就是没有，**不要用常识或经验补齐**。',
    ...dataSources.map((s) => `- ${s}`),
    '',
    '## 口径（原文，逐条遵守）',
    '',
    body,
  ].join('\n');
}

const REPORT_DATA_SOURCES = [
  '合同与金额：`cms_query` resource=contracts（需 projectId）',
  '结算与付款：resource=settlements / payments',
  '发票：resource=invoices；台账：resource=ledger',
];

const ANOMALY_DATA_SOURCES = [
  '结算单与付款流水：`cms_query` resource=settlements / payments',
  '合同金额：resource=contracts',
  '注意：疑点必须由程序按规则判定后交给模型写结论；**不要让模型自己「找异常」**。',
];

const SCM_DATA_SOURCES = [
  '合同：resource=contracts；结算：resource=settlements；付款：resource=payments',
  '供应商集中度需要按供应商汇总合同金额，请在取数后**自己不要算**——本口径要求数字全部来自事实清单，',
  '  若需汇总口径，请改用系统内的「供应链运营全景」接口（`GET /api/ai/analysis/supply-chain`）。',
];

export const AI_PROMPT_CATALOG: AiPromptDef[] = [
  {
    key: 'cms_report',
    title: '汇报材料口径',
    description:
      '写经营/项目汇报材料时应该遵守的口径：数字只能抄事实清单、不许自算、缺数据必须说清、按固定公文骨架输出。',
    arguments: [
      {
        name: 'kind',
        description: `材料类型：${Object.keys(REPORT_KINDS).join(' / ')}（默认 monthly）`,
        required: false,
      },
      { name: 'extra', description: '补充写作要求（例如「重点写付款风险」）', required: false },
    ],
    dataSources: REPORT_DATA_SOURCES,
    render: (args) => {
      const raw = String(args.kind || 'monthly').trim() as ReportKind;
      const kind = (REPORT_KINDS[raw] ? raw : 'monthly') as ReportKind;
      const meta = REPORT_KINDS[kind];
      return withPreamble('汇报材料', REPORT_DATA_SOURCES, [
        REPORT_SYSTEM_PROMPT,
        '',
        '## 公文骨架（节标题逐字使用，不得改写、增删、调整顺序）',
        '',
        templatePromptText(kind),
        '',
        `## 本次材料类型：${meta.label}`,
        `写作要求：${meta.hint}`,
        args.extra ? `补充要求：${String(args.extra)}` : '',
      ]
        .filter((l) => l !== '')
        .join('\n'));
    },
  },
  {
    key: 'cms_payment_anomaly',
    title: '结算/付款异常预警口径',
    description:
      '把程序判定出的结算/付款疑点写成结论与动作建议时应该遵守的口径（不许计算、不许定性、未判定范围必须说明）。',
    arguments: [],
    dataSources: ANOMALY_DATA_SOURCES,
    render: () => withPreamble('结算与付款异常预警', ANOMALY_DATA_SOURCES, ANOMALY_SYSTEM_PROMPT),
  },
  {
    key: 'cms_supply_chain',
    title: '供应链运营全景口径',
    description:
      '写供应链运营全景报告时应该遵守的口径：四节固定结构、数字只能引用事实清单、数据缺口必须写明。',
    arguments: [],
    dataSources: SCM_DATA_SOURCES,
    render: () =>
      withPreamble('供应链运营全景', SCM_DATA_SOURCES, [
        SCM_SYSTEM_PROMPT,
        '',
        '## 固定小节（逐字使用，缺节即废稿）',
        '',
        ...SCM_SECTIONS.map((s) => `## ${s}`),
      ].join('\n')),
  },
];

export const AI_PROMPT_MAP: Record<string, AiPromptDef> = Object.fromEntries(
  AI_PROMPT_CATALOG.map((p) => [p.key, p]),
);

/** 只读元信息（`GET /api/ai/prompts` 与 MCP `prompts/list` 用，不含正文） */
export function listAiPrompts() {
  return AI_PROMPT_CATALOG.map(({ key, title, description, arguments: args, dataSources }) => ({
    key,
    title,
    description,
    arguments: args,
    dataSources,
  }));
}

/** 渲染指定提示词；未知 key 抛错（不静默返回空串，否则外部 AI 会以为口径就是这样） */
export function renderAiPrompt(key: string, args: Record<string, string | undefined> = {}) {
  const def = AI_PROMPT_MAP[key];
  if (!def) {
    throw new Error(`未知提示词：${key}（可用：${AI_PROMPT_CATALOG.map((p) => p.key).join(', ')}）`);
  }
  return { key: def.key, title: def.title, text: def.render(args) };
}

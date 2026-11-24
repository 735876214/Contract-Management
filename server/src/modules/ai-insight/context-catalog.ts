/**
 * **AI 口径上下文**（对外经 MCP `resources` 原语暴露的只读文本）。
 *
 * 问题：外部 AI 通过 MCP 拿到 `status: 'PARTIAL'`、`owner: 'ledger'` 这样的字段后，
 * 会按自己的理解解释——于是出现「把失败付款算进累计付款」「自己给采购任务编一个阶段顺序」
 * 「把台账的合同额当成看板的合同额」。这些不是幻觉，是**缺口径**：系统里有唯一答案，只是没告诉它。
 *
 * 解法：把 `server/src/constants/` 里的口径**原文**渲染成只读文档，经 MCP resources 暴露。
 *
 * 三条铁律：
 * 1. **不手写第二份**：本文件全部内容由 `constants/{statuses,procurementFlow,metrics}.ts` 生成，
 *    常量改了文档自动跟着变（`server/test/aiContext.spec.mts` 锁住「每个常量都要出现在文档里」）；
 * 2. **只读、无业务数据、无密钥**：这里说的是「字段值是什么意思」，不是「某项目有多少钱」；
 * 3. **中文标签不在这里**：字典驱动的状态码，标签存在库里（`DictItem`），所以文档里明确指路
 *    `cms://dict/{typeCode}`——硬编码一份标签就是第二事实源。
 */
import { METRICS } from '../../constants/metrics.ts';
import * as FLOW from '../../constants/procurementFlow.ts';
import * as STATUSES from '../../constants/statuses.ts';

export type ContextKey = 'statuses' | 'procurement-flow' | 'metrics';

export interface ContextDocMeta {
  key: ContextKey;
  /** MCP resource 的 uri */
  uri: string;
  title: string;
  description: string;
}

interface ContextDoc extends ContextDocMeta {
  markdown: string;
}

// ---------------------------------------------------------------------------
// 状态码文档
// ---------------------------------------------------------------------------

/**
 * 这些是「类型枚举」而不是「状态」，另作渲染（混进状态表会让人以为 `FRAMEWORK` 是个状态）。
 */
const NOT_STATUS_GROUPS = new Set([
  'DICT_TYPES',
  'TASK_TYPES',
  'CONTRACT_TYPES',
  'CONTRACT_STATUS_TO_TASK_STATUS',
]);

/** 状态分组的中文标题。新增常量没登记时回落成 key 名（不会漏，只是不好看）。 */
const STATUS_GROUP_TITLE: Record<string, string> = {
  CONTRACT_STATUS: '合同状态（Contract.status，非字典驱动）',
  SETTLEMENT_STATUS: '结算单状态（dict: settlement_status）',
  PAYMENT_STATUS: '付款状态（dict: payment_status）',
  INVOICE_STATUS: '发票状态（dict: invoice_status）',
  INVOICE_REVIEW_STATUS: '发票复核状态（dict: invoice_review_status）',
  CONTRACT_EXECUTION_STATUS: '合同履行状态（dict: contract_execution_status）',
  FINAL_SETTLEMENT_STATUS: '总结算单状态（dict: final_settlement_status）',
  SITE_CONFIRM_STATUS: '现场确认状态（dict: site_confirm_status）',
  BIDDER_STATUS: '投标人状态（dict: bidder_status）',
  EVALUATION_CONCLUSION: '评标结论（dict: evaluation_conclusion）',
  MILESTONE_STATUS: '里程碑状态',
  SUBCONTRACTOR_STATUS: '分包商状态',
  LABOR_RECEIVING_DOC_STATUS: '分包收领单状态',
  MODULE_RECORD_STATUS: '通用模块单据状态',
  RECEIPT_STATUS: '收领单状态',
  TASK_STATUS: '采购任务状态（非字典驱动，标签见采购工作流文档）',
};

interface StatusGroup {
  key: string;
  title: string;
  codes: string[];
}

/** 从 `constants/statuses.ts` 里识别「码 → 码」形式的常量对象（值全为非空字符串） */
function statusGroups(): StatusGroup[] {
  const out: StatusGroup[] = [];
  for (const [key, value] of Object.entries(STATUSES as Record<string, unknown>)) {
    if (NOT_STATUS_GROUPS.has(key)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) continue;
    if (!entries.every(([, v]) => typeof v === 'string' && v.length > 0)) continue;
    out.push({ key, title: STATUS_GROUP_TITLE[key] ?? key, codes: entries.map(([, v]) => String(v)) });
  }
  return out;
}

/** 「不计入统计」的排除项（口径级信息：AI 最容易在这里自己发明规则） */
function exclusionSets(): Array<{ key: string; codes: string[] }> {
  const out: Array<{ key: string; codes: string[] }> = [];
  for (const [key, value] of Object.entries(STATUSES as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    if (!/_EXCLUDED_(STATUSES|STATUS)$/.test(key)) continue;
    out.push({ key, codes: value.map((v) => String(v)) });
  }
  return out;
}

const EXCLUSION_NOTE: Record<string, string> = {
  PAYMENT_EXCLUDED_STATUSES: '不构成实际出资，**不计入「累计付款」**（防超付闸门与合同台账共用这一份）',
  INVOICE_EXCLUDED_STATUSES: '作废/红冲，**不计入开票统计**',
};

function renderStatuses(): string {
  const groups = statusGroups();
  const excludes = exclusionSets();
  const dictTypes = Object.entries((STATUSES as any).DICT_TYPES ?? {}) as Array<[string, string]>;

  return [
    '# 状态码与统计排除项（口径原文）',
    '',
    '本系统的 `status` 字段下面这些是**全部合法取值**。取值不在表里的行，要么是历史数据，要么是查询条件写错了。',
    '',
    '## 不计入统计的状态（口径级，最容易被自行发明）',
    '',
    ...(excludes.length
      ? excludes.map((e) => `- \`${e.key}\`：${e.codes.join(' / ')}——${EXCLUSION_NOTE[e.key] ?? '不参与统计'}`)
      : ['- （本版本无常量级排除项）']),
    '',
    '> 做金额/数量汇总前请**明确排除**上表状态；若口径不在上面，说明系统没有这条规则，不要自己加。',
    '',
    '## 字典类型（dict typeCode）',
    '',
    '状态码的中文标签存在数据库里（`DictItem`），不在代码里。取标签请读资源 `cms://dict/{typeCode}`：',
    '',
    '| 常量 | typeCode |',
    '| --- | --- |',
    ...dictTypes.map(([k, v]) => `| ${k} | \`${v}\` |`),
    '',
    '## 状态码分组',
    '',
    ...groups.flatMap((g) => [
      `### ${g.title}`,
      '',
      `\`${g.key}\`：${g.codes.map((c) => `\`${c}\``).join(' / ')}`,
      '',
    ]),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 采购工作流文档
// ---------------------------------------------------------------------------

function renderProcurementFlow(): string {
  const stages = Object.entries(FLOW as Record<string, unknown>)
    .filter(([key, v]) => /^[A-Z_]+$/.test(key) && v && typeof v === 'object' && 'status' in (v as any))
    .map(([key, v]) => ({ key, ...(v as { label: string; status: string }) }));

  const taskTypes = (FLOW as any).TASK_TYPES as readonly string[];
  const statusLabels = (FLOW as any).TASK_STATUS_LABELS as Record<string, string>;

  // 每种采购类型 × 是否必经采前会 → 阶段链。相同链只写一次；两者的链相同就**不加**采前会限定，
  // 否则会出现「FRAMEWORK（必须开采前会）、FRAMEWORK（无需采前会）：同一条链」这种自相矛盾的读法。
  const stageChain = FLOW.stageChain as (
    t: string,
    preMeetingRequired: boolean,
  ) => Array<{ label: string }>;
  const chains = new Map<string, string[]>();
  for (const type of taskTypes) {
    const withMeeting = stageChain(type, true).map((x) => x.label).join(' → ');
    const withoutMeeting = stageChain(type, false).map((x) => x.label).join(' → ');
    const push = (sig: string, label: string) => {
      if (!chains.has(sig)) chains.set(sig, []);
      chains.get(sig)!.push(label);
    };
    if (withMeeting === withoutMeeting) {
      push(withMeeting, `\`${type}\`（采前会不改变阶段链）`);
    } else {
      push(withMeeting, `\`${type}\`（必须开采前会）`);
      push(withoutMeeting, `\`${type}\`（无需采前会）`);
    }
  }

  return [
    '# 采购工作流（口径原文）',
    '',
    '采购任务按**固定阶段链**推进：前一阶段未发布，后续阶段不可编辑（后端强制，不是前端约定）。',
    '',
    '## 采购类型',
    '',
    taskTypes.map((t) => `\`${t}\``).join(' / '),
    '',
    '## 阶段定义',
    '',
    '| 阶段 key | 名称 | 该阶段的任务状态 |',
    '| --- | --- | --- |',
    ...stages.map((s) => `| \`${s.key}\` | ${s.label} | \`${s.status}\` |`),
    '',
    '## 阶段链（按类型）',
    '',
    ...[...chains.entries()].flatMap(([sig, combos]) => [`- ${combos.join('、')}：${sig}`]),
    '',
    '## 任务状态与中文标签',
    '',
    '| code | 含义 |',
    '| --- | --- |',
    ...Object.entries(statusLabels).map(([code, label]) => `| \`${code}\` | ${label} |`),
    '',
    '> 「合同编制中 / 合同待签章」属于采购任务状态，不代表合同自身的状态；合同状态见资源 `cms://context/statuses`。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 指标口径文档
// ---------------------------------------------------------------------------

function renderMetrics(): string {
  return [
    '# 报表指标口径登记表（口径原文）',
    '',
    '每个对外可见的金额/数量指标**只有一处实现**，由下表登记。AI 引用金额时按这里的口径理解，',
    '不要自己重新定义（例如「合同额」是否含补充协议、「累计付款」排除哪些状态）。',
    '',
    '| 指标 id | 名称 | owner 模块 | 口径说明 | 唯一实现 |',
    '| --- | --- | --- | --- | --- |',
    ...METRICS.map(
      (m) => `| \`${m.id}\` | ${m.name} | ${m.owner} | ${m.note} | \`${m.impl}\` |`,
    ),
    '',
    '> 上表之外的金额口径**系统没有定义**。遇到用户口径与本表冲突时，以本表为准并说明差异。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 对外
// ---------------------------------------------------------------------------

const DOCS: ContextDoc[] = [
  {
    key: 'statuses',
    uri: 'cms://context/statuses',
    title: '状态码与统计排除项',
    description:
      '本系统所有 status 字段的合法取值、不计入统计的状态（如失败/退款付款不计入累计付款）、以及字典类型清单。',
    markdown: renderStatuses(),
  },
  {
    key: 'procurement-flow',
    uri: 'cms://context/procurement-flow',
    title: '采购工作流',
    description: '采购任务的类型、固定阶段链（前一阶段未发布后续不可编辑）、阶段与状态的对应关系。',
    markdown: renderProcurementFlow(),
  },
  {
    key: 'metrics',
    uri: 'cms://context/metrics',
    title: '报表指标口径登记表',
    description: '每个金额/数量指标的唯一实现、owner 与口径说明（含关键排除项）。引用金额前必读。',
    markdown: renderMetrics(),
  },
];

export const CONTEXT_DOC_MAP: Record<string, ContextDoc> = Object.fromEntries(DOCS.map((d) => [d.key, d]));

/** 列表（只回元信息，不带正文——避免 list 变成整份口径外发） */
export function listContextDocs(): ContextDocMeta[] {
  return DOCS.map(({ key, uri, title, description }) => ({ key, uri, title, description }));
}

/** 渲染指定文档；未知 key 抛错（不静默返回空串） */
export function renderContextDoc(key: string): { key: string; uri: string; title: string; markdown: string } {
  const doc = CONTEXT_DOC_MAP[key];
  if (!doc) throw new Error(`未知口径文档：${key}（可用：${DOCS.map((d) => d.key).join(', ')}）`);
  return { key: doc.key, uri: doc.uri, title: doc.title, markdown: doc.markdown };
}

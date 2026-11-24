/**
 * MCP `resources` 原语：把本系统的**口径上下文**暴露给外部 AI。
 *
 * 问题：外部 AI 拿到 `status: 'PARTIAL'`、`execStatus: 'DONE_UNSETTLED'` 之后会按自己的理解解释，
 * 于是出现「把失败付款算进累计付款」「自己给采购任务编一个阶段顺序」「把台账合同额当成看板合同额」。
 * 这些不是幻觉，是**缺口径**：系统里有唯一答案，只是没告诉它。
 *
 * 边界：
 * - 本文件只声明 uri 与元信息，正文一律向服务端取
 *   （`GET /api/ai/context/:key`，单一事实源在 `server/src/modules/ai/context-catalog.ts`，
 *   而那份文档本身又由 `server/src/constants/*` 生成）；
 * - 只读、无业务数据、无密钥——说的是「字段值是什么意思」，不是「某项目有多少钱」；
 * - `key` 由 `server/test/aiContext.spec.mts` 锁住与服务端一致。
 */
export interface McpContextResource {
  /** 与服务端 `context-catalog` 的 key 一致（锁死） */
  key: string;
  /** MCP resource uri */
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const CONTEXT_RESOURCES: McpContextResource[] = [
  {
    key: 'statuses',
    uri: 'cms://context/statuses',
    name: '状态码与统计排除项',
    description:
      '所有 status 字段的合法取值；**不计入统计的状态**（失败/退款付款不计入累计付款、作废/红冲发票不计入开票统计）；字典类型清单。做汇总前必读。',
    mimeType: 'text/markdown',
  },
  {
    key: 'procurement-flow',
    uri: 'cms://context/procurement-flow',
    name: '采购工作流',
    description:
      '采购任务的类型、固定阶段链（前一阶段未发布后续不可编辑）、阶段与任务状态的对应关系。判断「任务卡在哪一步」前必读。',
    mimeType: 'text/markdown',
  },
  {
    key: 'metrics',
    uri: 'cms://context/metrics',
    name: '报表指标口径登记表',
    description:
      '每个金额/数量指标的唯一实现、owner 与口径说明（含关键排除项，如「累计结算排除草稿」「合同额按链根只计一次」）。引用任何金额前必读。',
    mimeType: 'text/markdown',
  },
];

/**
 * 字典项资源模板：`cms://dict/{typeCode}` → `[{ value, label, color, extField1 }]`。
 *
 * 为什么单列一条模板：状态码的中文标签**存在数据库里**（`DictItem`），不在代码里。
 * 上面那份 statuses 文档只有 code，没有中文名——标签必须走这条资源取，
 * 否则就是在 MCP 里硬编码一份标签（第二事实源）。
 */
export const DICT_URI_TEMPLATE = 'cms://dict/{typeCode}';

export function getContextResource(key: string): McpContextResource {
  const spec = CONTEXT_RESOURCES.find((r) => r.key === key);
  if (!spec) throw new Error(`未知口径资源：${key}（可用：${CONTEXT_RESOURCES.map((r) => r.key).join(', ')}）`);
  return spec;
}

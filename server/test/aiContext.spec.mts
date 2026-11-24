import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONTEXT_DOC_MAP, listContextDocs, renderContextDoc } from '../src/modules/ai/context-catalog.ts';
import { METRICS } from '../src/constants/metrics.ts';
import * as FLOW from '../src/constants/procurementFlow.ts';
import * as STATUSES from '../src/constants/statuses.ts';

/**
 * **AI 口径上下文锁**（2026-11-24 P2，MCP `resources` 原语）。
 *
 * 这三份文档是给外部 AI 读的「字段值是什么意思」：状态码、采购阶段链、金额指标口径。
 * 它们**全部由 `server/src/constants/*` 生成**，所以真正的风险不是「写错」而是「漏掉」——
 * 常量加了新状态/新指标，文档没跟上，外部 AI 就会按旧口径解释新数据（且不会有任何报错）。
 *
 * 本锁逐条校验「常量里的每一项都在文档里出现」，并顺带保护：
 *   - 统计排除项（失败/退款付款不计入累计付款）必须在文档里——这是最容易被模型自行发明的一条；
 *   - 文档必须指路字典资源（标签在库里，不在代码里，不许硬编码第二份）；
 *   - `mcp/src/context.ts` 的 key 与服务端目录一致（否则外部 AI 看到一个取不到的资源）。
 */

const mcpContextSrc = readFileSync(
  fileURLToPath(new URL('../../mcp/src/context.ts', import.meta.url)),
  'utf8',
);

const statusesDoc = renderContextDoc('statuses').markdown;
const flowDoc = renderContextDoc('procurement-flow').markdown;
const metricsDoc = renderContextDoc('metrics').markdown;

describe('AI 口径上下文（MCP resources 的单一事实源）', () => {
  it('目录非空、key/uri 唯一且 uri 走 cms://context 前缀', () => {
    const docs = listContextDocs();
    assert.ok(docs.length >= 3, `口径文档过少（${docs.length}）`);
    assert.equal(new Set(docs.map((d) => d.key)).size, docs.length, 'key 重复');
    assert.equal(new Set(docs.map((d) => d.uri)).size, docs.length, 'uri 重复');
    for (const d of docs) {
      assert.match(d.uri, /^cms:\/\/context\/[a-z-]+$/, `uri 形态不对：${d.uri}`);
      assert.ok(d.title.length > 0 && d.description.length > 0, `${d.key} 缺标题或描述`);
    }
  });

  it('状态码文档覆盖每个状态常量分组与其中的每个码', () => {
    // 与 context-catalog 同一条发现规则：值全为非空字符串的导出对象 = 一个状态分组
    const skip = new Set(['DICT_TYPES', 'TASK_TYPES', 'CONTRACT_TYPES', 'CONTRACT_STATUS_TO_TASK_STATUS']);
    const groups = Object.entries(STATUSES as Record<string, unknown>).filter(([key, value]) => {
      if (skip.has(key)) return false;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const entries = Object.entries(value as Record<string, unknown>);
      return entries.length > 0 && entries.every(([, v]) => typeof v === 'string' && v.length > 0);
    }) as Array<[string, Record<string, string>]>;

    assert.ok(groups.length >= 12, `只识别到 ${groups.length} 个状态分组，识别规则或常量结构已变`);
    const missing: string[] = [];
    for (const [key, value] of groups) {
      if (!statusesDoc.includes(key)) missing.push(`分组 ${key} 未出现在文档里`);
      for (const code of Object.values(value)) {
        if (!statusesDoc.includes(code)) missing.push(`${key} 的码 ${code} 未出现在文档里`);
      }
    }
    assert.deepEqual(missing, [], `状态码文档漏了常量：\n  ${missing.join('\n  ')}`);
  });

  it('统计排除项必须在文档里（最容易被外部 AI 自行发明的一条口径）', () => {
    const excludes = Object.entries(STATUSES as Record<string, unknown>).filter(
      ([key, value]) => Array.isArray(value) && /_EXCLUDED_(STATUSES|STATUS)$/.test(key),
    ) as Array<[string, string[]]>;
    assert.ok(excludes.length >= 1, '没有发现任何 *_EXCLUDED_STATUSES 常量（排除项口径丢失？）');
    for (const [key, codes] of excludes) {
      assert.ok(statusesDoc.includes(key), `文档里没有排除项常量 ${key}`);
      for (const code of codes) {
        assert.ok(statusesDoc.includes(code), `排除项 ${key} 的码 ${code} 未出现在文档里`);
      }
    }
  });

  it('状态码文档列出全部字典类型，并指路字典资源（标签在库里，不许硬编码第二份）', () => {
    const dictTypes = Object.values((STATUSES as any).DICT_TYPES as Record<string, string>);
    assert.ok(dictTypes.length >= 8, `字典类型过少（${dictTypes.length}）`);
    for (const t of dictTypes) {
      assert.ok(statusesDoc.includes(t), `字典类型 ${t} 未出现在文档里`);
    }
    assert.ok(
      statusesDoc.includes('cms://dict/{typeCode}'),
      '状态码文档必须指路字典资源 cms://dict/{typeCode}——否则外部 AI 拿不到中文标签，只能自己编',
    );
  });

  it('采购工作流文档覆盖阶段、类型、阶段链与每条任务状态的中文标签', () => {
    const stageLabels = Object.entries(FLOW as Record<string, unknown>)
      .filter(([key, v]) => /^[A-Z_]+$/.test(key) && v && typeof v === 'object' && 'status' in (v as any))
      .map(([, v]) => (v as { label: string }).label);
    assert.ok(stageLabels.length >= 5, `只识别到 ${stageLabels.length} 个阶段`);
    for (const label of stageLabels) {
      assert.ok(flowDoc.includes(label), `阶段「${label}」未出现在文档里`);
    }
    for (const t of (FLOW as any).TASK_TYPES as readonly string[]) {
      assert.ok(flowDoc.includes(t), `采购类型 ${t} 未出现在文档里`);
    }
    const labels = (FLOW as any).TASK_STATUS_LABELS as Record<string, string>;
    for (const [code, label] of Object.entries(labels)) {
      assert.ok(flowDoc.includes(code), `任务状态 ${code} 未出现在文档里`);
      assert.ok(flowDoc.includes(label), `任务状态 ${code} 的中文标签「${label}」未出现在文档里`);
    }
    // 阶段链必须真的渲染出来（不是只列了阶段定义）
    assert.match(flowDoc, /编制总采购清单 → /, '阶段链没有渲染（只有阶段定义表）');
  });

  it('指标口径文档覆盖登记表里每个指标的 id / 名称 / owner', () => {
    assert.ok(METRICS.length >= 10, `指标过少（${METRICS.length}）`);
    for (const m of METRICS) {
      assert.ok(metricsDoc.includes(m.id), `指标 ${m.id} 未出现在文档里`);
      assert.ok(metricsDoc.includes(m.name), `指标 ${m.id} 的名称「${m.name}」未出现`);
      assert.ok(metricsDoc.includes(m.owner), `指标 ${m.id} 的 owner「${m.owner}」未出现`);
    }
  });

  it('未知 key 抛错；正文不含机密字段名', () => {
    assert.throws(() => renderContextDoc('not_a_doc'), /未知口径文档/);
    for (const key of Object.keys(CONTEXT_DOC_MAP)) {
      const text = CONTEXT_DOC_MAP[key].markdown;
      assert.ok(!/api[-_]?key|password|secret|bearer/i.test(text), `${key} 正文疑似包含机密字段名`);
    }
  });

  it('列表只回元信息（不带正文）', () => {
    for (const item of listContextDocs()) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'markdown'), false, `${item.key} 的列表项带上了正文`);
    }
  });

  it('mcp/src/context.ts 的 key 与服务端目录一致，且声明了字典模板', () => {
    const mcpKeys = [...mcpContextSrc.matchAll(/^    key: '([a-z-]+)',$/gm)].map((m) => m[1]);
    assert.ok(mcpKeys.length >= 3, `mcp/src/context.ts 只解析到 ${mcpKeys.length} 个 key`);
    assert.deepEqual(
      [...mcpKeys].sort(),
      Object.keys(CONTEXT_DOC_MAP).sort(),
      'mcp 侧口径资源与服务端目录不一致：多一个会取到 404，少一个外部 AI 就少一份口径',
    );
    assert.ok(
      mcpContextSrc.includes("cms://dict/{typeCode}"),
      'mcp/src/context.ts 必须声明字典资源模板 cms://dict/{typeCode}',
    );
  });
});

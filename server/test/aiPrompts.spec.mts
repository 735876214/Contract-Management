import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AI_PROMPT_CATALOG,
  listAiPrompts,
  renderAiPrompt,
} from '../src/modules/ai-insight/prompt-catalog.ts';
import { REPORT_KINDS } from '../src/modules/ai-insight/report-facts.ts';
import { REPORT_SYSTEM_PROMPT } from '../src/modules/ai-insight/report-prompt.ts';
import { ANOMALY_SYSTEM_PROMPT } from '../src/modules/ai-insight/anomaly/anomaly-prompt.ts';
import { SCM_SECTIONS, SCM_SYSTEM_PROMPT } from '../src/modules/ai-insight/analysis/scm-prompt.ts';

/**
 * **口径提示词目录锁**（2026-11-24 P1，MCP `prompts` 原语）。
 *
 * 背景：外部 AI 经 MCP 查本系统数据时并不知道本企业口径，于是「自己算合计」「编造增长率」
 * 「没命中的当成没问题」。解法是把系统内 prompt 的红线**原文**通过 MCP 暴露出去。
 *
 * 这条锁保证三件事：
 *   ① 渲染出来的正文里**确实含口径原文**（不是另写一份摘要）；
 *   ② 公文骨架/固定小节是**逐字**的（这几节标题被前端用来判「材料缺节」，改一个字就失效）；
 *   ③ `mcp/src/prompts.ts` 声明的 key 与服务端目录一致——否则外部 AI 看到的是一个取不到的提示词。
 */

const mcpPromptsSrc = readFileSync(
  fileURLToPath(new URL('../../mcp/src/prompts.ts', import.meta.url)),
  'utf8',
);

describe('AI 口径提示词目录（MCP prompts 的单一事实源）', () => {
  it('目录非空、key 唯一且形如小写下划线', () => {
    assert.ok(AI_PROMPT_CATALOG.length >= 3, `提示词过少（${AI_PROMPT_CATALOG.length}），可能被误删`);
    const keys = AI_PROMPT_CATALOG.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, `key 重复：${keys.join(', ')}`);
    for (const k of keys) assert.match(k, /^[a-z][a-z0-9_]*$/, `key 形态不对：${k}`);
  });

  it('渲染正文必须含口径原文（汇报材料 / 异常预警 / 供应链全景）', () => {
    const report = renderAiPrompt('cms_report').text;
    assert.ok(report.includes(REPORT_SYSTEM_PROMPT), '汇报材料的正文里没有 REPORT_SYSTEM_PROMPT——说明另写了一份摘要，口径会两套');

    const anomaly = renderAiPrompt('cms_payment_anomaly').text;
    assert.ok(anomaly.includes(ANOMALY_SYSTEM_PROMPT), '异常预警的正文里没有 ANOMALY_SYSTEM_PROMPT');

    const scm = renderAiPrompt('cms_supply_chain').text;
    assert.ok(scm.includes(SCM_SYSTEM_PROMPT), '供应链全景的正文里没有 SCM_SYSTEM_PROMPT');
    // 固定小节逐字：前端与 audit 用它判「材料缺节」，改一个字就失效
    for (const section of SCM_SECTIONS) {
      assert.ok(scm.includes(section), `供应链全景缺少固定小节「${section}」`);
    }
  });

  it('汇报材料按 kind 切换公文骨架，非法 kind 回落 monthly 而不是抛错', () => {
    const monthly = renderAiPrompt('cms_report', { kind: 'monthly' }).text;
    const project = renderAiPrompt('cms_report', { kind: 'project' }).text;
    assert.notEqual(monthly, project, '两种材料类型的正文相同——说明 kind 没生效');
    assert.ok(monthly.includes(REPORT_KINDS.monthly.label));
    assert.ok(project.includes(REPORT_KINDS.project.label));
    // kind 来自 query string，任何脏值都不能 500
    const fallback = renderAiPrompt('cms_report', { kind: '不存在的类型' }).text;
    assert.ok(fallback.includes(REPORT_KINDS.monthly.label), '非法 kind 应回落 monthly');
    const withExtra = renderAiPrompt('cms_report', { extra: '重点写付款风险' }).text;
    assert.ok(withExtra.includes('重点写付款风险'), '补充要求没进正文');
  });

  it('未知 key 抛错而不是静默返回空串（空串会让外部 AI 以为口径就是空的）', () => {
    assert.throws(() => renderAiPrompt('not_a_prompt'), /未知提示词/);
  });

  it('正文不含任何机密字段名（这是给外部 AI 的文本，不能带密钥线索）', () => {
    for (const p of AI_PROMPT_CATALOG) {
      const text = p.render({});
      assert.ok(!/api[-_]?key|password|secret|token/i.test(text), `${p.key} 的正文疑似包含机密字段名`);
    }
  });

  it('列表接口只回元信息（不含正文，避免 prompts/list 变成大口径外发）', () => {
    const list = listAiPrompts();
    assert.equal(list.length, AI_PROMPT_CATALOG.length);
    for (const item of list) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'text'), false, `${item.key} 的列表项里带上了正文`);
      assert.ok(item.title.length > 0 && item.description.length > 0, `${item.key} 缺标题或描述`);
      assert.ok(Array.isArray(item.dataSources) && item.dataSources.length > 0, `${item.key} 缺 dataSources（AI 不知道去哪取数）`);
    }
  });

  it('mcp/src/prompts.ts 声明的 key 与服务端目录一致（否则外部 AI 会看到一个取不到的提示词）', () => {
    const mcpKeys = [...mcpPromptsSrc.matchAll(/^    key: '([a-z0-9_]+)',$/gm)].map((m) => m[1]);
    assert.ok(mcpKeys.length >= 3, `mcp/src/prompts.ts 里只解析到 ${mcpKeys.length} 个 key，解析面可能已变`);
    assert.deepEqual(
      [...mcpKeys].sort(),
      AI_PROMPT_CATALOG.map((p) => p.key).sort(),
      'mcp 侧提示词清单与服务端目录不一致：多一个会 404，少一个外部 AI 就少一份口径',
    );
    // 参数名同样要对齐（MCP 的 argsSchema 用它，写错等于参数永远传不进去）
    for (const p of AI_PROMPT_CATALOG) {
      const block = mcpPromptsSrc.split(`key: '${p.key}'`)[1] ?? '';
      for (const arg of p.arguments) {
        assert.ok(
          block.includes(`name: '${arg.name}'`),
          `mcp/src/prompts.ts 的 ${p.key} 缺少参数 ${arg.name}（服务端目录里有）`,
        );
      }
    }
  });
});

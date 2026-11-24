import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_TOOLS, CHAT_TOOL_NAMES, executeChatTool, type ChatToolContext } from '../src/modules/ai-insight/analytics/chat-tools.ts';
import { renderContextDoc } from '../src/modules/ai-insight/context-catalog.ts';

/**
 * **问数工具集锁**（P3-B）。
 *
 * 工具是「模型能主动索取的唯一外部动作面」，所以三条都要钉住：
 *  · **只读**：工具清单里只能是 read_context / query_dataset 两类，多一个写接口就是洞；
 *  · **参数受限**：doc 只能是白名单枚举，datasetKey 必须过权限与注册表；
 *  · **出错不炸**：未知工具/未知文档/无权限数据集都回一段可读说明让模型自己纠正，
 *    绝不抛异常把整轮对话打成 500（用户会以为系统坏了）。
 */

const ctx = (over: Partial<ChatToolContext> = {}): ChatToolContext => ({
  availableDatasets: ['contract.summary', 'settlement.summary'],
  collectDataset: async (key: string) =>
    key === 'invoice.records' ? { rowCount: 0, text: '# 数据集 invoice.records（共 0 行）' } : null,
  ...over,
});

describe('问数只读工具集', () => {
  it('工具清单只有两个只读工具（多一个写接口就是洞）', () => {
    assert.deepEqual(
      CHAT_TOOLS.map((t) => t.function.name).sort(),
      ['query_dataset', 'read_context'],
      `工具集变了：${CHAT_TOOLS.map((t) => t.function.name).join(', ')}——写操作不在本轮范围（P3-C 已暂缓）`,
    );
    assert.deepEqual([...CHAT_TOOL_NAMES].sort(), ['query_dataset', 'read_context']);
    for (const t of CHAT_TOOLS) {
      assert.equal(t.type, 'function');
      assert.ok(t.function.description.length > 10, `${t.function.name} 缺描述，模型不会正确选它`);
    }
  });

  it('read_context 返回口径原文（与 MCP resources 同一份）', async () => {
    const out = await executeChatTool('read_context', '{"doc":"statuses"}', ctx());
    assert.equal(out.ok, true);
    assert.equal(out.text, renderContextDoc('statuses').markdown, '必须是同一份正文，不许另写摘要');
    assert.ok(out.text.includes('PAYMENT_EXCLUDED_STATUSES'));
    assert.ok(out.label.includes('状态码'));
  });

  it('read_context 传未知 doc → 不抛错，回可用清单', async () => {
    const out = await executeChatTool('read_context', '{"doc":"nope"}', ctx());
    assert.equal(out.ok, false);
    assert.match(out.text, /statuses、procurement-flow、metrics/);
  });

  it('query_dataset 缺 key → 可读错误', async () => {
    const out = await executeChatTool('query_dataset', '{}', ctx());
    assert.equal(out.ok, false);
    assert.match(out.text, /datasetKey/);
  });

  it('query_dataset 取到数据 → 回行数与正文', async () => {
    const out = await executeChatTool('query_dataset', '{"datasetKey":"invoice.records"}', ctx());
    assert.equal(out.ok, true);
    assert.ok(out.label.includes('invoice.records'));
    assert.ok(out.text.includes('invoice.records'));
  });

  it('数据集无权限/不存在 → 回「已有可用」清单，让模型改用别的或说没有', async () => {
    const out = await executeChatTool('query_dataset', '{"datasetKey":"payment.records"}', ctx());
    assert.equal(out.ok, false);
    assert.match(out.text, /contract\.summary、settlement\.summary/);
    assert.match(out.text, /系统不包含该信息/);
  });

  it('参数不是合法 JSON → 按空对象处理，不抛错', async () => {
    const out = await executeChatTool('read_context', 'not-json', ctx());
    assert.equal(out.ok, false);
    assert.match(out.text, /statuses/);
  });

  it('未知工具 → 回可用清单而不是异常', async () => {
    const out = await executeChatTool('drop_table', '{}', ctx());
    assert.equal(out.ok, false);
    assert.match(out.text, /没有名为 drop_table 的工具/);
    assert.match(out.text, /read_context、query_dataset/);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callChat, LlmError } from '../src/modules/ai/llm-client.ts';

/**
 * 「空正文自动重试一次」的行为锁（2026-10-20 接入推理型模型时发现）。
 *
 * 现象：`only_reasoning` 模型把 `max_tokens` 先花在 `reasoning_content` 上，思考一长
 * 就 `finish_reason: "length"` + `content: ""`，调用方只看到「上游返回空内容」，
 * 表现为同样的提示词时好时坏。
 * 对策：预算烧在思考上时把 max_tokens 翻倍重试一次；真·空回复不重试（重试也是空）。
 */

const OPTS = {
  baseUrl: 'https://llm.example.com',
  apiKey: 'sk-test',
  model: 'test-reasoner',
  timeoutMs: 5000,
  maxTokens: 4000,
};

const MESSAGES = [{ role: 'user' as const, content: 'hi' }];

/** 造一个按顺序返回预设响应的假上游，并记录每次请求体 */
function fakeFetch(responses: Array<{ content?: string; reasoning?: string; finish?: string }>) {
  const bodies: any[] = [];
  const impl = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const r = responses[Math.min(bodies.length - 1, responses.length - 1)];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: { content: r.content ?? '', reasoning_content: r.reasoning ?? '' },
            finish_reason: r.finish ?? 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      text: async () => '',
    } as any;
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

describe('callChat 空正文重试（推理模型烧完 max_tokens）', () => {
  it('第一次只有思考、第二次有正文 → 返回正文，且第二次 max_tokens 翻倍', async () => {
    const { impl, bodies } = fakeFetch([
      { content: '', reasoning: '思考中…', finish: 'length' },
      { content: '{"ok":true}' },
    ]);
    const out = await callChat(impl, OPTS, MESSAGES);
    assert.equal(out.raw, '{"ok":true}');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].max_tokens, 4000);
    assert.equal(bodies[1].max_tokens, 8000);
  });

  it('未设 maxTokens 时重试也给一个兜底预算（不小于 4096）', async () => {
    const { impl, bodies } = fakeFetch([{ content: '', reasoning: 'x', finish: 'length' }, { content: 'ok' }]);
    await callChat(impl, { ...OPTS, maxTokens: undefined }, MESSAGES);
    assert.ok(bodies[1].max_tokens >= 4096);
  });

  it('两次都只有思考 → EMPTY 错误，且消息说清是"没有正文"而不是密钥/地址问题', async () => {
    const { impl, bodies } = fakeFetch([{ content: '', reasoning: 'a', finish: 'length' }]);
    await assert.rejects(
      () => callChat(impl, OPTS, MESSAGES),
      (e: any) => e instanceof LlmError && e.kind === 'EMPTY' && /思考/.test(e.message) && /推理模型/.test(e.message),
    );
    assert.equal(bodies.length, 2, '应只重试一次');
  });

  it('第一次就有正文 → 只请求一次，不重试', async () => {
    const { impl, bodies } = fakeFetch([{ content: '{"a":1}' }]);
    const out = await callChat(impl, OPTS, MESSAGES);
    assert.equal(out.raw, '{"a":1}');
    assert.equal(bodies.length, 1);
  });

  it('真·空回复（无思考、finish=stop）→ 不重试，报"上游返回空内容"', async () => {
    const { impl, bodies } = fakeFetch([{ content: '' }]);
    await assert.rejects(
      () => callChat(impl, OPTS, MESSAGES),
      (e: any) => e instanceof LlmError && e.kind === 'EMPTY' && e.message === 'AI 上游返回空内容',
    );
    assert.equal(bodies.length, 1);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { streamChat, type LlmMessage } from '../src/modules/ai-core/llm-client.ts';

/**
 * **流式 SSE 解析锁**（P3-B）。
 *
 * 不引 SDK 就得自己解 SSE，而这里的坑都是「线上才会看到」的：
 *  · 一个 TCP 包里可能只有**半个 SSE 帧**（`data: {"choi` 就断了）——必须按 `\n\n` 分帧并缓存余量；
 *  · `delta.content` 会被切成任意片段（半个汉字、半个数字），只能拼接、不能边流边解析；
 *  · `tool_calls` 的 id/name/arguments 分批下发，必须**按 index 合并**，否则参数是残缺 JSON。
 * 用假 fetch 造出这些形状，把解析器钉住。
 */

const OPTS = { baseUrl: 'http://mock', apiKey: 'k', model: 'm', timeoutMs: 5000 };

/** 用给定的字节块序列造一个 fetch */
function fakeFetch(chunks: string[]): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

const frame = (obj: unknown) => 'data: ' + JSON.stringify(obj) + '\n\n';
const messages: LlmMessage[] = [{ role: 'user', content: 'hi' }];

describe('LLM 流式解析（SSE）', () => {
  it('逐字拼接 content，并回调 onDelta', async () => {
    const deltas: string[] = [];
    const res = await streamChat(
      fakeFetch([
        frame({ choices: [{ delta: { content: '本期间' } }] }),
        frame({ choices: [{ delta: { content: '有 3 份' } }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 7, completion_tokens: 9 } }),
        'data: [DONE]\n\n',
      ]),
      OPTS,
      messages,
      { onDelta: (t) => deltas.push(t) },
    );
    assert.equal(res.text, '本期间有 3 份');
    assert.deepEqual(deltas, ['本期间', '有 3 份'], 'onDelta 必须按到达顺序逐块回调');
    assert.equal(res.finish, 'stop');
    assert.deepEqual(res.usage, { promptTokens: 7, completionTokens: 9 });
    assert.deepEqual(res.toolCalls, []);
  });

  it('一个帧被拆在两个网络包里也不会丢字（分帧缓存）', async () => {
    const whole = frame({ choices: [{ delta: { content: '完整一句话' } }] });
    const cut = Math.floor(whole.length / 2);
    const res = await streamChat(fakeFetch([whole.slice(0, cut), whole.slice(cut)]), OPTS, messages);
    assert.equal(res.text, '完整一句话');
  });

  it('tool_calls 按 index 合并（id/name/arguments 分批下发）', async () => {
    const res = await streamChat(
      fakeFetch([
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_context' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"doc":' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"statuses"}' } }] } }] }),
        frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
        'data: [DONE]\n\n',
      ]),
      OPTS,
      messages,
    );
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].id, 'call_a');
    assert.equal(res.toolCalls[0].name, 'read_context');
    assert.deepEqual(JSON.parse(res.toolCalls[0].arguments), { doc: 'statuses' }, '参数必须是完整 JSON');
    assert.equal(res.finish, 'tool_calls');
  });

  it('两个并行工具调用各自合并，不改顺序', async () => {
    const res = await streamChat(
      fakeFetch([
        frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'query_dataset' } }, { index: 0, id: 'a', function: { name: 'read_context' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"doc":"metrics"}' } }, { index: 1, function: { arguments: '{"datasetKey":"contract.summary"}' } }] } }] }),
        'data: [DONE]\n\n',
      ]),
      OPTS,
      messages,
    );
    assert.deepEqual(res.toolCalls.map((c) => c.name), ['read_context', 'query_dataset'], '必须按 index 排序，不是到达顺序');
  });

  it('非 JSON 的 data 行跳过而不是整次失败；[DONE] 结束', async () => {
    const res = await streamChat(
      fakeFetch(['data: not-json\n\n', frame({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']),
      OPTS,
      messages,
    );
    assert.equal(res.text, 'ok');
  });

  it('上游忽略 stream、直接回一段 JSON 时也能拿到正文', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '非流式兜底' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;
    const deltas: string[] = [];
    const res = await streamChat(fetchImpl, OPTS, messages, { onDelta: (t) => deltas.push(t) });
    assert.equal(res.text, '非流式兜底');
    assert.deepEqual(deltas, ['非流式兜底'], '兜底路径也要回调，否则前端一个字都看不到');
  });

  it('未配置上游时抛 LlmError（不是静默空回答）', async () => {
    await assert.rejects(
      () => streamChat(fakeFetch([]), { ...OPTS, apiKey: '' }, messages),
      /未配置/, 
    );
  });
});

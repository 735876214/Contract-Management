import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_EVENT_TTL_MS,
  STALE_RUN_MS,
  STREAM_POLL_MS,
  isRunTerminal,
  parseResumeFrom,
  parseRunEvent,
  serializeRunEvent,
  sseFrame,
  streamCaughtUp,
} from '../src/modules/ai-insight/analytics/chat-run-events.ts';

/**
 * AI 问数后台 run 的事件流原语（2026-11-24，借 ApeAdmin 的断线续传形态）。
 *
 * 断线续传的正确性全靠「事件带绝对序号 + 客户端报已看条数 + 服务端只补后面的」，
 * 所以这里把编号/序列化的**边界**锁死：脏参数当 0 而不是 400、坏事件跳过而不是整次失败、
 * 终态判定与「补完了没」分开。这些错了，用户看到的就是重复的半句话或缺一段答案。
 */

describe('事件序列化', () => {
  it('序列化/解析往返（含中文、嵌套对象、null）', () => {
    const cases: Array<[string, unknown]> = [
      ['delta', { text: '本期合同额 123 万' }],
      ['final', { accepted: true, answer: '整段正文', warnings: [] }],
      ['tool', { name: 'read_context', arguments: '{"doc":"statuses"}' }],
      ['done', null],
    ];
    for (const [event, data] of cases) {
      const parsed = parseRunEvent(serializeRunEvent(event, data));
      assert.deepEqual(parsed, { event, data });
    }
  });

  it('坏数据返回 null 而不是抛（一条脏事件不该打断整次续传）', () => {
    for (const raw of ['', 'not json', '{}', '{"event":""}', '[]', 'null', '{"data":1}']) {
      assert.equal(parseRunEvent(raw), null, `raw=${raw}`);
    }
  });

  it('SSE 帧形状：event 行 + 单行 data + 空行收尾', () => {
    const frame = sseFrame('delta', { text: 'a' });
    assert.ok(frame.startsWith('event: delta\n'));
    assert.ok(frame.endsWith('\n\n'));
    const dataLine = frame.split('\n')[1];
    assert.ok(dataLine.startsWith('data: '));
    assert.deepEqual(JSON.parse(dataLine.slice(6)), { text: 'a' });
    assert.equal(frame.split('\n').filter((l) => l.startsWith('data: ')).length, 1, 'data 只能一行');
  });
});

describe('续传起点解析', () => {
  it('缺省/脏数据/负数一律当 0（宁可多补几条，也不要 400 打断）', () => {
    for (const raw of [undefined, null, '', 'abc', '-3', -1, 'NaN', Infinity]) {
      assert.equal(parseResumeFrom(raw), 0, `raw=${String(raw)}`);
    }
  });

  it('正常值与小数：取整不四舍五入（5.9 → 5，不多补一条）', () => {
    assert.equal(parseResumeFrom(0), 0);
    assert.equal(parseResumeFrom('7'), 7);
    assert.equal(parseResumeFrom(5.9), 5);
  });
});

describe('终态与收流判定', () => {
  it('done/failed/stopped 是终态；pending/running/未知值不是', () => {
    for (const s of ['done', 'failed', 'stopped']) assert.equal(isRunTerminal(s), true, s);
    for (const s of ['pending', 'running', 'stopping', '', null, undefined, 'DONE']) {
      assert.equal(isRunTerminal(s), false, String(s));
    }
  });

  it('终态且已看到全部事件才收流（否则会「done 了但少最后一段」）', () => {
    assert.equal(streamCaughtUp({ status: 'done', from: 12, eventCount: 12 }), true);
    assert.equal(streamCaughtUp({ status: 'done', from: 11, eventCount: 12 }), false);
    assert.equal(streamCaughtUp({ status: 'running', from: 12, eventCount: 12 }), false);
  });
});

describe('时间常量', () => {
  it('轮询比事件存活短得多，僵尸判定比轮询长得多（写反了会白等/误杀）', () => {
    assert.ok(STREAM_POLL_MS > 0 && STREAM_POLL_MS <= 1000);
    assert.ok(RUN_EVENT_TTL_MS >= 30 * 60_000, '事件至少要留半小时，用户接个电话回来还能续上');
    assert.ok(STALE_RUN_MS > STREAM_POLL_MS * 10, '僵尸判定太短会误杀正在跑的 run');
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requestContext } from '../src/common/services/request-context.ts';
import { buildErrorEnvelope } from '../src/common/utils/error-envelope.ts';

/**
 * 请求链路 id（2026-11-24，借 ApeAdmin 的 X-Request-ID 中间件）。
 *
 * 要解决的问题很具体：用户报「刚才保存失败了」时，运维只能按时间戳在几十万行操作日志里捞。
 * 现在同一个 id 同时出现在三处——响应头 `x-request-id`、响应体 `requestId`、`OperationLog.requestId`，
 * 用户截个图就能定位到那一行。
 *
 * 锁三件事：上下文能带出去、信封在**有值时才多这个键**、中间件必须在 next 之前写响应头。
 */

const MAIN_SRC = readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

describe('requestId 在请求上下文里', () => {
  it('run 里带得出去，且与 projectId 互不影响', () => {
    const id = requestContext.run({ projectId: 'p1', requestId: 'req-abc' }, () => requestContext.requestId);
    assert.equal(id, 'req-abc');
  });

  it('请求之外（seed / 脚本 / 单测）为 undefined，不伪造 id', () => {
    assert.equal(requestContext.requestId, undefined);
  });

  it('只给 projectId 不给 requestId 时也允许（老调用点不用改）', () => {
    const id = requestContext.run({ projectId: 'p1' }, () => requestContext.requestId);
    assert.equal(id, undefined);
  });
});

describe('错误信封里的 requestId', () => {
  it('有值时进信封（与成功分支同名字段）', () => {
    const env = buildErrorEnvelope({ code: 1412, message: '项目不存在', requestId: 'req-1', timestamp: 1 });
    assert.deepEqual(env, { code: 1412, data: null, message: '项目不存在', timestamp: 1, requestId: 'req-1' });
  });

  it('没值时**不出现这个键**（避免 JSON 里多一个 undefined 噪音键）', () => {
    const env = buildErrorEnvelope({ code: 1500, message: 'x', timestamp: 2 });
    assert.equal('requestId' in env, false);
    assert.deepEqual(Object.keys(env).sort(), ['code', 'data', 'message', 'timestamp']);
  });
});

describe('中间件与生成 id 的写法（与 main.ts 耦合处）', () => {
  it('响应头在 next() 之前写（异常分支也要带上它）', () => {
    // 中间件写作 `res?.setHeader?.('x-request-id', requestId)`：用正则取位置，不锁死可选调用写法
    const headerAt = MAIN_SRC.search(/setHeader[^\n]*'x-request-id'/);
    const nextAt = MAIN_SRC.indexOf('() => next()');
    assert.ok(headerAt > 0 && nextAt > 0, 'main.ts 里找不到写头或 next()');
    assert.ok(headerAt < nextAt, '响应头必须在 next() 之前写，否则 500 分支拿不到 requestId');
  });

  it('沿用上游传来的 x-request-id（网关/nginx 已生成时不要另造一个）', () => {
    assert.match(MAIN_SRC, /headers\?\.\['x-request-id'\]/);
    assert.match(MAIN_SRC, /randomUUID\(\)/);
  });

  it('上下文里同时塞 projectId 与 requestId（一个 ALS，不搞第二个存储）', () => {
    assert.match(MAIN_SRC, /requestContext\.run\(\{ projectId: projectId \|\| undefined, requestId \}/);
  });
});

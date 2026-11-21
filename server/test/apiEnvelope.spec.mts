import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorEnvelope } from '../src/common/utils/error-envelope.ts';

/**
 * **统一响应信封的形状锁**（质量评估 2026-11-21 P0-2）。
 *
 * `CLAUDE.md` 铁律 2 约定 `{ code, data, message, timestamp }`，
 * 曾经只有成功分支带 `timestamp`、错误分支不带 —— 前端不读它所以线上没炸，
 * 但 `mcp/` 按文档解析会拿到 `undefined`。这里把形状钉死，两分支必须同形。
 */
describe('统一响应信封：错误分支与成功分支同形', () => {
  it('四个字段齐全，且 data 恒为 null', () => {
    const env = buildErrorEnvelope({ code: 1001, message: '参数错误' });
    assert.deepEqual(Object.keys(env).sort(), ['code', 'data', 'message', 'timestamp']);
    assert.equal(env.code, 1001);
    assert.equal(env.data, null);
    assert.equal(env.message, '参数错误');
  });

  it('timestamp 是毫秒数（number），不是 ISO 字符串', () => {
    const before = Date.now();
    const env = buildErrorEnvelope({ code: 1500, message: '服务器内部错误' });
    assert.equal(typeof env.timestamp, 'number');
    assert.ok(Number.isFinite(env.timestamp));
    assert.ok(env.timestamp >= before && env.timestamp <= Date.now());
    // 与成功分支（ResponseInterceptor 用 Date.now()）同量级：13 位
    assert.equal(String(Math.trunc(env.timestamp)).length, 13);
  });

  it('允许注入固定时间戳（供断言与重放）', () => {
    assert.equal(buildErrorEnvelope({ code: 1404, message: 'x', timestamp: 1234 }).timestamp, 1234);
  });

  it('错误码按项目约定透出，不被包装或改写', () => {
    for (const code of [1001, 1401, 1403, 1404, 1500]) {
      assert.equal(buildErrorEnvelope({ code, message: 'm' }).code, code);
    }
  });
});

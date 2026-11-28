import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOrigin,
  parseCorsOrigins,
  isOriginAllowed,
  buildCorsOptions,
  describeCorsPolicy,
} from '../src/common/cors.ts';

/**
 * CORS 白名单口径锁（2026-11-28 收敛）。
 *
 * 背景：原来 `enableCors({ origin: true, credentials: true })` 对任意来源回显
 * `Access-Control-Allow-Origin`；而本仓鉴权走 httpOnly Cookie，两者组合只靠
 * SameSite=Lax 兜底。收敛后：不配 `CORS_ORIGINS` = 同源部署不回 CORS 头，
 * 配了就只认列出的源（精确匹配，不做子串/前缀匹配）。
 *
 * 这里钉的是**判定边界**，不是 enableCors 的内部实现：
 * 一旦有人把精确匹配改回 includes()/startsWith()，'https://a.com.evil.io' 这条会立刻红。
 */

describe('CORS 白名单', () => {
  it('parseCorsOrigins：空值 → 空表，去空白、去重、忽略尾部斜杠', () => {
    assert.deepEqual(parseCorsOrigins(undefined), []);
    assert.deepEqual(parseCorsOrigins(''), []);
    assert.deepEqual(parseCorsOrigins('   '), []);
    assert.deepEqual(parseCorsOrigins(' , ,'), []);
    assert.deepEqual(
      parseCorsOrigins(' https://A.example.com/ , http://localhost:5173 , https://a.example.com '),
      ['https://a.example.com', 'http://localhost:5173'],
    );
  });

  it('normalizeOrigin：只留 scheme://host[:port]，丢掉 path/query', () => {
    assert.equal(normalizeOrigin('https://a.example.com/'), 'https://a.example.com');
    assert.equal(normalizeOrigin('https://a.example.com/x/y?q=1'), 'https://a.example.com');
    assert.equal(normalizeOrigin('HTTPS://A.Example.COM:443'), 'https://a.example.com');
    assert.equal(normalizeOrigin('http://localhost:5173'), 'http://localhost:5173');
    assert.equal(normalizeOrigin('  '), '');
    assert.equal(normalizeOrigin('*'), '*');
  });

  it('没有 Origin 的请求不属于 CORS 范畴（不回放行）', () => {
    // 同源 GET / curl / MCP 客户端都没有 Origin 头：回 false，避免响应里出现空的
    // Access-Control-Allow-Origin（cors 包会把 undefined 拼成字符串））
    assert.equal(isOriginAllowed(undefined, ['https://a.example.com']), false);
    assert.equal(isOriginAllowed('', ['https://a.example.com']), false);
    assert.equal(isOriginAllowed('', ['*']), false);
  });

  it('不配白名单 = 谁都不放行（同源部署，不回 CORS 头）', () => {
    assert.equal(isOriginAllowed('https://a.example.com', []), false);
    assert.equal(isOriginAllowed('http://localhost:5173', []), false);
  });

  it('配了白名单 = 只认列出的源（精确匹配，不做子串/前缀）', () => {
    const allowed = parseCorsOrigins('https://a.example.com,http://localhost:5173');
    assert.equal(isOriginAllowed('https://a.example.com', allowed), true);
    assert.equal(isOriginAllowed('https://A.EXAMPLE.COM', allowed), true);
    assert.equal(isOriginAllowed('https://a.example.com/', allowed), true);
    assert.equal(isOriginAllowed('http://localhost:5173', allowed), true);
    // 下面几条是「像但不是」的经典绕过写法，必须全部拒绝
    assert.equal(isOriginAllowed('https://a.example.com.evil.io', allowed), false);
    assert.equal(isOriginAllowed('https://evil.io/?x=https://a.example.com', allowed), false);
    assert.equal(isOriginAllowed('http://a.example.com', allowed), false, '协议不同不算同一个源');
    assert.equal(isOriginAllowed('https://a.example.com:8443', allowed), false, '端口不同不算同一个源');
    assert.equal(isOriginAllowed('https://sub.a.example.com', allowed), false, '子域不自动放行');
    assert.equal(isOriginAllowed('https://a.example.co', allowed), false);
  });

  it('CORS_ORIGINS=* 回显任意来源（旧行为，仅本地调试）', () => {
    const allowed = parseCorsOrigins('*');
    assert.equal(isOriginAllowed('https://any.example.com', allowed), true);
    assert.match(describeCorsPolicy(allowed), /仅限本地调试/);
  });

  it('buildCorsOptions：origin 回调 + credentials，且带预检缓存', () => {
    const opts = buildCorsOptions({ CORS_ORIGINS: 'https://a.example.com' });
    assert.equal(opts.credentials, true);
    assert.equal(opts.maxAge, 600);
    const call = (origin: string | undefined) => {
      let out: boolean | undefined;
      opts.origin(origin, (_err, allow) => { out = allow; });
      return out;
    };
    assert.equal(call('https://a.example.com'), true);
    assert.equal(call('https://evil.io'), false);
    assert.equal(call(undefined), false);
  });

  it('describeCorsPolicy：三种口径各自说人话（启动日志用）', () => {
    assert.match(describeCorsPolicy([]), /同源部署/);
    assert.match(describeCorsPolicy(['https://a.example.com', 'https://b.example.com']), /https:\/\/a\.example\.com, https:\/\/b\.example\.com/);
  });
});

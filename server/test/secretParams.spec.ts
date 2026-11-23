import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_PARAM_KEYS,
  isSecretParam,
  pickPublicParams,
} from '../src/common/utils/public-params';

/**
 * `SysParam` 读取白名单（第 24 轮审计）。
 *
 * 事故形态：`GET /auth/profile` 曾直接回 `sysParam.getAll()`，把 `ai.apiKey` 明文
 * 交给任意登录用户，与产品口径「密钥只写不读」冲突。本文件锁住"批量读取必须过滤"这条语义，
 * 以及"过滤不污染入参"（入参是进程内缓存本体）。
 */
describe('系统参数的读取白名单', () => {
  it('ai.apiKey 属于敏感参数', () => {
    assert.equal(isSecretParam('ai.apiKey'), true);
    assert.ok(SECRET_PARAM_KEYS.has('ai.apiKey'));
  });

  it('普通参数不算敏感', () => {
    for (const k of ['contract.code.fixed_prefix', 'supplier.share.scope', 'ai.model', 'ai.baseUrl']) {
      assert.equal(isSecretParam(k), false, k);
    }
  });

  it('pickPublicParams 过滤掉敏感键，其余原样保留', () => {
    const all = {
      'ai.apiKey': 'sk-live-abcdef',
      'ai.baseUrl': 'https://example.com/v1',
      'ai.model': 'deepseek-chat',
      'contract.code.fixed_prefix': 'CSCEM',
    };
    const out = pickPublicParams(all);
    assert.equal('ai.apiKey' in out, false, '密钥不得出现在对外参数里');
    assert.equal(out['ai.baseUrl'], 'https://example.com/v1');
    assert.equal(out['ai.model'], 'deepseek-chat');
    assert.equal(out['contract.code.fixed_prefix'], 'CSCEM');
    assert.equal(Object.keys(out).length, 3);
  });

  it('返回新对象：不改入参（入参可能是缓存本体，改它会污染进程缓存）', () => {
    const all: Record<string, string> = { 'ai.apiKey': 'k', a: 'b' };
    const out = pickPublicParams(all);
    out.a = 'mutated';
    assert.equal(all.a, 'b');
    assert.equal(all['ai.apiKey'], 'k', '缓存里的密钥必须还在（服务器自己要用）');
  });

  it('空值/脏输入不抛错', () => {
    assert.deepEqual(pickPublicParams(undefined), {});
    assert.deepEqual(pickPublicParams(null), {});
    assert.deepEqual(pickPublicParams({}), {});
  });

  it('防恒真：敏感键清单不能是空的', () => {
    assert.ok(SECRET_PARAM_KEYS.size >= 1);
  });
});

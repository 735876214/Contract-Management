import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AI_PARAM_KEYS, readAiConfig } from '../src/modules/ai/ai-config.ts';

/**
 * AI 配置的取值优先级（**页面登记 > 环境变量 > 默认值**）。
 *
 * 背景（2026-10-20 需求：「系统管理 → AI 信息登记」）：配置原来只认环境变量，
 * 改一次要动 docker-compose 并重启。页面登记后写进 `SysParam`，这里用纯函数锁住三条语义：
 *   ① 页面填了就以页面为准（逐项覆盖，不是整体替换）；
 *   ② 页面没填就回落环境变量 —— 老部署只配 env 的行为**不变**；
 *   ③ 判定 `enabled` 时不能出现「界面说启用、调用却 401」：三项缺一即视为未配置。
 */

const ENV = {
  AI_BASE_URL: 'https://env.example.com',
  AI_API_KEY: 'sk-env',
  AI_MODEL: 'env-model',
};

describe('AI 配置取值优先级（页面登记 vs 环境变量）', () => {
  it('页面三项都填了 → 完全覆盖环境变量', () => {
    const cfg = readAiConfig(ENV, {
      baseUrl: 'https://db.example.com',
      apiKey: 'sk-db',
      model: 'db-model',
    });
    assert.equal(cfg.baseUrl, 'https://db.example.com');
    assert.equal(cfg.apiKey, 'sk-db');
    assert.equal(cfg.model, 'db-model');
    assert.equal(cfg.enabled, true);
  });

  it('页面只填一部分 → 其余逐项回落环境变量（不是整体替换）', () => {
    const cfg = readAiConfig(ENV, { model: 'db-model' });
    assert.equal(cfg.baseUrl, 'https://env.example.com');
    assert.equal(cfg.apiKey, 'sk-env');
    assert.equal(cfg.model, 'db-model');
    assert.equal(cfg.enabled, true);
  });

  it('页面空串/空白视为「未登记」，不覆盖环境变量', () => {
    const cfg = readAiConfig(ENV, { baseUrl: '   ', apiKey: '', model: null });
    assert.equal(cfg.baseUrl, 'https://env.example.com');
    assert.equal(cfg.apiKey, 'sk-env');
    assert.equal(cfg.model, 'env-model');
  });

  it('什么都没配 → enabled:false（不抛错，交给上层给提示）', () => {
    const cfg = readAiConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.apiKey, '');
    assert.equal(cfg.model, '');
  });

  it('只有 env 没有页面登记 → 与改造前行为一致', () => {
    const cfg = readAiConfig(ENV);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.model, 'env-model');
  });
});

describe('AI 启用开关的判定', () => {
  it('页面开关关掉 → 即使 env 配齐也不启用', () => {
    const cfg = readAiConfig(ENV, { enabled: false });
    assert.equal(cfg.enabled, false);
    // 配置本身仍要回显，否则页面会把已填的地址清空
    assert.equal(cfg.baseUrl, 'https://env.example.com');
  });

  it('页面开关打开 → 压过 env 的 AI_ENABLED=false（页面是更靠后的操作）', () => {
    const cfg = readAiConfig({ ...ENV, AI_ENABLED: 'false' }, { enabled: true });
    assert.equal(cfg.enabled, true);
  });

  it('页面没登记开关时才看 env 的 AI_ENABLED=false', () => {
    assert.equal(readAiConfig({ ...ENV, AI_ENABLED: 'false' }).enabled, false);
    assert.equal(readAiConfig({ ...ENV, AI_ENABLED: 'FALSE' }).enabled, false);
  });

  it('开关开着但缺 API Key → 仍然不启用（避免「显示已启用、调用必 401」）', () => {
    const cfg = readAiConfig({ AI_BASE_URL: 'https://x.example.com', AI_MODEL: 'm' }, { enabled: true });
    assert.equal(cfg.enabled, false);
  });
});

describe('AI 配置的存储键名（改名会让存量配置静默失效）', () => {
  it('键名锁定在 ai.* 命名空间', () => {
    assert.deepEqual(AI_PARAM_KEYS, {
      enabled: 'ai.enabled',
      baseUrl: 'ai.baseUrl',
      apiKey: 'ai.apiKey',
      model: 'ai.model',
    });
  });
});

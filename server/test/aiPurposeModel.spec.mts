import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_PARAM_KEYS,
  AI_PURPOSES,
  aiModelFor,
  aiPublicStatus,
  aiPurposeMeta,
  aiPurposeParamKey,
  readAiConfig,
} from '../src/modules/ai/ai-config.ts';

/**
 * 「按用途指定模型」（2026-10-23 需求：AI 助手给不同用途用不同的模型）。
 *
 * 背景：原来全站只有一个 `ai.model`——表单核验（短文本，只要结构化 JSON）、
 * 文件登记（长正文）、汇报材料（长输出）、异常预警（重推理）挤同一个模型，
 * 要么贵模型干粗活、要么便宜模型干不了细活。
 *
 * 这里锁住四条语义：
 *   ① 用途没单独指定 → 用**全局** `ai.model`（老部署只配全局的行为完全不变）；
 *   ② 取值链：**页面登记 `ai.model.<用途>` > 环境变量 `AI_MODEL_<用途>` > 全局 `ai.model`**；
 *   ③ `enabled` 判据不变（仍要求全局模型 + 地址 + 密钥齐全）——不能让「只配了某个用途」
 *      把开关点亮，否则其余用途调用必然 401/400；
 *   ④ 调用点统一走 `aiModelFor()`，别再直接读 `cfg.model`（否则用途级配置被悄悄绕过）。
 */

const ENV = {
  AI_BASE_URL: 'https://env.example.com',
  AI_API_KEY: 'sk-env',
  AI_MODEL: 'env-model',
};

describe('AI 用途目录（单一事实源）', () => {
  it('四个用途齐备、用途码与存储键唯一', () => {
    assert.deepEqual(
      AI_PURPOSES.map((p) => p.code).sort(),
      ['anomaly', 'form_inspect', 'register', 'report'],
    );
    const codes = new Set(AI_PURPOSES.map((p) => p.code));
    const envKeys = new Set(AI_PURPOSES.map((p) => p.envKey));
    assert.equal(codes.size, AI_PURPOSES.length, '用途码重复');
    assert.equal(envKeys.size, AI_PURPOSES.length, '环境变量名重复');
  });

  it('每个用途都有页面展示用的名称与说明', () => {
    for (const p of AI_PURPOSES) {
      assert.ok(p.name.trim(), `${p.code} 缺名称`);
      assert.ok(p.desc.trim(), `${p.code} 缺说明`);
    }
  });

  it('用途码格式锁定：snake_case、环境变量名与之对应', () => {
    for (const p of AI_PURPOSES) {
      assert.match(p.code, /^[a-z][a-z_]*$/, `${p.code} 不是 snake_case`);
      // 环境变量名由用途码大写而来，运维照着文档配也不会错位
      assert.equal(p.envKey, `AI_MODEL_${p.code.toUpperCase()}`);
    }
  });

  it('存储键是 ai.model.<用途>，不占用原有四个键', () => {
    for (const p of AI_PURPOSES) {
      assert.equal(aiPurposeParamKey(p.code), `ai.model.${p.code}`);
    }
    assert.deepEqual(Object.values(AI_PARAM_KEYS).sort(), [
      'ai.apiKey',
      'ai.baseUrl',
      'ai.enabled',
      'ai.model',
    ]);
  });

  it('aiPurposeMeta 认已知用途、未知返回 null（由调用方决定报错还是忽略）', () => {
    assert.equal(aiPurposeMeta('register')?.name, '文件登记');
    assert.equal(aiPurposeMeta('nope'), null);
  });
});

describe('用途级模型解析', () => {
  it('用途都没单独指定 → 全部等于全局模型，来源标 default', () => {
    const cfg = readAiConfig({ ...ENV, AI_MODEL: 'global-model' });
    for (const p of AI_PURPOSES) {
      assert.equal(cfg.models[p.code], 'global-model');
      assert.equal(cfg.modelSources[p.code], 'default');
      assert.equal(aiModelFor(cfg, p.code), 'global-model');
    }
    assert.equal(cfg.model, 'global-model', '全局字段本身不受影响');
  });

  it('页面登记了某用途 → 只有该用途变，其它仍跟随全局', () => {
    const cfg = readAiConfig(
      { ...ENV, AI_MODEL: 'global-model' },
      { models: { report: 'db-strong' } },
    );
    assert.equal(cfg.models.report, 'db-strong');
    assert.equal(cfg.modelSources.report, 'db');
    assert.equal(cfg.models.register, 'global-model');
    assert.equal(cfg.modelSources.register, 'default');
    assert.equal(cfg.model, 'global-model');
  });

  it('用途环境变量生效，并被页面登记压过（页面 > 用途 env > 全局）', () => {
    const env = { ...ENV, AI_MODEL: 'global-model', AI_MODEL_REPORT: 'env-report' };
    const fromEnv = readAiConfig(env);
    assert.equal(fromEnv.models.report, 'env-report');
    assert.equal(fromEnv.modelSources.report, 'env');
    assert.equal(fromEnv.models.anomaly, 'global-model', '没配用途 env 的仍跟随全局');

    const fromDb = readAiConfig(env, { models: { report: 'db-report' } });
    assert.equal(fromDb.models.report, 'db-report');
    assert.equal(fromDb.modelSources.report, 'db');
  });

  it('页面登记空串/空白 = 未覆盖（回落用途 env / 全局，不是「用空模型」）', () => {
    const env = { ...ENV, AI_MODEL: 'global-model', AI_MODEL_ANOMALY: 'env-anom' };
    const cfg = readAiConfig(env, { models: { report: '   ', anomaly: '' } });
    assert.equal(cfg.models.report, 'global-model');
    assert.equal(cfg.models.anomaly, 'env-anom');
  });

  it('aiModelFor 对缺值回落到全局（不让调用点拿到空串去请求上游）', () => {
    const cfg = readAiConfig({ ...ENV, AI_MODEL: 'global-model' });
    assert.equal(aiModelFor(cfg, 'form_inspect'), 'global-model');
  });
});

describe('启用判据不受用途级模型影响', () => {
  it('只配了某个用途的模型、全局模型为空 → 仍不启用', () => {
    const cfg = readAiConfig(
      { AI_BASE_URL: 'https://env.example.com', AI_API_KEY: 'sk-env' },
      { models: { report: 'db-strong' } },
    );
    assert.equal(cfg.models.report, 'db-strong');
    assert.equal(cfg.model, '');
    assert.equal(cfg.enabled, false, '全局模型是兜底，缺它其余用途会 400/401');
  });

  it('全局三项齐全 → 启用；用途覆盖不影响开关', () => {
    const cfg = readAiConfig(ENV, { models: { register: 'db-model' } });
    assert.equal(cfg.enabled, true);
  });

  it('显式关闭优先于用途配置', () => {
    const cfg = readAiConfig(ENV, { enabled: false, models: { register: 'db-model' } });
    assert.equal(cfg.enabled, false);
  });
});

describe('对外状态快照', () => {
  it('含全局模型与各用途模型，但不含 apiKey（keys/baseUrl 绝不下发）', () => {
    const cfg = readAiConfig(ENV, { models: { report: 'db-strong' } });
    const pub = aiPublicStatus(cfg);
    assert.equal(pub.enabled, true);
    assert.equal(pub.model, 'env-model');
    assert.equal(pub.models.report, 'db-strong');
    assert.equal(pub.models.register, 'env-model');
    const text = JSON.stringify(pub);
    assert.ok(!text.includes('sk-env'), '快照里出现了密钥');
    assert.ok(!text.includes('apiKey'), '快照里出现了 apiKey 字段');
  });

  it('未启用时不下发任何模型名（前端不会显示一个其实用不了的模型）', () => {
    const cfg = readAiConfig({}, { models: { report: 'db-strong' } });
    const pub = aiPublicStatus(cfg);
    assert.equal(pub.enabled, false);
    assert.equal(pub.model, '');
    for (const p of AI_PURPOSES) assert.equal(pub.models[p.code], '');
  });
});

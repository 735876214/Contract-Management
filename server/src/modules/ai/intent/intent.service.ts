import { Injectable } from '@nestjs/common';
import { aiModelFor, type AiConfig } from '../ai-config';
import { chatJson, LlmError } from '../llm-client';
import { buildIntentMessages } from './intent-prompt';

/**
 * Phase 3 · LLM 意图解析（短 JSON、便宜模型）。
 *
 * 只负责「文本 → 原始 JSON」；白名单归一在 `normalizeModelIntent()`，
 * 配额由调用方（`AnalyticsService.plan`）统一扣/退，避免这里再养一套计数。
 */
@Injectable()
export class IntentService {
  async parse(
    cfg: AiConfig,
    text: string,
    projectNames: string[] = [],
  ): Promise<{ raw: unknown; usage?: { promptTokens?: number; completionTokens?: number } }> {
    if (!cfg.enabled) throw new LlmError('AI 未启用', 'NOT_CONFIGURED');
    const res = await chatJson(
      globalThis.fetch as any,
      {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: aiModelFor(cfg, 'intent'),
        timeoutMs: Math.min(cfg.timeoutMs, 30000),
        temperature: 0.1,
        maxTokens: Math.min(cfg.maxTokens, 2000),
      },
      buildIntentMessages(text, projectNames),
      true,
    );
    return { raw: res.data, usage: res.usage };
  }
}

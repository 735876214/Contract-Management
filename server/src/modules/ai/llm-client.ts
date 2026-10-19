/**
 * OpenAI 兼容的最小 LLM 客户端（**零运行时依赖**：只用 Node 内置 `fetch`，不引 axios）。
 *
 * 为什么不用 SDK：本仓库明确不做 provider 抽象层（`.claude/rules/product-decisions.md`：
 * 不做"为将来可能的外部通道预留抽象层"）。DeepSeek / 通义 / Ollama / vLLM 都实现
 * `POST /v1/chat/completions`，一个函数就够；换模型只改环境变量。
 *
 * 两个硬要求：
 * 1. **超时必须可控**：AI 调用是同步请求（仓库无 MQ / 无调度器），
 *    超时由 `AbortController` 兜底，绝不能让一个挂起的上游把 Node 事件循环拖住。
 * 2. **只取 JSON**：模型爱把 JSON 包在 ```json 围栏里、或前面加一句"好的，结果如下"。
 *    `extractJsonBlock()` 负责把这层噪声剥掉，解析失败返回 `null` 由调用方降级（不抛）。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature?: number;
  maxTokens?: number;
}

/** 拼出 chat/completions 地址：`baseUrl` 带不带 `/v1` 都认，末尾斜杠归一 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** 请求体：`jsonMode` 时要求上游返回 JSON 对象（支持的模型会严格遵守，不支持的忽略该字段） */
export function buildChatBody(
  opts: Pick<LlmOptions, 'model' | 'temperature' | 'maxTokens'>,
  messages: LlmMessage[],
  jsonMode = true,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0,
    stream: false,
  };
  if (opts.maxTokens && opts.maxTokens > 0) body.max_tokens = opts.maxTokens;
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/**
 * 从模型输出里剥出 JSON（对象或数组）。
 * 顺序：整体 `JSON.parse` → 去 ```json 围栏 → 取第一个 `{`/`[` 到最后一个闭合符。
 * 全部失败返回 `null`（**不抛**）：调用方按"AI 没帮上忙"降级，而不是让整次请求 500。
 */
export function extractJsonBlock(text: string): unknown {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  const direct = tryParse(raw);
  if (direct !== undefined) return direct;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== undefined) return inner;
  }

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const start = raw.indexOf(open);
    const end = raw.lastIndexOf(close);
    if (start >= 0 && end > start) {
      const sliced = tryParse(raw.slice(start, end + 1));
      if (sliced !== undefined) return sliced;
    }
  }
  return null;
}

export interface LlmCallResult {
  /** 解析出的 JSON（失败为 null） */
  data: unknown;
  /** 模型原始文本，便于日志排查 */
  raw: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: 'NOT_CONFIGURED' | 'TIMEOUT' | 'HTTP' | 'EMPTY',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * 调一次 chat/completions 并解析 JSON。
 * `fetchImpl` 显式注入：单测与集成测试用本地假上游替换，不打真网。
 */
export async function chatJson(
  fetchImpl: typeof fetch,
  opts: LlmOptions,
  messages: LlmMessage[],
  jsonMode = true,
): Promise<LlmCallResult> {
  const url = chatCompletionsUrl(opts.baseUrl);
  if (!url || !opts.apiKey || !opts.model) {
    throw new LlmError('AI 未配置（缺少 AI_BASE_URL / AI_API_KEY / AI_MODEL）', 'NOT_CONFIGURED');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, opts.timeoutMs));
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(buildChatBody(opts, messages, jsonMode)),
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new LlmError(`AI 调用超时（>${Math.round(opts.timeoutMs / 1000)}s）`, 'TIMEOUT');
    }
    throw new LlmError(`AI 调用失败：${e?.message || '网络异常'}`, 'HTTP');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 只取前 300 字符：错误体可能是 HTML 网关页，整段塞进日志会把日志页撑爆
    const detail = await res.text().catch(() => '');
    throw new LlmError(`AI 上游返回 ${res.status}：${detail.slice(0, 300)}`, 'HTTP', res.status);
  }

  const body: any = await res.json().catch(() => null);
  const raw = String(body?.choices?.[0]?.message?.content ?? '');
  if (!raw) throw new LlmError('AI 上游返回空内容', 'EMPTY');

  return {
    data: extractJsonBlock(raw),
    raw,
    usage: {
      promptTokens: body?.usage?.prompt_tokens,
      completionTokens: body?.usage?.completion_tokens,
    },
  };
}

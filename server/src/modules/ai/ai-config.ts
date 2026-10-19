/**
 * AI 助手配置（**零运行时依赖**：不 import 任何模块，`.mts` spec 可直接加载）。
 *
 * 架构口径（2026-10-19 业务决策：模型走**云端 API**，服务器出网）：
 * - 只有一处外部依赖：`{baseUrl}/v1/chat/completions`（OpenAI 兼容协议）。
 *   DeepSeek / 通义 / Ollama / vLLM 都是这个协议，**切换只改环境变量**，不做 provider 抽象层。
 * - `AI_ENABLED=false` 或未配 `AI_API_KEY` → `/api/ai/status` 返回 `enabled:false`，
 *   前端隐藏入口；**任何既有功能都不受影响**（AI 是纯增量能力）。
 * - 限额一律在这里集中，不要在 service 里散写魔数。
 */

export interface AiConfig {
  /** 总开关：显式 `AI_ENABLED=false` 或缺少 key/baseUrl/model 时为 false */
  enabled: boolean;
  /** 站点地址，如 `https://api.deepseek.com`（可带或不带 `/v1`） */
  baseUrl: string;
  apiKey: string;
  /** 模型名，如 `deepseek-chat` */
  model: string;
  /** 单次调用超时（毫秒） */
  timeoutMs: number;
  /** 单文件上限（字节）：AI 走同步请求，不做异步任务队列 */
  maxFileBytes: number;
  /** 单次扫描的候选单元格上限（超出只取前 N 个并提示分段处理） */
  maxCandidates: number;
  /** 送进 prompt 的字段目录上限（模型只看标签，不看值） */
  maxFieldsInPrompt: number;
  /** 每用户每小时的 AI 调用次数上限（进程内计数：单实例是最终形态，不需要 Redis） */
  hourlyLimitPerUser: number;
  /** 单次返回的最大 token（文件登记要输出明细，不能沿用默认值） */
  maxTokens: number;
  /** 送进 prompt 的正文长度上限（字符）：合同正文整段喂给模型，必须有硬上限 */
  maxTextChars: number;
}

export const AI_DEFAULTS = {
  baseUrl: '',
  model: '',
  timeoutMs: 30000,
  maxFileBytes: 5 * 1024 * 1024,
  maxCandidates: 300,
  maxFieldsInPrompt: 120,
  hourlyLimitPerUser: 60,
  maxTokens: 4000,
  maxTextChars: 40000,
} as const;

const str = (v: string | undefined): string => String(v ?? '').trim();

const positiveInt = (v: string | undefined, fallback: number): number => {
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * 从环境变量读配置（纯函数，便于单测）。
 * `enabled` 的判据：没有显式关闭 **且** 三个必填项齐全 —— 少一项就当作未配置，
 * 避免出现「界面显示已启用、每次调用都 401」的半死状态。
 */
export function readAiConfig(env: Record<string, string | undefined> = {}): AiConfig {
  const baseUrl = str(env.AI_BASE_URL) || AI_DEFAULTS.baseUrl;
  const apiKey = str(env.AI_API_KEY);
  const model = str(env.AI_MODEL) || AI_DEFAULTS.model;
  const explicitOff = str(env.AI_ENABLED).toLowerCase() === 'false';
  const configured = Boolean(baseUrl && apiKey && model);

  return {
    enabled: !explicitOff && configured,
    baseUrl,
    apiKey,
    model,
    timeoutMs: positiveInt(env.AI_TIMEOUT_MS, AI_DEFAULTS.timeoutMs),
    maxFileBytes: positiveInt(env.AI_MAX_FILE_BYTES, AI_DEFAULTS.maxFileBytes),
    maxCandidates: positiveInt(env.AI_MAX_CANDIDATES, AI_DEFAULTS.maxCandidates),
    maxFieldsInPrompt: positiveInt(env.AI_MAX_FIELDS, AI_DEFAULTS.maxFieldsInPrompt),
    hourlyLimitPerUser: positiveInt(env.AI_HOURLY_LIMIT, AI_DEFAULTS.hourlyLimitPerUser),
    maxTokens: positiveInt(env.AI_MAX_TOKENS, AI_DEFAULTS.maxTokens),
    maxTextChars: positiveInt(env.AI_MAX_TEXT_CHARS, AI_DEFAULTS.maxTextChars),
  };
}

/** 对外暴露的配置快照：**绝不包含 apiKey**（前端只需要知道能不能用） */
export function aiPublicStatus(cfg: AiConfig): { enabled: boolean; model: string } {
  return { enabled: cfg.enabled, model: cfg.enabled ? cfg.model : '' };
}

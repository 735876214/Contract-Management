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

/**
 * **AI 用途**（2026-10-23 需求：不同用途可以指定不同模型）。
 *
 * 由来：原来全站只有一个 `ai.model`——表单核验（短文本、只要结构化 JSON）、
 * 合同扫描件登记（长正文、字段要齐全）、汇报材料（长输出、重措辞）、异常预警（重推理）
 * 用的是同一个模型：要么贵的干粗活，要么便宜的干不了细活。
 *
 * 这里是**单一事实源**：新增用途只改这一处——配置解析（`readAiConfig`）、
 * 登记页的表格、调用点取模型都跟着它走，不要在 service 里散写用途字符串。
 *
 * ⚠️ 与 `product-decisions.md`「不做 provider 抽象层」的关系：用途→模型是**配置映射**，
 * 不是抽象层——仍然是同一个 OpenAI 兼容端点、同一个 `chatJson()`，
 * 只是把发给上游的 `model` 字段按用途分开选。别在这上面长出一层多 provider 适配。
 */
export const AI_PURPOSES = [
  {
    code: 'form_inspect',
    name: '表单核验',
    desc: '上传 Excel 表单 → 推荐「单元格 ↔ 字段」映射；短文本、只要结构化 JSON，便宜模型就够',
    envKey: 'AI_MODEL_FORM_INSPECT',
  },
  {
    code: 'register',
    name: '文件登记',
    desc: '上传合同扫描件 → 抽取登记草案；长正文、要求字段齐全，建议用上下文大的模型',
    envKey: 'AI_MODEL_REGISTER',
  },
  {
    code: 'report',
    name: '汇报材料',
    desc: '按后端已算出的事实生成月报/周报正文；长输出、重措辞，值得上强模型',
    envKey: 'AI_MODEL_REPORT',
  },
  {
    code: 'anomaly',
    name: '异常预警',
    desc: '结算/报价/履约三类预警的结论与建议；重推理，且必须能对上后端算出的数字',
    envKey: 'AI_MODEL_ANOMALY',
  },
] as const;

/** 用途码（`AI_PURPOSES` 的 code 联合类型） */
export type AiPurpose = (typeof AI_PURPOSES)[number]['code'];

/** 用途元信息（页面展示与入参校验用）；未知用途返回 null，由调用方决定报错还是忽略 */
export function aiPurposeMeta(purpose: string): (typeof AI_PURPOSES)[number] | null {
  return AI_PURPOSES.find((p) => p.code === purpose) ?? null;
}

export interface AiConfig {
  /** 总开关：显式 `AI_ENABLED=false` 或缺少 key/baseUrl/model 时为 false */
  enabled: boolean;
  /** 站点地址，如 `https://api.deepseek.com`（可带或不带 `/v1`） */
  baseUrl: string;
  apiKey: string;
  /** **全局默认模型**，如 `deepseek-chat`：某用途没单独指定时用它 */
  model: string;
  /** 用途 → 实际生效模型（已按「用途登记 > 用途环境变量 > 全局 `model`」解析完） */
  models: Record<AiPurpose, string>;
  /** 用途 → 该用途的模型取自哪里（`default` = 跟随全局模型，诊断/页面标签用） */
  modelSources: Record<AiPurpose, 'db' | 'env' | 'default'>;
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

/**
 * 系统参数表里存 AI 配置的键名（**单一事实源**：service 读写、前端展示的"来源"都用这套键）。
 * 放在 `ai.*` 命名空间下，与业务参数混在同一张 `SysParam` 表里——
 * 复用既有的「内存缓存 + 保存即生效」能力，不必为几行配置另起一张表。
 */
export const AI_PARAM_KEYS = {
  enabled: 'ai.enabled',
  baseUrl: 'ai.baseUrl',
  apiKey: 'ai.apiKey',
  model: 'ai.model',
} as const;

/**
 * 用途级模型覆盖在 `SysParam` 里的键名：`ai.model.<用途>`。
 * 空值/未登记 = **跟随全局** `ai.model`（所以老部署只配了 `ai.model` 的行为完全不变）。
 */
export function aiPurposeParamKey(purpose: AiPurpose): string {
  return `${AI_PARAM_KEYS.model}.${purpose}`;
}

/**
 * 从「系统管理 → AI 信息登记」页面保存下来的配置（DB 侧）。
 * 全部可空：null/空串表示「该项未在页面登记」，此时回落环境变量。
 */
export interface AiStoredSettings {
  enabled?: boolean | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
  /** 用途级覆盖（键＝用途码）：没登记或空串 = 跟随全局 `model` */
  models?: Partial<Record<AiPurpose, string | null>> | null;
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
 * 从环境变量 + 页面登记的配置读配置（纯函数，便于单测）。
 *
 * 优先级：**页面登记（DB） > 环境变量 > 默认值**，逐项回落。
 * 这样两种用法都成立：运维只改 env（原有行为不变）；管理员在页面上填了就以页面为准。
 *
 * `enabled` 的判据：没有显式关闭 **且** 三个必填项齐全 —— 少一项就当作未配置，
 * 避免出现「界面显示已启用、每次调用都 401」的半死状态。
 * 显式关闭：页面开关为关（有值时以页面为准），或环境变量 `AI_ENABLED=false`（页面未登记开关时）。
 *
 * **用途级模型**（2026-10-23）：全局 `model` 仍是必填的兜底值；每个用途可再单独覆盖，
 * 取值链为「页面登记 `ai.model.<用途>` > 环境变量 `AI_MODEL_<用途>` > 全局 `model`」。
 * 因此只配全局的老部署，`models[*]` 全部等于全局值，行为与改造前一致。
 */
export function readAiConfig(
  env: Record<string, string | undefined> = {},
  stored: AiStoredSettings = {},
): AiConfig {
  const pick = (fromDb: string | null | undefined, fromEnv: string | undefined, fallback = ''): string =>
    str(fromDb ?? '') || str(fromEnv) || fallback;

  const baseUrl = pick(stored.baseUrl, env.AI_BASE_URL, AI_DEFAULTS.baseUrl);
  const apiKey = pick(stored.apiKey, env.AI_API_KEY);
  const model = pick(stored.model, env.AI_MODEL, AI_DEFAULTS.model);

  const models = {} as Record<AiPurpose, string>;
  const modelSources = {} as Record<AiPurpose, 'db' | 'env' | 'default'>;
  for (const p of AI_PURPOSES) {
    const fromDb = str(stored.models?.[p.code] ?? '');
    const fromEnv = str(env[p.envKey]);
    models[p.code] = fromDb || fromEnv || model;
    modelSources[p.code] = fromDb ? 'db' : fromEnv ? 'env' : 'default';
  }

  const explicitOff =
    typeof stored.enabled === 'boolean'
      ? stored.enabled === false
      : str(env.AI_ENABLED).toLowerCase() === 'false';
  const configured = Boolean(baseUrl && apiKey && model);

  return {
    enabled: !explicitOff && configured,
    baseUrl,
    apiKey,
    model,
    models,
    modelSources,
    timeoutMs: positiveInt(env.AI_TIMEOUT_MS, AI_DEFAULTS.timeoutMs),
    maxFileBytes: positiveInt(env.AI_MAX_FILE_BYTES, AI_DEFAULTS.maxFileBytes),
    maxCandidates: positiveInt(env.AI_MAX_CANDIDATES, AI_DEFAULTS.maxCandidates),
    maxFieldsInPrompt: positiveInt(env.AI_MAX_FIELDS, AI_DEFAULTS.maxFieldsInPrompt),
    hourlyLimitPerUser: positiveInt(env.AI_HOURLY_LIMIT, AI_DEFAULTS.hourlyLimitPerUser),
    maxTokens: positiveInt(env.AI_MAX_TOKENS, AI_DEFAULTS.maxTokens),
    maxTextChars: positiveInt(env.AI_MAX_TEXT_CHARS, AI_DEFAULTS.maxTextChars),
  };
}

/**
 * 取某个用途实际该用的模型 —— **调用点唯一入口**（别再直接读 `cfg.model`，
 * 否则用途级配置会被悄悄绕过）。
 */
export function aiModelFor(cfg: AiConfig, purpose: AiPurpose): string {
  return cfg.models?.[purpose] || cfg.model || '';
}

/** 对外暴露的配置快照：**绝不包含 apiKey**（前端只需要知道能不能用、每个用途用哪个模型） */
export function aiPublicStatus(cfg: AiConfig): {
  enabled: boolean;
  model: string;
  models: Record<string, string>;
} {
  const models: Record<string, string> = {};
  for (const p of AI_PURPOSES) {
    models[p.code] = cfg.enabled ? cfg.models[p.code] : '';
  }
  return { enabled: cfg.enabled, model: cfg.enabled ? cfg.model : '', models };
}

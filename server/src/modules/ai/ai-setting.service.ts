import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SysParamService } from '../../common/services/sys-param.service';
import { AI_PARAM_KEYS, readAiConfig, type AiConfig, type AiStoredSettings } from './ai-config';
import { LlmError, chatText } from './llm-client';

/** 页面提交的登记内容（都是「不传 = 不改」，只有 apiKey 额外区分「空串 = 清除」） */
export interface AiSettingInput {
  /** 启用开关：true/false；不传则不改 */
  enabled?: boolean;
  /** 接口地址，如 `https://api.deepseek.com`（带不带 `/v1` 都认）；空串 = 清除（回落环境变量） */
  baseUrl?: string;
  /** 模型名，如 `deepseek-chat`；空串 = 清除（回落环境变量） */
  model?: string;
  /** API Key：不传 = 不修改（页面永远拿不到明文回显）；空串 = 清除；有值 = 覆盖 */
  apiKey?: string;
}

export interface AiSettingSource {
  enabled: 'db' | 'env' | 'default';
  baseUrl: 'db' | 'env' | 'default';
  model: 'db' | 'env' | 'default';
  apiKey: 'db' | 'env' | 'none';
}

export interface AiSettingView {
  /** 当前是否真的可用（开关开着 且 三项齐全）——AI 助手页面据此显示"已启用/未启用" */
  enabled: boolean;
  model: string;
  baseUrl: string;
  /** 是否已保存过 key（**绝不回显明文**，只告诉页面"有一把"） */
  apiKeySaved: boolean;
  /** 每一项当前取自哪里：页面登记 / 环境变量 / 未配置 */
  source: AiSettingSource;
  /** 环境变量里是否已有完整配置（用于页面提示"现在用的是 docker/env 里的旧值"） */
  envConfigured: boolean;
  /** 一句话说明当前状态，页面直接展示，不用前端自己拼 */
  hint: string;
}

/**
 * AI 信息登记（系统管理 → AI 信息登记）。
 *
 * 存储口径：复用 `SysParam`（键 `ai.baseUrl` / `ai.apiKey` / `ai.model` / `ai.enabled`），
 * 复用它的内存缓存与「保存即生效」——登记完不需要重启服务。
 * 优先级见 `readAiConfig`：**页面登记 > 环境变量 > 默认值**，逐项回落，
 * 所以老部署只配 env 的行为完全不变。
 *
 * 安全口径：
 * - `apiKey` 只写不读：任何接口都不把明文回给前端（页面只显示"已保存"）；
 * - 操作日志里 `apikey` 命中 `SECRET_FIELD_KEYS` → 记成 `******`（见 common/utils/mask.ts）。
 */
@Injectable()
export class AiSettingService {
  private readonly logger = new Logger(AiSettingService.name);

  constructor(private sysParam: SysParamService) {}

  /** 从系统参数缓存里取 AI 相关项（一次拿全表，命中内存缓存） */
  private async stored(): Promise<AiStoredSettings> {
    const all = await this.sysParam.getAll();
    const enabledRaw = String(all[AI_PARAM_KEYS.enabled] ?? '').trim().toLowerCase();
    return {
      // 只有明确写了 true/false 才算"页面登记过开关"，其它（含未登记）返回 undefined → 交给 env 判断
      enabled: enabledRaw === 'true' ? true : enabledRaw === 'false' ? false : undefined,
      baseUrl: String(all[AI_PARAM_KEYS.baseUrl] ?? '').trim(),
      apiKey: String(all[AI_PARAM_KEYS.apiKey] ?? '').trim(),
      model: String(all[AI_PARAM_KEYS.model] ?? '').trim(),
    };
  }

  /** 当前生效配置（三个 service 都走这里，保证"改一处、全站生效"） */
  async resolve(): Promise<AiConfig> {
    return readAiConfig(process.env as Record<string, string | undefined>, await this.stored());
  }

  /** 页面用的配置视图（不含明文 key） */
  async view(): Promise<AiSettingView> {
    const env = process.env as Record<string, string | undefined>;
    const stored = await this.stored();
    const cfg = readAiConfig(env, stored);
    const envCfg = readAiConfig(env);

    const envConfigured = Boolean(envCfg.baseUrl && envCfg.apiKey && envCfg.model);
    const source: AiSettingSource = {
      enabled: typeof stored.enabled === 'boolean' ? 'db' : env.AI_ENABLED ? 'env' : 'default',
      baseUrl: stored.baseUrl ? 'db' : env.AI_BASE_URL ? 'env' : 'default',
      model: stored.model ? 'db' : env.AI_MODEL ? 'env' : 'default',
      apiKey: stored.apiKey ? 'db' : env.AI_API_KEY ? 'env' : 'none',
    };

    const missing: string[] = [];
    if (!cfg.baseUrl) missing.push('接口地址');
    if (!cfg.apiKey) missing.push('API Key');
    if (!cfg.model) missing.push('模型名');

    const hint = missing.length
      ? `还缺 ${missing.join(' / ')}，填完并保存后 AI 功能即可使用`
      : cfg.enabled
        ? `已启用，当前模型 ${cfg.model}${source.apiKey === 'env' ? '（密钥来自环境变量）' : ''}`
        : '配置齐全但已停用：打开上方开关即可恢复使用';

    return {
      enabled: cfg.enabled,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKeySaved: Boolean(cfg.apiKey),
      source,
      envConfigured,
      hint,
    };
  }

  /**
   * 保存登记内容。
   * 空串表示"清除该项"（回落到环境变量），**不是**"写成空值"——这样把页面填的值擦掉就恢复成 env 口径。
   */
  async save(input: AiSettingInput): Promise<AiSettingView> {
    const writes: Array<[string, string]> = [];

    if (typeof input?.enabled === 'boolean') {
      writes.push([AI_PARAM_KEYS.enabled, input.enabled ? 'true' : 'false']);
    }
    if (typeof input?.baseUrl === 'string') writes.push([AI_PARAM_KEYS.baseUrl, input.baseUrl.trim()]);
    if (typeof input?.model === 'string') writes.push([AI_PARAM_KEYS.model, input.model.trim()]);
    // apiKey：undefined = 不修改（页面上是密码框，不回显，也就不该被"空着提交"清掉）
    if (typeof input?.apiKey === 'string') writes.push([AI_PARAM_KEYS.apiKey, input.apiKey.trim()]);

    if (!writes.length) throw new BadRequestException('没有需要保存的内容');

    // 一次事务写完四项：不能出现「地址已换、密钥还是旧的」这种半截配置
    await this.sysParam.setMany(writes, 'AI 信息登记（系统管理页面维护）');
    await this.sysParam.refresh();

    // 只记"改了哪几项"，不记值：密钥与地址都可能敏感，日志页人人都能看
    this.logger.log(`AI 配置已更新：${writes.map(([k]) => k).join(', ')}`);
    return this.view();
  }

  /**
   * 用给定/已存配置**真打一次上游**，验证地址、密钥、模型是否匹配。
   * 不抛 500：失败原因原样返回给页面（这是个诊断接口，不是业务动作）。
   */
  async test(input: AiSettingInput = {}): Promise<{
    ok: boolean;
    message: string;
    ms?: number;
    model?: string;
    reply?: string;
  }> {
    const stored = await this.stored();
    // 页面上的输入优先（还没保存也能先测），没填的项用已存/环境变量
    const merged = readAiConfig(process.env as Record<string, string | undefined>, {
      baseUrl: typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : stored.baseUrl,
      apiKey: typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim() : stored.apiKey,
      model: typeof input.model === 'string' && input.model.trim() ? input.model.trim() : stored.model,
      enabled: stored.enabled,
    });

    const missing: string[] = [];
    if (!merged.baseUrl) missing.push('接口地址');
    if (!merged.apiKey) missing.push('API Key');
    if (!merged.model) missing.push('模型名');
    if (missing.length) return { ok: false, message: `还没填 ${missing.join(' / ')}` };

    const started = Date.now();
    try {
      const { text } = await chatText(
        fetch,
        {
          baseUrl: merged.baseUrl,
          apiKey: merged.apiKey,
          model: merged.model,
          // 诊断比正式调用更短：15s 没回就该怀疑地址写错了，不必让管理员干等 30s
          timeoutMs: Math.min(merged.timeoutMs, 15000),
          maxTokens: 32,
        },
        [{ role: 'user', content: '只回复"ok"两个字符，不要别的。' }],
      );
      return {
        ok: true,
        message: '连接成功',
        ms: Date.now() - started,
        model: merged.model,
        reply: text.slice(0, 60),
      };
    } catch (e: any) {
      return { ok: false, message: this.explain(e), ms: Date.now() - started };
    }
  }

  /** 把上游错误翻译成管理员能照做的提示（401/404/429 是最常见的三种配错） */
  private explain(e: any): string {
    if (e instanceof LlmError) {
      if (e.kind === 'TIMEOUT') return '连接超时：检查接口地址是否可达（公司网络/代理）、是否正确';
      if (e.kind === 'NOT_CONFIGURED') return '配置不完整，请补全地址、密钥与模型名';
      const detail = String(e.message || '');
      if (e.status === 401 || e.status === 403) return '密钥无效或没有该模型的权限（401/403）';
      if (e.status === 404) return '接口地址不对（404）：确认是否填了 /v1 所在的主机根地址';
      if (e.status === 429) return '上游限流或额度不足（429）';
      if (e.status && e.status >= 500) return `上游服务异常（${e.status}），稍后重试`;
      // 没拿到 HTTP 状态又把 fetch 打挂了：99% 是地址/出网问题，别把 "fetch failed" 甩给管理员
      if (!e.status && /parse url|invalid url/i.test(detail)) {
        return '接口地址格式不对：要填 http(s):// 开头的完整地址，例：https://api.deepseek.com';
      }
      if (!e.status && /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|socket|network/i.test(detail)) {
        return '连不上接口地址：确认主机名/端口正确、服务端能出网（如需代理请在服务器侧配置）';
      }
      return detail.slice(0, 200) || '调用失败';
    }
    return String(e?.message || e || '调用失败').slice(0, 200);
  }
}

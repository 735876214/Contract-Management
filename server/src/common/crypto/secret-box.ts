import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 系统参数里的**密钥类**值的静态加密（2026-11-24 引入，借 ApeAdmin 的 Fernet 思路，用 Node 自带 aes-256-gcm）。
 *
 * 为什么需要：`ai.apiKey` 一直**明文**存在 `SysParam.value`，唯一保护是「出口过滤」——
 * 接口不回显（`SECRET_PARAM_KEYS`）。但静态明文意味着：一次 `pg_dump`、一份备份、
 * 或者任何能只读连库的人，都能拿到上游 LLM 密钥。出口过滤管的是「谁看得见」，
 * 加密管的是「库被拿走以后还看得见吗」，两件事都得有。
 *
 * 取舍（**故意不做成硬约束**）：
 * - 没配 `PARAM_SECRET_KEY` → `seal()` **原样返回明文**并打一条 WARN。
 *   否则老部署升级后一保存 AI 配置就 500，等于用一个可选安全项换一次线上故障。
 * - 明文存量不需要迁移脚本：`open()` 见到非 `enc:v1:` 前缀就当明文放行，
 *   下次在页面重新保存一次就自动升级成密文。
 * - 密文格式自描述（`enc:v1:` + iv + tag + ct），换算法版本时前缀加版本号即可并行读取。
 *
 * ⚠️ 运维后果：`PARAM_SECRET_KEY` 丢了 = 已加密的值解不开（只能重填密钥）。
 * 它必须进备份清单，且**不能**用会轮换的值（比如 JWT_SECRET）派生——
 * 换 JWT 只是踢人下线，换这个会让 AI 静默挂掉。
 */
const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // GCM 推荐 96bit

let cachedRaw: string | null = null;
let cachedKey: Buffer | null = null;
let warnedNoKey = false;

function logger() {
  // 不引 Nest Logger：这个模块要能被 `.mts` 纯函数用例（strip-only）直接加载
  return console;
}

/** 解析 `PARAM_SECRET_KEY`（base64，32 字节）；非法或未配置都返回 null */
export function resolveSecretsKey(raw: string | undefined = process.env.PARAM_SECRET_KEY): Buffer | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (cachedRaw === value) return cachedKey;
  let key: Buffer | null = null;
  try {
    const buf = Buffer.from(value, 'base64');
    // 32 字节才是 aes-256；长度不对直接当没配，不要半途换算法
    if (buf.length === 32) key = buf;
  } catch {
    key = null;
  }
  cachedRaw = value;
  cachedKey = key;
  return key;
}

export function secretsKeyConfigured(): boolean {
  return resolveSecretsKey() !== null;
}

export function isSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/** 加密。未配置密钥时**原样返回明文**（见文件头的取舍说明） */
export function sealSecret(plain: string): string {
  const text = String(plain ?? '');
  if (!text) return '';
  if (isSealed(text)) return text; // 已经是密文，别二次加密
  const key = resolveSecretsKey();
  if (!key) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      logger().warn(
        '[secret-box] 未配置 PARAM_SECRET_KEY（base64 32 字节）→ 密钥类参数以明文落库。' +
          '生成：openssl rand -base64 32；配好后在页面重新保存一次即自动升级为密文。',
      );
    }
    return text;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** 解密。非密文原样返回（兼容明文存量）；密文但解不开 → 抛可读错误，**不静默返回空** */
export function openSecret(value: string): string {
  const text = String(value ?? '');
  if (!isSealed(text)) return text;
  const key = resolveSecretsKey();
  if (!key) {
    throw new SecretBoxError(
      '这个值是加密存储的，但当前进程没有可用的 PARAM_SECRET_KEY（base64 32 字节）。' +
        '请恢复与该密文配套的密钥后再启动；换新密钥会导致旧密文无法解开。',
    );
  }
  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new SecretBoxError('密文格式不完整（期望 enc:v1:<iv>:<tag>:<ct>）');
  const [ivB64, tagB64, ctB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    // GCM 认证失败几乎都是「换了密钥」或「密文被改」——给运维一条能自救的信息
    throw new SecretBoxError(
      '密钥类参数解密失败：PARAM_SECRET_KEY 与写入时的不是同一把，或密文已被篡改。' +
        '确认密钥后重启动；确实丢失密钥时，在系统管理里重新填写该密钥即可覆盖。',
    );
  }
}

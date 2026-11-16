import { BadRequestException } from '@nestjs/common';

/**
 * 单个字段值的长度上限。
 *
 * 背景（第 16 轮审计）：Prisma 的 String 落到 PostgreSQL 是 `text`，本身没有长度约束，
 * 而控制器几乎都是 `@Body() body: any`（没有 DTO 校验），于是前端可以直接 POST 一个
 * 几 MB 的 remark，库里照样存下——列表页/导出/日志都会跟着变慢。这里统一兜一个上限，
 * 超过即 400，避免脏数据进库（业务上没有任何一个文本字段需要 10 万字符）。
 */
export const MAX_FIELD_TEXT = 100_000;

/**
 * 按 Prisma 模型白名单过滤未知字段。
 * 防止前端字段名变更时整个请求 500——未知字段会被忽略，并写入 warn 日志。
 *
 * 返回 `any` 以兼容 Prisma 的严格类型推断（构造 create/update input 时无需再次断言）。
 */
export function pickFields(
  data: any,
  allowed: readonly string[],
  opts: { strict?: boolean; label?: string } = {},
): any {
  if (!data || typeof data !== 'object') return {};
  const out: any = {};
  const dropped: string[] = [];
  for (const k of Object.keys(data)) {
    if (allowed.includes(k)) {
      const v = data[k];
      if (typeof v === 'string' && v.length > MAX_FIELD_TEXT) {
        throw new BadRequestException(
          `字段${opts.label ? `（${opts.label}）` : ''} ${k} 内容过长：${v.length} 字符，上限 ${MAX_FIELD_TEXT}`,
        );
      }
      out[k] = v;
    } else {
      dropped.push(k);
    }
  }
  if (dropped.length) {
    const msg = `忽略未识别的字段${opts.label ? `（${opts.label}）` : ''}：${dropped.join(', ')}`;
    if (opts.strict) throw new BadRequestException(msg);
    // 不抛错，写入控制台即可；不打断保存
    // eslint-disable-next-line no-console
    console.warn('[pickFields]', msg);
  }
  return out;
}

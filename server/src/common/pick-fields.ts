import { BadRequestException } from '@nestjs/common';

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
      out[k] = data[k];
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

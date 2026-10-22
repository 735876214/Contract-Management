/**
 * Prisma 异常 → 对外响应（**零依赖**，可被 `.mts`/`.ts` 单测直接加载）。
 *
 * 背景（第 21 轮审计）：`AllExceptionsFilter` 原来对非 `HttpException` 直接
 * `message = exception.message` 回给前端。Prisma 的报错里带着**表名、列名、约束名、SQL 片段**，
 * 前端弹窗与「异常日志」里就把库结构吐给了任何能触发写入的用户；
 * 更要紧的是几类**可预期**的写冲突被当成 500：删有引用的行（P2003）→ 500、
 * 撞唯一键（P2002）→ 500、改/删已被别人删掉的行（P2025）→ 500，
 * 用户看到「服务器内部错误」，运维在日志里才看得到真正原因。
 *
 * 这里只做「已知写冲突 → 明确的 4xx + 人话」，其余一律 500 + 统一文案，
 * 原始 message/stack 只进服务端日志。
 */

export interface MappedError {
  /** HTTP 状态码 */
  status: number;
  /** 响应体 `code`（沿用项目约定：1001=参数错、0=成功） */
  code: number;
  /** 可以给用户看的文案 */
  message: string;
}

/** 从 Prisma 异常里取错误码（`PrismaClientKnownRequestError.code`，也可能是 `P20xx` 字符串） */
export function prismaErrorCode(e: unknown): string | null {
  const code = (e as any)?.code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : null;
}

/**
 * 映射已知 Prisma 写冲突；返回 `null` 表示「不是可预期的业务冲突」——调用方按 500 处理。
 * `meta.target` 只用于把约束涉及的**字段名**拼进提示（不是整段 SQL），且只在白名单字符集内采信。
 */
export function mapPrismaError(e: unknown): MappedError | null {
  const code = prismaErrorCode(e);
  if (!code) return null;
  const target = (e as any)?.meta?.target;
  const fields = Array.isArray(target)
    ? target.filter((f: unknown) => typeof f === 'string' && /^[A-Za-z0-9_]+$/.test(f))
    : typeof target === 'string' && /^[A-Za-z0-9_]+$/.test(target)
      ? [target]
      : [];
  const suffix = fields.length ? `（${fields.join('、')}）` : '';
  switch (code) {
    case 'P2002':
      return { status: 400, code: 1001, message: `数据重复：唯一约束冲突${suffix}，请检查后重试` };
    case 'P2003':
      return { status: 400, code: 1001, message: `存在关联数据，无法完成本次操作${suffix}` };
    case 'P2025':
      return { status: 404, code: 1404, message: '记录不存在或已被删除，请刷新后重试' };
    case 'P2000':
      return { status: 400, code: 1001, message: '字段内容超出长度限制，请缩短后重试' };
    case 'P2014':
      return { status: 400, code: 1001, message: '该操作会破坏关联关系（仍有子数据引用），请先处理关联数据' };
    default:
      return null;
  }
}

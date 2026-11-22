import { BadRequestException, NotFoundException } from '@nestjs/common';
import { requestContext } from '../services/request-context';
import { API_CODE } from '../error-codes';
import { MISSING_PROJECT_CONTEXT } from './project-context-message';

/** 请求内缺项目上下文：统一抛 400 + 稳定 code 1412（前端据此刷新项目列表并重放请求） */
function missingContextError(): BadRequestException {
  return new BadRequestException({ code: API_CODE.PROJECT_CONTEXT_MISSING, message: MISSING_PROJECT_CONTEXT });
}

/**
 * 项目级模型「按 id 取一条」的 where（2026-10-20 第 3 轮审计用）。
 *
 * 背景：`@ProjectId()` 只能保证「你进得来这个项目」，管不了「URL 里这条数据的 id 属不属于它」。
 * 各 service 里大量 `findUnique({ where: { id } })` 于是成了跨项目 IDOR 的入口：
 * 换个 id 就能读/改/删别人的结算、发票、收领单、利润表。
 *
 * 用法：`this.prisma.invoice.findFirst({ where: projectWhere(id), ... })`
 *
 * 口径（2026-11-22 第 24 轮审计改成 **fail-closed**）：
 * - 有请求上下文（`x-project-id` / `?projectId=`）→ 追加 `projectId` 过滤，跨项目一律查不到；
 * - **在 HTTP 请求里但没有项目上下文 → 直接 400**（改造前是不追加过滤，等于"漏带头就能跨项目读"）；
 * - 请求之外（启动期 seed、脚本、单测、跨项目聚合）→ 不追加，行为与改造前一致。
 * - **只适用于表上真有 `projectId` 列的模型**；`User`/`Role`/`Dict*` 这类全局表不要用。
 */
export function projectWhere(id: string, extra?: Record<string, any>): Record<string, any> {
  const { projectId: _ignored, ...rest } = extra || {};
  const projectId = requestContext.projectId;
  // 请求内缺项目上下文 = 异常客户端：宁可 400 也不能退回"不过滤"（fail-closed）
  if (!projectId && requestContext.inRequest()) throw missingContextError();
  // projectId 最后展开：调用方在 extra 里塞别的项目 id 也不能把过滤放宽
  return { id, ...rest, ...(projectId ? { projectId } : {}) };
}

/**
 * 同 `projectWhere`，但查不到就抛 404。
 * `message` 用业务口径（如「发票不存在」），不要暴露「存在但不属于你」——那等于给枚举做信标。
 */
export async function findScopedOrThrow<T = any>(
  delegate: { findFirst: (args: any) => Promise<T | null> },
  id: string,
  message: string,
  extra?: Record<string, any>,
): Promise<T> {
  const row = await delegate.findFirst({ where: projectWhere(id, extra) });
  if (!row) throw new NotFoundException(message);
  return row as T;
}

/**
 * 共享主数据（供应商库 / 分包商库 / 其他项目库）的 `GLOBAL | PROJECT` 范围 where。
 *
 * 三个模块此前各抄一份 `private scopeWhere()`，写法都是
 * `scope === 'PROJECT' && projectId ? { projectId } : {}`
 * ——**请求内漏带 `x-project-id` 时静默退化成"看全库"**（PROJECT 模式下等于跨项目读主数据）。
 * 这里统一成 fail-closed：PROJECT 模式且请求内无上下文 → 400；GLOBAL 与请求外保持原行为。
 */
export function sharedScopeWhere(scope: string, projectId?: string | null): Record<string, any> {
  if (scope !== 'PROJECT') return {};
  const pid = projectId || requestContext.projectId;
  if (!pid && requestContext.inRequest()) throw missingContextError();
  return pid ? { projectId: pid } : {};
}

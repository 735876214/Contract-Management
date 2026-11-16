import { NotFoundException } from '@nestjs/common';
import { requestContext } from '../services/request-context';

/**
 * 项目级模型「按 id 取一条」的 where（2026-10-20 第 3 轮审计用）。
 *
 * 背景：`@ProjectId()` 只能保证「你进得来这个项目」，管不了「URL 里这条数据的 id 属不属于它」。
 * 各 service 里大量 `findUnique({ where: { id } })` 于是成了跨项目 IDOR 的入口：
 * 换个 id 就能读/改/删别人的结算、发票、收领单、利润表。
 *
 * 用法：`this.prisma.invoice.findFirst({ where: projectWhere(id), ... })`
 *
 * 口径：
 * - 有请求上下文（`x-project-id` / `?projectId=`）→ 追加 `projectId` 过滤，跨项目一律查不到；
 * - 没有上下文（启动期 seed、定时任务、单测、跨项目聚合）→ 不追加，行为与改造前一致。
 * - **只适用于表上真有 `projectId` 列的模型**；`User`/`Role`/`Dict*` 这类全局表不要用。
 */
export function projectWhere(id: string, extra?: Record<string, any>): Record<string, any> {
  const { projectId: _ignored, ...rest } = extra || {};
  const projectId = requestContext.projectId;
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

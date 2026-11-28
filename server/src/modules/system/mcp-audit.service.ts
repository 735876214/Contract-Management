import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * MCP 调用审计（系统管理 → MCP 调用）。**只读**。
 *
 * 先想清楚这个页面「不做什么」：
 * - **不重复维护工具清单**。MCP 的工具/资源/提示词权威定义在 `mcp/` 包里（`mcp/README.md`），
 *   在这里再抄一份必然漂移；页面展示的是**实际被调用过的工具**（`OperationLog.actorTool` 聚合），
 *   这恰好是「清单里看不出来」的那部分：谁在用、用成了没有、慢不慢。
 * - **不提供开关**：工具是否暴露由 `mcp/src/server.ts` 与权限码决定（配错就去改代码/角色），
 *   给一个运行时开关会让人以为「关掉就没人能调」——后端 RBAC 才是边界。
 *
 * 数据来源：P0 已给每条 MCP 调用写上 `actorTool`（含纯 GET），这里只是把它读出来。
 */
@Injectable()
export class McpAuditService {
  /** 概览窗口：最近 30 天（再长就该归档了，读模型不该无限扫） */
  private static readonly WINDOW_DAYS = 30;
  /** 概览最多采样多少行：这是「用量概览」不是「全量统计」，超出就标 truncated */
  private static readonly SAMPLE_LIMIT = 5000;

  constructor(private readonly prisma: PrismaClient) {}

  async overview() {
    const since = new Date(Date.now() - McpAuditService.WINDOW_DAYS * 24 * 3600 * 1000);
    const rows = await this.prisma.operationLog.findMany({
      where: { actorTool: { not: null }, createdAt: { gte: since } },
      select: { actorTool: true, result: true, duration: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: McpAuditService.SAMPLE_LIMIT,
    });

    const byTool = new Map<
      string,
      { tool: string; calls: number; failures: number; durationSum: number; durationCount: number; lastAt: Date | null }
    >();
    for (const row of rows) {
      const tool = String(row.actorTool || '');
      if (!tool) continue;
      const hit = byTool.get(tool) ?? {
        tool,
        calls: 0,
        failures: 0,
        durationSum: 0,
        durationCount: 0,
        lastAt: null as Date | null,
      };
      hit.calls += 1;
      if (row.result === 'FAIL') hit.failures += 1;
      if (typeof row.duration === 'number') {
        hit.durationSum += row.duration;
        hit.durationCount += 1;
      }
      if (!hit.lastAt || row.createdAt > hit.lastAt) hit.lastAt = row.createdAt;
      byTool.set(tool, hit);
    }

    const tools = [...byTool.values()]
      .map((t) => ({
        tool: t.tool,
        calls: t.calls,
        failures: t.failures,
        successRate: t.calls ? Math.round(((t.calls - t.failures) / t.calls) * 100) : 100,
        avgDurationMs: t.durationCount ? Math.round(t.durationSum / t.durationCount) : null,
        lastAt: t.lastAt,
      }))
      .sort((a, b) => b.calls - a.calls);

    return {
      windowDays: McpAuditService.WINDOW_DAYS,
      since,
      /** 采样到的调用条数；等于上限说明「更多调用没统计进来」 */
      sampled: rows.length,
      truncated: rows.length >= McpAuditService.SAMPLE_LIMIT,
      totals: {
        calls: rows.length,
        failures: rows.filter((r) => r.result === 'FAIL').length,
        tools: tools.length,
      },
      tools,
    };
  }

  /** 调用明细（分页）：按工具/结果筛选，倒序 */
  async calls(query: Record<string, unknown>) {
    const page = Math.max(1, Math.floor(Number(query?.page ?? 1)) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query?.pageSize ?? 20)) || 20));
    const tool = String(query?.tool ?? '').trim();
    const result = String(query?.result ?? '').trim().toUpperCase();
    const keyword = String(query?.keyword ?? '').trim();

    const where: Record<string, unknown> = { actorTool: { not: null } };
    if (tool) where.actorTool = tool;
    if (result === 'SUCCESS' || result === 'FAIL') where.result = result;
    if (keyword) {
      where.OR = [
        { url: { contains: keyword } },
        { username: { contains: keyword } },
        { requestId: { contains: keyword } },
      ];
    }

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.operationLog.count({ where }),
      this.prisma.operationLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          createdAt: true,
          actorTool: true,
          username: true,
          method: true,
          url: true,
          result: true,
          duration: true,
          message: true,
          requestId: true,
        },
      }),
    ]);
    return { list: rows, total, page, pageSize };
  }
}

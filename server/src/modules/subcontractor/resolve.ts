import type { PrismaClient } from '@prisma/client';

/**
 * 分包商主数据「按名称解析 / 不存在则创建」的通用写入原语（2026-11-21）。
 *
 * 背景：劳务授权台账（labor）等模块需要把名称快照挂靠到 `Subcontractor` 主数据，
 * 过去直接在自身 service 里 `prisma.subcontractor.create(...)`，被
 * `scripts/check-module-boundaries.mjs` 判为「跨模块直写他人表」。
 * 把写入下沉到 subcontractor 模块并经 index.ts 导出，其他模块只调用本函数、不碰表。
 *
 * 口径（沿用原 labor 实现）：
 * - 空名称 → 返回 null；
 * - 先按「项目 + 名称」查（含 projectId 为 null 的全局共享行），命中即复用；
 * - 未命中则创建；并发唯一键冲突时回查一次。
 */
export async function resolveOrCreateSubcontractor(
  prisma: PrismaClient,
  name?: string | null,
  projectId?: string | null,
): Promise<string | null> {
  const n = String(name ?? '').trim();
  if (!n) return null;
  const pid = projectId ?? null;
  const found = await prisma.subcontractor.findFirst({
    where: { name: n, OR: [{ projectId: pid }, { projectId: null }] },
    select: { id: true },
  });
  if (found) return found.id;
  try {
    const created = await prisma.subcontractor.create({ data: { name: n, projectId: pid } });
    return created.id;
  } catch {
    // 并发下唯一键冲突：回查一次
    const again = await prisma.subcontractor.findFirst({ where: { name: n }, select: { id: true } });
    return again?.id ?? null;
  }
}

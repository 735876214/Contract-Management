import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { round2 } from '../../common/calc/money';
import { mulDecimal, sumRounded } from '../../common/calc/amounts';
import { projectWhere } from '../../common/utils/project-scope';
import {
  NOTICE,
  DOCUMENT,
  RESULT_REPORT,
  PRICE_COMPARE,
  TASK_STATUS_LABELS,
  stageChain,
} from '../../constants/procurementFlow';

/**
 * 采购任务工作流·共享件（P1-3 大服务拆分）。
 *
 * 从 procurement-task.service.ts 抽出，供「主服务（CRUD/生命周期）」与
 * 「阶段表单服务（六阶段表单 + 投标/评审 + 成交报告 + 价格对比）」共用：
 *  - 纯解析/格式化助手：textOf / numOf / intOf / dateOf / toWan / parseJsonArray
 *  - 阶段下标纯函数 + 采前会阈值常量
 *  - 依赖 prisma 的读取原语：taskOf / mainContract / estimatedAmountYuan / resolveSupplierId
 *  - 任务 DTO 映射：serializeTask（纯函数，不含 this）
 *
 * 这样两个服务之间**不互相依赖**，避免循环引用与重复实现导致的漂移。
 */

type JsonValue = Prisma.JsonValue;

/** 采购任务行（供 serializeTask 使用；与 prisma.procurementTask 结构对齐） */
export interface TaskRow {
  id: string;
  projectId: string;
  taskNo: string;
  type: string;
  content: string;
  purpose: string | null;
  status: string;
  stage: number;
  /** 乐观锁（2026-11-13）：列表/详情都回传，前端更新时必须带回 */
  version: number;
  preMeetingRequired: boolean;
  totalListId: string | null;
  procurementCategory: string | null;
  techQuality: string | null;
  acceptanceMethod: string | null;
  paymentMethod: string | null;
  /** 条款选择（业务口径 2026-10-16）：仅用于回显，正文快照在三个文本列里 */
  technicalClauseId?: string | null;
  qualityClauseId?: string | null;
  paymentClauseId?: string | null;
  acceptanceClauseId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 文本归一化：trim 后空串转 null（各阶段表单共用，避免重复定义） */
export const textOf = (v: any): string | null => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** 数值解析：空值返回 null，非数字或低于下限时按业务标签抛错（各阶段表单共用） */
export const numOf =
  (label: string, opts: { min?: number } = {}) =>
  (v: any): number | null => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new BadRequestException(`${label}必须为数字`);
    if (opts.min != null && n < opts.min) throw new BadRequestException(`${label}不能为负数`);
    return n;
  };

/** 整数解析：空值返回 null，非整数或低于下限时按业务标签抛错（各阶段表单共用） */
export const intOf =
  (label: string, opts: { min?: number } = {}) =>
  (v: any): number | null => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new BadRequestException(`${label}必须为整数`);
    if (opts.min != null && n < opts.min) throw new BadRequestException(`${label}不能为负数`);
    return n;
  };

/** 日期解析：空值返回 null，非法格式按业务标签抛错（各阶段表单共用） */
export const dateOf = (label: string) => (v: any): Date | null => {
  if (v === '' || v == null) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new BadRequestException(`${label}格式无效`);
  return d;
};

/** 元 → 万元（保留 2 位小数，统一舍入原语） */
export const toWan = (yuan: number): number => round2((yuan || 0) / 10000);

/** 半结构化 JSON 字段 → 数组（PG jsonb 返回已解析值；兼容历史 JSON 字符串） */
export function parseJsonArray<T = any>(raw: JsonValue | string | any[] | null | undefined): T[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** 采前会会议纪要生成阈值（预计采购金额，单位：元）。单项采购 ≥ 100 万时生成。 */
export const PRE_MEETING_THRESHOLD_YUAN = 1_000_000;

export function noticeStageIndex(task: { type: string; preMeetingRequired: boolean }): number {
  return stageChain(task.type, task.preMeetingRequired).findIndex((s) => s.key === NOTICE.key);
}
export function documentStageIndex(task: { type: string; preMeetingRequired: boolean }): number {
  return stageChain(task.type, task.preMeetingRequired).findIndex((s) => s.key === DOCUMENT.key);
}
export function resultReportStageIndex(task: { type: string; preMeetingRequired: boolean }): number {
  return stageChain(task.type, task.preMeetingRequired).findIndex((s) => s.key === RESULT_REPORT.key);
}
export function priceCompareStageIndex(task: { type: string; preMeetingRequired: boolean }): number {
  return stageChain(task.type, task.preMeetingRequired).findIndex((s) => s.key === PRICE_COMPARE.key);
}

/**
 * 采购任务是否存在（有请求上下文时同时校验项目归属）。
 *
 * ⚠️ 走 `projectWhere()`：**请求内缺项目头一律 400**（fail-closed）。
 * 改造前这里是 `...(projectId ? { projectId } : {})`——漏带 `x-project-id` 时不追加过滤，
 * 于是 `GET /api/procurement-tasks/<别项目 id>` 直接读到别人的采购任务（2026-11-22 审计）。
 */
export async function taskOf(prisma: PrismaClient, taskId: string) {
  const task = await prisma.procurementTask.findFirst({ where: projectWhere(taskId) });
  if (!task) throw new NotFoundException('采购任务不存在');
  return task;
}

/** 任务关联的「主合同」= 生成时间最早的合同（采购任务与合同的关联只由 Contract.taskId 表达） */
export async function mainContract(prisma: PrismaClient, taskId: string) {
  return prisma.contract.findFirst({
    where: { taskId },
    orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
  });
}

/** 预计采购金额（元）= Σ 预计采购单价（控制价）× 暂定数量，逐项 2 位累加。 */
export async function estimatedAmountYuan(prisma: PrismaClient, taskId: string): Promise<number> {
  const items = await prisma.procurementTotalItem.findMany({
    where: { taskId },
    select: { qty: true, planPrice: true },
  });
  return sumRounded(items.map((i) => mulDecimal(i.planPrice, i.qty)), 2);
}

/**
 * 批量计算预计采购金额（元），key = taskId（列表页避免 N+1）。
 * 与 estimatedAmountYuan **同一引擎**：逐项精确十进制乘法 + 逐项 2 位舍入累加，
 * 保证「列表页」与「详情/采前会阈值/合同带入」算出的金额一致（消除历史浮点漂移）。
 */
export async function estimatedAmountMap(
  prisma: PrismaClient,
  taskIds: string[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!taskIds.length) return map;
  const items = await prisma.procurementTotalItem.findMany({
    where: { taskId: { in: taskIds } },
    select: { taskId: true, qty: true, planPrice: true },
  });
  const grouped = new Map<string, Array<number | null>>();
  for (const it of items) {
    const arr = grouped.get(it.taskId) ?? [];
    arr.push(mulDecimal(it.planPrice, it.qty));
    grouped.set(it.taskId, arr);
  }
  for (const [taskId, amounts] of grouped) map.set(taskId, sumRounded(amounts, 2));
  return map;
}

/** 供应商名称 → id（不存在返回 null） */
export async function resolveSupplierId(prisma: PrismaClient, name: string): Promise<string | null> {
  const s = await prisma.supplier.findFirst({ where: { name } });
  return s?.id ?? null;
}

/** 任务 DTO 映射（纯函数；contractId 由调用方派生后传入） */
export function serializeTask(r: TaskRow, contractId: string | null = null) {
  return {
    id: r.id,
    taskNo: r.taskNo,
    type: r.type,
    content: r.content,
    purpose: r.purpose ?? '',
    status: r.status,
    statusLabel: TASK_STATUS_LABELS[r.status as keyof typeof TASK_STATUS_LABELS] ?? r.status,
    stage: r.stage,
    /** 乐观锁：更新时原样回传（assertVersion 强制要求，缺失即 409） */
    version: r.version,
    preMeetingRequired: r.preMeetingRequired,
    totalListId: r.totalListId,
    contractId,
    procurementCategory: r.procurementCategory ?? null,
    techQuality: r.techQuality ?? '',
    acceptanceMethod: r.acceptanceMethod ?? '',
    paymentMethod: r.paymentMethod ?? '',
    technicalClauseId: r.technicalClauseId ?? null,
    qualityClauseId: r.qualityClauseId ?? null,
    paymentClauseId: r.paymentClauseId ?? null,
    acceptanceClauseId: r.acceptanceClauseId ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

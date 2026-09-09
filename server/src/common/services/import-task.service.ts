import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import * as fs from 'fs';
import * as path from 'path';
import { paginate, buildResult } from '../utils/helpers';
import { ImportOutcome, ImportRowError, ImportRunnerService, RunOptions } from './import-runner.service';
import { NotificationService } from '../../modules/notification/notification.service';

/** 超过该行数走异步导入（需求 2.7） */
export const ASYNC_IMPORT_THRESHOLD = 1000;

export interface SubmitContext {
  module: string;
  moduleName: string;
  fileName?: string;
  projectId?: string;
  userId?: string;
  username?: string;
}

/**
 * 异步导入任务服务（需求 2.7）
 *
 * - ≤ 阈值行数：同步执行，直接返回结果
 * - > 阈值行数：立即返回 taskId，后台执行，可轮询进度、完成后站内通知、失败行可下载错误报告
 */
@Injectable()
export class ImportTaskService {
  constructor(
    private prisma: PrismaClient,
    private runner: ImportRunnerService,
    private notifier: NotificationService,
  ) {}

  private errorDir(): string {
    const dir = path.join(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'), 'import-errors');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  async list(query: any = {}, user?: any) {
    const { skip, take } = paginate(query);
    const where: any = {};
    if (query.module) where.module = query.module;
    if (query.status) where.status = query.status;
    if (user && !user.isSuperAdmin) where.userId = user.userId;
    const [list, total] = await Promise.all([
      this.prisma.importTask.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
      this.prisma.importTask.count({ where }),
    ]);
    return buildResult(list, total, query);
  }

  async findOne(id: string) {
    const t = await this.prisma.importTask.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('导入任务不存在');
    return t;
  }

  /** 提交导入任务：小批量同步返回，大批量异步执行 */
  async submit<T>(
    ctx: SubmitContext,
    rows: any[],
    opts: RunOptions<T>,
  ): Promise<ImportOutcome & { taskId?: string; async?: boolean }> {
    if (!Array.isArray(rows)) throw new BadRequestException('导入内容为空');
    if (rows.length <= ASYNC_IMPORT_THRESHOLD) return this.runner.run(rows, opts);

    const task = await this.prisma.importTask.create({
      data: {
        module: ctx.module,
        moduleName: ctx.moduleName,
        fileName: ctx.fileName,
        totalRows: rows.length,
        status: 'PENDING',
        projectId: ctx.projectId,
        userId: ctx.userId,
        username: ctx.username,
      },
    });

    // 后台执行：不阻塞请求
    void this.execute(task.id, rows, opts, ctx).catch(() => undefined);
    return { total: rows.length, created: 0, updated: 0, errors: [], taskId: task.id, async: true };
  }

  /** 后台执行导入并更新任务状态 */
  private async execute<T>(taskId: string, rows: any[], opts: RunOptions<T>, ctx: SubmitContext) {
    await this.prisma.importTask.update({ where: { id: taskId }, data: { status: 'RUNNING', startedAt: new Date() } });
    let outcome: ImportOutcome;
    try {
      outcome = await this.runner.run(rows, {
        ...opts,
        onProgress: async (processed: number) => {
          // 进度更新失败不阻断导入
          await this.prisma.importTask
            .update({ where: { id: taskId }, data: { processedRows: processed } })
            .catch(() => undefined);
        },
      });
    } catch (e: any) {
      await this.prisma.importTask.update({
        where: { id: taskId },
        data: { status: 'FAILED', message: e?.message || String(e), finishedAt: new Date() },
      });
      await this.notify(ctx, 'FAILED', 0, rows.length, taskId);
      return;
    }

    let errorFileUrl: string | null = null;
    if (outcome.errors.length) {
      errorFileUrl = await this.writeErrorReport(taskId, outcome.errors);
    }
    await this.prisma.importTask.update({
      where: { id: taskId },
      data: {
        status: outcome.errors.length ? 'FAILED' : 'SUCCESS',
        processedRows: rows.length,
        successCount: outcome.created + outcome.updated,
        failCount: outcome.errors.length,
        errorFileUrl,
        message: outcome.errors.length ? `${outcome.errors.length} 行校验失败，已全部回滚` : null,
        finishedAt: new Date(),
      },
    });
    await this.notify(ctx, outcome.errors.length ? 'FAILED' : 'SUCCESS', outcome.created + outcome.updated, outcome.errors.length, taskId);
  }

  private async notify(ctx: SubmitContext, status: string, success: number, fail: number, taskId: string) {
    try {
      await this.notifier.send({
        userId: ctx.userId,
        title: `【${ctx.moduleName}】导入${status === 'SUCCESS' ? '完成' : '失败'}`,
        content:
          status === 'SUCCESS'
            ? `文件「${ctx.fileName || '-'}」导入完成，成功写入 ${success} 行。`
            : `文件「${ctx.fileName || '-'}」导入未完成，${fail} 行校验失败，已全部回滚，未写入任何数据。可下载错误报告核对。`,
        type: status === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
        projectId: ctx.projectId,
        bizType: 'import-task',
        bizId: taskId,
      });
    } catch {
      /* 通知失败不阻断 */
    }
  }

  /** 生成错误报告 Excel（行号 + 错误字段 + 错误描述），返回相对下载地址 */
  private async writeErrorReport(taskId: string, errors: ImportRowError[]): Promise<string> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('错误明细');
    ws.columns = [
      { header: '行号', key: 'row', width: 10 },
      { header: '错误字段', key: 'field', width: 24 },
      { header: '错误描述', key: 'message', width: 70 },
    ];
    errors.forEach((e) => ws.addRow({ row: e.row, field: e.field || '', message: e.message }));
    ws.getRow(1).font = { bold: true };
    const file = path.join(this.errorDir(), `import-errors-${taskId}.xlsx`);
    await wb.xlsx.writeFile(file);
    return `/api/files/import-errors/import-errors-${taskId}.xlsx`;
  }
}

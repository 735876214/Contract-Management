import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { from, Observable, switchMap, tap, catchError, throwError } from 'rxjs';
import { LogService } from '../services/log.service';

/**
 * 全局操作日志拦截器（需求 2.6）
 *
 * - 记录所有写操作（POST / PUT / PATCH / DELETE）：操作人、时间、IP、模块、动作、前后数据、结果、耗时
 * - 对更新/删除请求，先读取变更前快照（beforeData），响应后记录变更后数据（afterData）
 * - 记录导入专项统计：文件名、总行数、成功/失败行数、错误报告地址
 * - 日志写入失败绝不阻断业务
 */

/** 路由段 → { Prisma 模型名, 模块中文名 } */
const ROUTE_MAP: Record<string, { model?: string; module: string }> = {
  projects: { model: 'project', module: '项目信息' },
  suppliers: { model: 'supplier', module: '供应商库' },
  contracts: { model: 'contract', module: '合同台账' },
  'contract-materials': { model: 'contractMaterial', module: '合同物资清单' },
  materials: { model: 'materialBase', module: '物资基础库' },
  'daily-reports': { model: 'dailyReport', module: '物资日报' },
  settlements: { model: 'settlement', module: '结算单' },
  'settlement-ledgers': { model: 'settlementLedger', module: '结算台账' },
  payments: { model: 'paymentRecord', module: '付款台账' },
  invoices: { model: 'invoice', module: '发票台账' },
  ledger: { model: 'contract', module: '合同台账' },
  repayments: { model: 'repaymentAgreement', module: '还款协议' },
  assets: { model: 'assetLedger', module: '资产管理台账' },
  dict: { model: 'dictItem', module: '数据字典' },
  templates: { model: 'contractTemplate', module: '合同模板' },
  finance: { module: '资金费用' },
  system: { module: '系统管理' },
  auth: { module: '认证授权' },
  files: { module: '文件管理' },
  notifications: { module: '消息中心' },
};

const ACTION_MAP: Record<string, string> = {
  POST: '新增',
  PUT: '修改',
  PATCH: '修改',
  DELETE: '删除',
};

function safeJson(v: any, limit = 4000): string | null {
  if (v === undefined || v === null) return null;
  try {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > limit ? `${s.slice(0, limit)}…（已截断）` : s;
  } catch {
    return null;
  }
}

/** 去掉二进制/大字段，避免日志膨胀 */
function slimParams(body: any): any {
  if (!body || typeof body !== 'object') return body;
  const clone: any = { ...body };
  ['password', 'oldPassword', 'newPassword'].forEach((k) => {
    if (k in clone) clone[k] = '******';
  });
  return clone;
}

@Injectable()
export class OperationLogInterceptor implements NestInterceptor {
  constructor(private prisma: PrismaClient, private log: LogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req: any = context.switchToHttp().getRequest();
    const method: string = req.method;
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next.handle();

    const started = Date.now();
    const url: string = req.originalUrl || req.url || '';
    const segs = url.split('?')[0].split('/').filter(Boolean);
    const apiIdx = segs.indexOf('api');
    const biz = segs[apiIdx + 1] || '';
    const route = ROUTE_MAP[biz] || { module: biz || '未知模块' };

    const isImport = /import/i.test(url);
    let action = ACTION_MAP[method] || method;
    if (isImport) action = '导入';
    if (/export|download/i.test(url)) action = '导出';
    if (/toggle/i.test(url)) action = '启停';

    const user = req.user || {};
    const ip =
      (req.headers['x-forwarded-for'] as string) ||
      req.ip ||
      req.connection?.remoteAddress ||
      null;

    // 业务主键：URL 中的 id 段（PUT /xxx/:id、DELETE /xxx/:id）
    const idSeg = segs.length > apiIdx + 2 ? segs[segs.length - 1] : null;
    const bizId = idSeg && !/^(import|export|template|options|logs|params)$/.test(idSeg) ? idSeg : null;

    const snapshotModel = (this.prisma as any)[route.model || ''];
    let beforePromise: Promise<any> = Promise.resolve(null);
    if (snapshotModel?.findUnique && bizId && (method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
      beforePromise = snapshotModel
        .findUnique({ where: { id: bizId } })
        .then((row: any) => row)
        .catch(() => null);
    }

    return from(beforePromise).pipe(
      switchMap((before) =>
        next.handle().pipe(
          tap((res) => {
            const data = res && typeof res === 'object' && 'data' in res ? res.data : res;
            const duration = Date.now() - started;
            let importRows: number | undefined;
            let successCount: number | undefined;
            let failCount: number | undefined;
            if (isImport && data && typeof data === 'object') {
              importRows = Number(data.total ?? data.totalRows ?? NaN) || undefined;
              successCount = Number(data.created ?? 0) + Number(data.updated ?? 0);
              failCount = Array.isArray(data.errors) ? data.errors.length : 0;
            }
            void this.log.operation({
              userId: user.userId || user.sub || user.id,
              username: user.username || user.realName,
              module: route.module,
              action,
              method,
              url,
              params: safeJson(slimParams({ ...req.body, ...req.query })),
              ip,
              beforeData: safeJson(before),
              afterData: safeJson(data, 8000),
              result: 'SUCCESS',
              duration,
              bizType: route.model || biz,
              bizId: bizId || (data && data.id) || null,
              projectId: (req.headers['x-project-id'] as string) || null,
              importFile: isImport ? (req as any).file?.originalname || null : null,
              importRows,
              successCount,
              failCount,
            });
          }),
          catchError((err) => {
            void this.log.operation({
              userId: user.userId || user.sub || user.id,
              username: user.username || user.realName,
              module: route.module,
              action,
              method,
              url,
              params: safeJson(slimParams({ ...req.body, ...req.query })),
              ip,
              beforeData: safeJson(before),
              result: 'FAIL',
              message: err?.message || String(err),
              duration: Date.now() - started,
              bizType: route.model || biz,
              bizId,
              projectId: (req.headers['x-project-id'] as string) || null,
            });
            return throwError(() => err);
          }),
        ),
      ),
    );
  }
}

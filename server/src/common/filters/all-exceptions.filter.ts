import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { mapPrismaError, prismaErrorCode } from '../utils/prisma-error';
import { buildErrorEnvelope } from '../utils/error-envelope';
import { API_CODE } from '../error-codes';
import { requestContext } from '../services/request-context';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = '服务器内部错误';
    let code = 1500;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res: any = exception.getResponse();
      message = typeof res === 'string' ? res : res?.message || exception.message;
      if (Array.isArray(message)) message = message.join('; ');
      /**
       * 业务异常可以**显式带稳定 code**：`throw new BadRequestException({ code: 1412, message })`。
       * 前端按 code 做控制流（刷新项目并重放请求等），文案只用于展示——改造前前端在
       * `http.ts` 里 `msg.includes('项目不存在')`，后端改一个字自动恢复就静默失效。
       */
      const explicit = res && typeof res === 'object' ? Number((res as any).code) : NaN;
      code = Number.isFinite(explicit) && explicit !== 0
        ? explicit
        : status === 401
          ? API_CODE.UNAUTHORIZED
          : status === 403
            ? API_CODE.FORBIDDEN
            : status === 400
              ? API_CODE.BAD_REQUEST
              : status;
    } else {
      /**
       * 非 HttpException（第 21 轮审计）：原来把 `exception.message` 原样回给前端。
       * Prisma 的报错带**表名/列名/约束名/SQL 片段**，等于把库结构发给任何能触发写入的用户；
       * 而 P2002/P2003/P2025 这类**可预期的写冲突**又全被当成 500「服务器内部错误」，
       * 用户不知道为什么失败、运维还得翻日志。已知冲突映射成 4xx + 人话，其余保持 500 统一文案，
       * 原始 message/stack 只进服务端日志（见 `common/utils/prisma-error.ts`）。
       */
      const mapped = mapPrismaError(exception);
      if (mapped) {
        status = mapped.status;
        code = mapped.code;
        message = mapped.message;
      }
    }

    const detail = exception?.stack || exception?.message || String(exception);
    if (status >= 500) {
      this.logger.error(`${request.method} ${request.url} -> ${detail}`);
    } else if (prismaErrorCode(exception)) {
      // 4xx 的写冲突不刷 error 级别，但要留痕：定位「谁在并发写同一行」全靠这条
      this.logger.warn(`${request.method} ${request.url} -> ${detail.split('\n')[0]}`);
    }

    // 统一信封（2026-11-21 审计 P0-2）：错误分支与成功分支同形（含 timestamp），
    // 否则按文档接入的 mcp/ 外部调用方拿不到 timestamp。HTTP 状态码保持原样。
    response.status(status).json(buildErrorEnvelope({ code, message, requestId: requestContext.requestId }));
  }
}

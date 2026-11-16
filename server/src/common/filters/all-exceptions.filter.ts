import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { mapPrismaError, prismaErrorCode } from '../utils/prisma-error';

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
      code = status === 401 ? 1401 : status === 403 ? 1403 : status === 400 ? 1001 : status;
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

    response.status(status).json({
      code,
      data: null,
      message,
    });
  }
}

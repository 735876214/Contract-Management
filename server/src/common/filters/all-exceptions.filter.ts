import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

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
    } else if (exception?.message) {
      message = exception.message;
    }

    if (status >= 500) this.logger.error(`${request.method} ${request.url} -> ${exception?.stack || message}`);

    response.status(status).json({
      code,
      data: null,
      message,
    });
  }
}

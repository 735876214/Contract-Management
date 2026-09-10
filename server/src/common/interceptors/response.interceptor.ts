import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface ApiResult<T> {
  code: number;
  data: T;
  message: string;
}

/**
 * 统一响应包装：{ code, data, message }
 *
 * 例外：部分接口需要直接返回原始内容（如授权委托书 HTML —— 前端要拿它
 * 直接 document.write 后打印）。这类请求由前端带 `x-raw-response: 1`，
 * 通过 shouldSkip 判定后原样返回，避免被 JSON 包装破坏。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResult<T> | T> {
  constructor(private readonly shouldSkip?: (ctx: ExecutionContext) => boolean) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResult<T> | T> {
    return next.handle().pipe(
      map((raw) => {
        if (this.shouldSkip?.(context)) return raw;
        // 已经是标准结构则直接返回
        if (raw && typeof raw === 'object' && 'code' in raw && 'data' in raw && 'message' in raw) {
          return { ...raw, timestamp: Date.now() };
        }
        return { code: 0, data: raw ?? null, message: 'ok', timestamp: Date.now() };
      }),
    );
  }
}

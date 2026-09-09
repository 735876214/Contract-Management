import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

export interface ApiResult<T> {
  code: number;
  data: T;
  message: string;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResult<T>> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResult<T>> {
    return next.handle().pipe(
      map((raw) => {
        // 已经是标准结构则直接返回
        if (raw && typeof raw === 'object' && 'code' in raw && 'data' in raw && 'message' in raw) {
          return { ...raw, timestamp: Date.now() };
        }
        return { code: 0, data: raw ?? null, message: 'ok', timestamp: Date.now() };
      }),
    );
  }
}

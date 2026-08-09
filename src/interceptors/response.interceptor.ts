import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { RAW_RESPONSE } from 'src/decorators/raw-response.decorator';

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T> | T
> {
  // setup.ts 里是手动 new（无 DI），Reflector 无依赖可直接实例化。
  private readonly reflector = new Reflector();

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T> | T> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) {
      // @RawResponse：响应结构由外部协议钉死（如 OpenIM webhook），不包信封。
      return next.handle();
    }
    return next
      .handle()
      .pipe(map((data) => ({ code: 0, message: 'ok', data: data ?? null })));
  }
}

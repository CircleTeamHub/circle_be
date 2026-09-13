import { of } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

const contextFor = (handler: (...args: unknown[]) => unknown) =>
  ({
    getHandler: () => handler,
    getClass: () => class Dummy {},
  }) as any;

describe('ResponseInterceptor', () => {
  const interceptor = new ResponseInterceptor();

  it('默认包 {code,message,data} 信封', async () => {
    const handler = () => undefined;
    const result = await firstValueFrom(
      interceptor.intercept(contextFor(handler), {
        handle: () => of({ hello: 1 }),
      } as any),
    );
    expect(result).toEqual({ code: 0, message: 'ok', data: { hello: 1 } });
  });

  // @RawResponse 是 OpenIM webhook 时代的逃生口(OpenIM 只认顶层 actionCode),
  // 自研 IM 之后全仓 0 处使用。删掉之后,残留的 rawResponse 元数据也不能再让
  // 任何路由绕开统一的 {code,message,data} 信封。
  it('ignores legacy rawResponse metadata and still wraps the envelope', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata('rawResponse', true, handler);
    const payload = { actionCode: 0, errCode: 0, nextCode: 0 };
    const result = await firstValueFrom(
      interceptor.intercept(contextFor(handler), {
        handle: () => of(payload),
      } as any),
    );
    expect(result).toEqual({ code: 0, message: 'ok', data: payload });
  });
});

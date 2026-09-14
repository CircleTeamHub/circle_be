import { of } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';
import { RAW_RESPONSE } from 'src/decorators/raw-response.decorator';

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

  it('@RawResponse 路由原样透传（OpenIM 回调等外部协议端点）', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata(RAW_RESPONSE, true, handler);
    const payload = { actionCode: 0, errCode: 0, nextCode: 0 };
    const result = await firstValueFrom(
      interceptor.intercept(contextFor(handler), {
        handle: () => of(payload),
      } as any),
    );
    expect(result).toBe(payload);
  });
});

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IconController } from 'src/icon/icon.controller';
import { UserController } from 'src/user/user.controller';
import { UserThrottlerGuard } from '../user-throttler.guard';

/**
 * 高开销写接口必须有路由级限流，且要按账号计数。
 *
 * 只靠全局那道 300 次/分钟/IP 的兜底是不够的：
 * - 太松 —— 这些接口一次调用会触发广播、缓存失效、同步队列写入或全删重建。
 * - 键错了 —— 按 IP 计数会让运营商 NAT / 公司代理后的真实用户互相牵连，
 *   一个人打满，同出口的其他人一起 429。
 */
describe('heavy write endpoints are throttled per account', () => {
  const cases: [string, object, string][] = [
    ['PATCH /user/:id', UserController.prototype, 'updateUser'],
    ['PUT /icon/display', IconController.prototype, 'updateDisplay'],
  ];

  it.each(cases)('%s uses UserThrottlerGuard', (_name, proto, method) => {
    const handler = (proto as Record<string, unknown>)[method];
    const guards = (Reflect.getMetadata(GUARDS_METADATA, handler as object) ??
      []) as unknown[];

    expect(guards).toContain(UserThrottlerGuard);
  });

  it.each(cases)('%s declares a finite limit', (_name, proto, method) => {
    const handler = (proto as Record<string, unknown>)[method] as object;
    // 元数据键用字面量，与仓库里其它 controller spec 的写法一致
    //（这个 throttler 版本不导出 THROTTLER_LIMIT / THROTTLER_TTL 常量）。
    const limit = Number(
      Reflect.getMetadata('THROTTLER:LIMITdefault', handler),
    );
    const ttl = Number(Reflect.getMetadata('THROTTLER:TTLdefault', handler));

    expect(limit).toBeGreaterThan(0);
    // 上限要足够低才有意义 —— 高于全局兜底的 300/min 等于没加。
    expect(limit).toBeLessThanOrEqual(60);
    expect(ttl).toBeGreaterThan(0);
  });
});

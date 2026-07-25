import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * 按已认证用户（而非 IP）限流的 ThrottlerGuard。
 *
 * stock ThrottlerGuard 按请求 IP 计数：同一运营商 NAT / 公司代理后的所有用户会**共享**
 * 同一份额度，一小波重连就能让无辜用户收到 429。这里改按 `req.user.userId` 计数，让每个
 * 已认证用户拥有独立额度；拿不到用户（未认证）时回落到 stock 的 IP 追踪。
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const userId = (req.user as { userId?: unknown } | undefined)?.userId;
    if (typeof userId === 'string' && userId.length > 0) {
      return `user:${userId}`;
    }
    return super.getTracker(req);
  }
}

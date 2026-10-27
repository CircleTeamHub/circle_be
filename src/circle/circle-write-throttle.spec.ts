import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { CircleController } from './circle.controller';

// AppModule 没装全局 ThrottlerGuard。建圈(圈子 + 群聊 + 圈主席位,一个大事务)和申请入圈
// (圈子行锁 + 担保单 + 通知)是这个控制器里最贵的两个写,此前路由上没有任何限流。
// 按账号计数(UserThrottlerGuard),同一 NAT 后的用户不互相挤出 429。
describe('CircleController write throttling', () => {
  it.each([
    ['create', 5],
    ['join', 20],
  ] as const)(
    'budgets %s at %i per minute per authenticated user',
    (method, limit) => {
      const handler = CircleController.prototype[method];
      const guards = (Reflect.getMetadata(GUARDS_METADATA, handler) ??
        []) as unknown[];

      expect(guards).toContain(UserThrottlerGuard);
      expect(guards).not.toContain(ThrottlerGuard);
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(
        limit,
      );
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
    },
  );

  it('keeps JwtGuard at the class level so the per-user tracker sees req.user', () => {
    // 类级守卫先于方法级守卫执行:JwtGuard 先把 req.user 挂上,UserThrottlerGuard
    // 才能按账号而不是按 IP 计数。
    const classGuards = (Reflect.getMetadata(
      GUARDS_METADATA,
      CircleController,
    ) ?? []) as Array<{ name: string }>;
    expect(classGuards.map((guard) => guard.name)).toEqual(['JwtGuard']);
  });
});

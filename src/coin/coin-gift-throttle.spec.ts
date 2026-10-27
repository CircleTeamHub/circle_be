import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { CoinController } from './coin.controller';

// AppModule 没装全局 ThrottlerGuard。送金币一次就是一个 Serializable 事务(双方钱包行锁
// + 流水 + 礼物卡片 outbox),此前路由上没有任何限流,一个脚本循环换幂等键就能把钱包行
// 锁成热点。按账号计数(UserThrottlerGuard),同一 NAT 后的用户不互相挤出 429。
describe('CoinController gift throttling', () => {
  it('budgets POST /coin/gift at 30 per minute per authenticated user', () => {
    const sendGift = CoinController.prototype.sendGift;
    const guards = (Reflect.getMetadata(GUARDS_METADATA, sendGift) ??
      []) as unknown[];

    expect(guards).toContain(UserThrottlerGuard);
    expect(guards).not.toContain(ThrottlerGuard);
    // @Throttle 按命名空间展开成独立的 key,不是一个对象。
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', sendGift)).toBe(30);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', sendGift)).toBe(60_000);
  });

  it('keeps the read endpoints unthrottled at the route level', () => {
    for (const read of [
      CoinController.prototype.getWallet,
      CoinController.prototype.getTransactions,
    ]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, read)).toBeUndefined();
    }
  });
});

import { Global, Module } from '@nestjs/common';
import { IdempotencyService } from './idempotency.service';

// 全局：接入的创建接口散在各业务模块里，不必每个模块都 import 一遍。
// RedisService 来自同为 @Global 的 RedisModule。
@Global()
@Module({
  providers: [IdempotencyService],
  exports: [IdempotencyService],
})
export class IdempotencyModule {}

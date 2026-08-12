import { Module } from '@nestjs/common';
import { OutboxDepthService } from './outbox-depth.service';

/**
 * 承载需要 DI 的指标采集器。RED 中间件、业务/聊天/基建指标都是模块级单例，
 * 不经过 Nest 容器；只有需要注入 PrismaService 的 outbox 深度探针在这里。
 *
 * PrismaModule 是 @Global，所以这里不需要显式 imports。
 */
@Module({
  providers: [OutboxDepthService],
  exports: [OutboxDepthService],
})
export class MetricsModule {}

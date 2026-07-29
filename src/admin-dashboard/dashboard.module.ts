import { Module } from '@nestjs/common';
import { OutboxModule } from 'src/outbox/outbox.module';
import { OpenimModule } from 'src/openim/openim.module';
import { DashboardController } from './dashboard.controller';
import {
  DashboardCommerceMetrics,
  DashboardCommunityMetrics,
  DashboardModerationMetrics,
  DashboardSystemMetrics,
  DashboardUserMetrics,
} from './dashboard-metrics.service';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [OutboxModule, OpenimModule],
  controllers: [DashboardController],
  providers: [
    DashboardService,
    DashboardUserMetrics,
    DashboardCommunityMetrics,
    DashboardCommerceMetrics,
    DashboardModerationMetrics,
    DashboardSystemMetrics,
  ],
})
export class DashboardModule {}

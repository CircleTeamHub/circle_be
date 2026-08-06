import { Module } from '@nestjs/common';
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

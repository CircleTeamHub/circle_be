import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';
import { DashboardRange } from './dashboard.dto';
import {
  DashboardCommerceMetrics,
  DashboardCommunityMetrics,
  DashboardModerationMetrics,
  DashboardSystemMetrics,
  DashboardUserMetrics,
} from './dashboard-metrics.service';
import { resolveDashboardPeriod } from './dashboard-period';

type SectionResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'error'; data: null };

type DashboardResponse = {
  range: DashboardRange;
  timezone?: string;
  generatedAt: string;
  startAt: string;
  endAt: string;
  sections: {
    users: SectionResult<unknown>;
    community: SectionResult<unknown>;
    commerce: SectionResult<unknown>;
    moderation: SectionResult<unknown>;
    system: SectionResult<unknown>;
  };
};

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly users: DashboardUserMetrics,
    private readonly community: DashboardCommunityMetrics,
    private readonly commerce: DashboardCommerceMetrics,
    private readonly moderation: DashboardModerationMetrics,
    private readonly system: DashboardSystemMetrics,
    private readonly redis: RedisService,
  ) {}

  async getDashboard(
    range: DashboardRange,
    now = new Date(),
  ): Promise<DashboardResponse> {
    const cacheKey = `admin:dashboard:${range}`;
    const cached = await this.redis.getJson<DashboardResponse>(cacheKey);
    if (cached) return cached;

    const period = resolveDashboardPeriod(range, now);
    const results = await Promise.allSettled([
      this.users.getMetrics(period),
      this.community.getMetrics(period),
      this.commerce.getMetrics(period),
      this.moderation.getMetrics(period),
      this.system.getMetrics(),
    ]);
    const sectionNames = [
      'users',
      'community',
      'commerce',
      'moderation',
      'system',
    ] as const;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Dashboard ${sectionNames[index]} metrics failed: ${this.errorMessage(result.reason)}`,
        );
      }
    });

    const response = {
      range,
      timezone: 'Asia/Shanghai',
      generatedAt: now.toISOString(),
      startAt: period.startAt.toISOString(),
      endAt: period.endAt.toISOString(),
      sections: {
        users: this.section(results[0]),
        community: this.section(results[1]),
        commerce: this.section(results[2]),
        moderation: this.section(results[3]),
        system: this.section(results[4]),
      },
    };
    if (results.every((result) => result.status === 'fulfilled')) {
      await this.redis.setJson(cacheKey, response, 45);
    }
    return response;
  }

  private section<T>(result: PromiseSettledResult<T>): SectionResult<T> {
    return result.status === 'fulfilled'
      ? { status: 'ok', data: result.value }
      : { status: 'error', data: null };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

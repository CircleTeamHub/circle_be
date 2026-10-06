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

const DASHBOARD_CACHE_TTL_SECONDS = 45;
const DASHBOARD_CACHE_TTL_MS = DASHBOARD_CACHE_TTL_SECONDS * 1000;

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);
  /** Redis is the shared cache; this tiny local cache keeps an outage from
   * turning every dashboard request into five parallel count queries. */
  private readonly memoryCache = new Map<
    string,
    { expiresAt: number; value: DashboardResponse }
  >();
  private readonly inFlight = new Map<string, Promise<DashboardResponse>>();

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
    let cached: DashboardResponse | null = null;
    try {
      cached = await this.redis.getJson<DashboardResponse>(cacheKey);
    } catch (error) {
      this.logger.warn(
        `Dashboard cache read failed: ${this.errorMessage(error)}`,
      );
    }
    if (cached && this.remember(cacheKey, cached)) {
      return cached;
    }

    const local = this.memoryCache.get(cacheKey);
    if (local && local.expiresAt > Date.now()) return local.value;
    if (local) this.memoryCache.delete(cacheKey);

    const running = this.inFlight.get(cacheKey);
    if (running) return running;

    const refresh = this.refreshDashboard(range, now, cacheKey);
    this.inFlight.set(cacheKey, refresh);
    try {
      return await refresh;
    } finally {
      if (this.inFlight.get(cacheKey) === refresh) {
        this.inFlight.delete(cacheKey);
      }
    }
  }

  private async refreshDashboard(
    range: DashboardRange,
    now: Date,
    cacheKey: string,
  ): Promise<DashboardResponse> {
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
    if (
      results.every((result) => result.status === 'fulfilled') &&
      this.remember(cacheKey, response)
    ) {
      try {
        await this.redis.setJson(
          cacheKey,
          response,
          Math.ceil(
            (Date.parse(response.generatedAt) +
              DASHBOARD_CACHE_TTL_MS -
              Date.now()) /
              1000,
          ),
        );
      } catch (error) {
        this.logger.warn(
          `Dashboard cache write failed: ${this.errorMessage(error)}`,
        );
      }
    }
    return response;
  }

  private remember(cacheKey: string, value: DashboardResponse): boolean {
    const generatedAt = Date.parse(value.generatedAt);
    const expiresAt = generatedAt + DASHBOARD_CACHE_TTL_MS;
    if (
      !Number.isFinite(generatedAt) ||
      generatedAt > Date.now() ||
      expiresAt <= Date.now()
    )
      return false;
    this.memoryCache.set(cacheKey, {
      value,
      expiresAt,
    });
    return true;
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

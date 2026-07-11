import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { AllExceptionFilter } from './filters/all-exception.filter';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { ErrorLoggingInterceptor } from './interceptors/error-logging.interceptor';
import helmet from 'helmet';
import rateLimit, {
  type Options as RateLimitOptions,
} from 'express-rate-limit';
import { RedisService } from './redis/redis.service';
import { getServerConfig } from './config/server.config';
import { createLoggingConfig } from './logging/logging.config';
import { createRequestLoggerMiddleware } from './logging/request-logger.middleware';
import { createRateLimitHandler } from './logging/rate-limit-logger';
import {
  createErrorAggregationConfig,
  createErrorAggregationProvider,
  type ErrorAggregationProvider,
} from './logging/error-aggregation.service';
import { Registry } from 'prom-client';
import { createMetrics } from './metrics/metrics.service';
import { createHttpMetricsMiddleware } from './metrics/http-metrics.middleware';
import { createMetricsHandler } from './metrics/metrics.endpoint';
import { businessMetrics } from './metrics/business-metrics';
import { redisMetrics } from './redis/redis.metrics';
import { uploadMetrics } from './metrics/upload-metrics';

/** Strict limit for sensitive auth endpoints: 10 requests / 15 min per IP. */
const authLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Moderate limit for token refresh: 60 requests / 15 min per IP. */
const refreshLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
} satisfies Partial<RateLimitOptions>;

/**
 * Email verification-code requests: 10 sends / 15 min per IP. The service also
 * enforces a 60s per-email cooldown, but that does not stop one IP from
 * fanning out across many addresses (mail-bombing / cost abuse), so cap per IP.
 */
const emailCodeLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many code requests, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/**
 * Login security-code verification: 10 attempts / 15 min per IP. The security
 * code is only 4-6 digits, so this per-IP limit complements the per-account
 * lockout in AuthService.verifyLoginSecurityCode (5 failures -> 15 min lock via
 * securityCodeAttempts / securityCodeLockedUntil) — together they stop both
 * single-IP and distributed / IP-rotating brute force.
 */
const securityCodeVerifyLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Friend request spam protection: 30 attempts / 15 min per IP. */
const friendRequestLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many friend requests, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Coin gift abuse protection: 20 attempts / 15 min per IP. */
const coinGiftLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many gift attempts, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Note write abuse protection: 60 creates/updates per 15 min per IP. */
const noteWriteLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many note operations, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Friend report spam protection: 10 reports per hour per IP. */
const friendReportLimiterOptions = {
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many reports submitted, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Circle writes: 40 mutating requests / 15 min per IP. */
const circleWriteLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many circle operations, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Trace writes: 120 mutating requests / 15 min per IP. */
const traceWriteLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many moment operations, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Trace detail reads: 600 detail lookups / 15 min per IP. */
const traceDetailReadLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many moment lookups, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Conversation-group writes: 60 mutating requests / 15 min per IP. */
const conversationGroupWriteLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many conversation group operations, please try again later.',
  },
} satisfies Partial<RateLimitOptions>;

/** Group membership writes: 60 mutating requests / 15 min per IP. */
const groupWriteLimiterOptions = {
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many group operations, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/** Group report spam protection: 10 reports per hour per IP. */
const groupReportLimiterOptions = {
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many reports submitted, please try again later.' },
} satisfies Partial<RateLimitOptions>;

/**
 * Account lookup limiter. Without this, any authenticated user can probe the
 * /user/search/account endpoint to enumerate accountIds at the global 300/min
 * fallback rate.
 */
export const setupApp = (app: INestApplication): ErrorAggregationProvider => {
  const isProduction = process.env.NODE_ENV === 'production';
  const config = getServerConfig();
  const loggingConfig = createLoggingConfig(
    config,
    String(config['NODE_ENV'] || process.env.NODE_ENV || 'development'),
  );

  const logger = loggingConfig.logOn
    ? app.get(WINSTON_MODULE_NEST_PROVIDER)
    : undefined;
  logger && app.useLogger(logger);
  app.setGlobalPrefix('api/v1');
  if (isProduction) {
    const express = app.getHttpAdapter?.().getInstance?.();
    express?.set?.('trust proxy', 1);
  }
  const redisService = getOptionalRedisService(app);
  const createLimiter = (
    limiterName: string,
    options: Partial<RateLimitOptions>,
  ) => {
    const store = redisService?.createRateLimitStore(limiterName);
    return rateLimit({
      ...options,
      // The Redis store is wrapped in FallbackRateLimitStore, which degrades to
      // per-instance in-memory limiting on a Redis outage rather than throwing.
      // So we do NOT pass on store errors — limiting must never silently fail
      // open (brute-force / account-enumeration protection lives here).
      ...(store ? { store, passOnStoreError: false } : {}),
      ...(logger
        ? {
            handler: createRateLimitHandler(logger, {
              enabled: loggingConfig.rateLimitLogOn,
              securityLogOn: loggingConfig.securityLogOn,
              limiterName,
              message: options.message,
            }) as RateLimitOptions['handler'],
          }
        : {}),
    } satisfies Partial<RateLimitOptions>);
  };
  const authLimiter = createLimiter('auth_login', authLimiterOptions);
  const authRegisterLimiter = createLimiter(
    'auth_register',
    authLimiterOptions,
  );
  const authChangePasswordLimiter = createLimiter(
    'auth_change_password',
    authLimiterOptions,
  );
  const authChangeAccountIdLimiter = createLimiter(
    'auth_change_account_id',
    authLimiterOptions,
  );
  const refreshLimiter = createLimiter('auth_refresh', refreshLimiterOptions);
  const emailCodeLimiter = createLimiter(
    'auth_email_code',
    emailCodeLimiterOptions,
  );
  const securityCodeVerifyLimiter = createLimiter(
    'auth_security_code_verify',
    securityCodeVerifyLimiterOptions,
  );
  const friendRequestLimiter = createLimiter(
    'friend_requests',
    friendRequestLimiterOptions,
  );
  const coinGiftLimiter = createLimiter('coin_gift', coinGiftLimiterOptions);
  const noteWriteLimiter = createLimiter('note_write', noteWriteLimiterOptions);
  const circleWriteLimiter = createLimiter(
    'circle_write',
    circleWriteLimiterOptions,
  );
  const circleInvitationWriteLimiter = createLimiter(
    'circle_invitation_write',
    circleWriteLimiterOptions,
  );
  const circlePlazaWriteLimiter = createLimiter(
    'circle_plaza_write',
    circleWriteLimiterOptions,
  );
  const traceWriteLimiter = createLimiter(
    'trace_write',
    traceWriteLimiterOptions,
  );
  const traceDetailReadLimiter = createLimiter(
    'trace_detail_read',
    traceDetailReadLimiterOptions,
  );
  const conversationGroupWriteLimiter = createLimiter(
    'conversation_group_write',
    conversationGroupWriteLimiterOptions,
  );
  const friendReportLimiter = createLimiter(
    'friend_report',
    friendReportLimiterOptions,
  );
  const groupWriteLimiter = createLimiter(
    'group_write',
    groupWriteLimiterOptions,
  );
  const groupReportLimiter = createLimiter(
    'group_report',
    groupReportLimiterOptions,
  );
  const accountSearchLimiter = createLimiter('account_search', {
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many account lookups, please try again later.' },
  });
  const logoutLimiter = createLimiter('auth_logout', {
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Prometheus metrics. The RED middleware times every request (added first so
  // it spans the whole request); `/metrics` serves the raw exposition format,
  // bypassing the `api/v1` prefix and the JSON response interceptor. Mounted
  // before the rate limiter below so scrapes are never throttled.
  const metrics = createMetrics();
  app.use(createHttpMetricsMiddleware(metrics));
  // Expose HTTP RED, business, and Redis resilience metrics together.
  // Gated by METRICS_AUTH_TOKEN when set; left open otherwise so internal-only
  // deployments keep working without extra config.
  const metricsAuthToken =
    String(
      config['METRICS_AUTH_TOKEN'] ?? process.env.METRICS_AUTH_TOKEN ?? '',
    ).trim() || undefined;
  if (isProduction && !metricsAuthToken) {
    new Logger('Metrics').warn(
      '/metrics is served without authentication (METRICS_AUTH_TOKEN unset). ' +
        'Restrict it at the network layer or set METRICS_AUTH_TOKEN — the ' +
        'exposition format reveals route inventory, business-event rates, and ' +
        'process stats.',
    );
  }
  app.use(
    '/metrics',
    createMetricsHandler(
      Registry.merge([
        metrics.registry,
        businessMetrics.registry,
        redisMetrics.registry,
        uploadMetrics.registry,
      ]),
      { authToken: metricsAuthToken },
    ),
  );

  if (logger && loggingConfig.httpLogOn) {
    app.use(
      createRequestLoggerMiddleware(logger, {
        enabled: true,
        slowRequestMs: loggingConfig.slowRequestMs,
      }),
    );
  }

  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(
    new AllExceptionFilter(new Logger('Exception'), httpAdapterHost),
    new PrismaExceptionFilter(),
  );
  // Optional error aggregation (Sentry). A no-op unless
  // LOG_AGGREGATION_PROVIDER=sentry and SENTRY_DSN are configured; building it
  // here also runs Sentry.init() once before requests are served.
  const errorAggregation = createErrorAggregationProvider(
    createErrorAggregationConfig(
      config,
      String(config['NODE_ENV'] || process.env.NODE_ENV || 'development'),
    ),
  );
  if (logger && loggingConfig.httpLogOn) {
    app.useGlobalInterceptors(
      new ErrorLoggingInterceptor(logger, errorAggregation),
    );
  }
  app.useGlobalInterceptors(new ResponseInterceptor());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      disableErrorMessages: isProduction,
    }),
  );

  app.use(helmet());

  // Global fallback rate limit: 300 req / min per IP
  app.use(
    createLimiter('global', {
      windowMs: 1 * 60 * 1000,
      max: 300,
    }),
  );

  // Tighter limits on sensitive auth routes
  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/auth/admin/login', authLimiter);
  app.use('/api/v1/auth/register', authRegisterLimiter);
  app.use('/api/v1/auth/change-password', authChangePasswordLimiter);
  app.use('/api/v1/auth/change-account-id', authChangeAccountIdLimiter);
  app.use('/api/v1/auth/refresh', refreshLimiter);
  app.use('/api/v1/auth/admin/refresh', refreshLimiter);
  app.use('/api/v1/auth/logout', logoutLimiter);
  // Email code sends and security-code verification are the two new
  // unauthenticated-cost / brute-force surfaces from this branch.
  app.use('/api/v1/auth/email/request-code', emailCodeLimiter);
  app.use('/api/v1/auth/security-code/verify', securityCodeVerifyLimiter);
  app.use('/api/v1/user/search/account', accountSearchLimiter);
  app.use('/api/v1/friend/requests', friendRequestLimiter);
  app.use('/api/v1/coin/gift', coinGiftLimiter);
  app.use('/api/v1/note', noteWriteLimiter);
  app.use('/api/v1/circle', (req: any, res: any, next: any) => {
    if (req.method === 'POST' || req.method === 'DELETE') {
      return circleWriteLimiter(req, res, next);
    }
    next();
  });
  app.use('/api/v1/circle-invitation', (req: any, res: any, next: any) => {
    if (req.method === 'POST') {
      return circleInvitationWriteLimiter(req, res, next);
    }
    next();
  });
  app.use('/api/v1/circle-plaza', (req: any, res: any, next: any) => {
    if (req.method === 'POST' || req.method === 'DELETE') {
      return circlePlazaWriteLimiter(req, res, next);
    }
    next();
  });
  app.use('/api/v1/trace', (req: any, res: any, next: any) => {
    if (req.method === 'POST' || req.method === 'DELETE') {
      return traceWriteLimiter(req, res, next);
    }
    next();
  });
  app.use('/api/v1/trace', (req: any, res: any, next: any) => {
    const isTraceDetailPath =
      /^\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        req.path,
      );
    if (req.method === 'GET' && isTraceDetailPath) {
      return traceDetailReadLimiter(req, res, next);
    }
    next();
  });
  app.use('/api/v1/conversation-groups', (req: any, res: any, next: any) => {
    if (req.method !== 'GET') {
      return conversationGroupWriteLimiter(req, res, next);
    }
    next();
  });
  app.use('/api/v1/group', (req: any, res: any, next: any) => {
    if (req.method === 'POST' && /^\/[^/]+\/report$/.test(req.path)) {
      return groupReportLimiter(req, res, next);
    }
    next();
  });
  app.use('/api/v1/group', (req: any, res: any, next: any) => {
    if (req.method === 'POST' || req.method === 'DELETE') {
      return groupWriteLimiter(req, res, next);
    }
    next();
  });
  // Tighter limit on the report path — dynamic segment prevents an exact prefix
  // match, so we use a middleware filter on the friend router.
  app.use('/api/v1/friend', (req: any, res: any, next: any) => {
    if (req.method === 'POST' && /^\/[^/]+\/report$/.test(req.path)) {
      return friendReportLimiter(req, res, next);
    }
    next();
  });

  // Hand the error-aggregation provider back so bootstrap can flush it on
  // shutdown (otherwise 5xx errors buffered just before SIGTERM are lost).
  return errorAggregation;
};

function getOptionalRedisService(app: INestApplication): RedisService | null {
  try {
    const redisService = app.get(RedisService, { strict: false });
    if (
      redisService &&
      typeof redisService.createRateLimitStore === 'function'
    ) {
      return redisService;
    }
    return null;
  } catch {
    return null;
  }
}

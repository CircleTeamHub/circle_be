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
import { getServerConfig } from './config/server.config';
import { createLoggingConfig } from './logging/logging.config';
import { createRequestLoggerMiddleware } from './logging/request-logger.middleware';
import { createRateLimitHandler } from './logging/rate-limit-logger';

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
 * code is only 4-6 digits and verifyLoginSecurityCode has no server-side
 * lockout, so without this an attacker holding a stolen access token could
 * brute-force a 4-digit code at the global rate. See the persistent-lockout
 * follow-up in the review's remaining recommendations.
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
const accountSearchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many account lookups, please try again later.' },
} satisfies Partial<RateLimitOptions>);

/** Logout — keep loose but bounded; matches refreshLimiter shape. */
const logoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
} satisfies Partial<RateLimitOptions>);

export const setupApp = (app: INestApplication) => {
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
  const createLimiter = (
    limiterName: string,
    options: Partial<RateLimitOptions>,
  ) =>
    rateLimit({
      ...options,
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
  const authLimiter = createLimiter('auth_login', authLimiterOptions);
  const authRegisterLimiter = createLimiter(
    'auth_register',
    authLimiterOptions,
  );
  const authChangePasswordLimiter = createLimiter(
    'auth_change_password',
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
  if (logger && loggingConfig.httpLogOn) {
    app.useGlobalInterceptors(new ErrorLoggingInterceptor(logger));
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
  app.use('/api/v1/auth/register', authRegisterLimiter);
  app.use('/api/v1/auth/change-password', authChangePasswordLimiter);
  app.use('/api/v1/auth/refresh', refreshLimiter);
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
};

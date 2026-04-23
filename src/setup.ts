import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { getServerConfig } from './config/server.config';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { ErrorLoggingInterceptor } from './interceptors/error-logging.interceptor';
import helmet from 'helmet';
import rateLimit, {
  type Options as RateLimitOptions,
} from 'express-rate-limit';
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

export const setupApp = (app: INestApplication) => {
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
              limiterName,
              message: options.message,
            }) as RateLimitOptions['handler'],
          }
        : {}),
    } satisfies Partial<RateLimitOptions>);
  const authLimiter = createLimiter('auth_login', authLimiterOptions);
  const authRegisterLimiter = createLimiter('auth_register', authLimiterOptions);
  const authChangePasswordLimiter = createLimiter(
    'auth_change_password',
    authLimiterOptions,
  );
  const refreshLimiter = createLimiter('auth_refresh', refreshLimiterOptions);
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
  const traceWriteLimiter = createLimiter('trace_write', traceWriteLimiterOptions);
  const friendReportLimiter = createLimiter(
    'friend_report',
    friendReportLimiterOptions,
  );

  if (logger && loggingConfig.httpLogOn) {
    app.use(
      createRequestLoggerMiddleware(logger, {
        enabled: true,
        slowRequestMs: loggingConfig.slowRequestMs,
      }),
    );
  }

  app.useGlobalFilters(new PrismaExceptionFilter());
  if (logger && loggingConfig.httpLogOn) {
    app.useGlobalInterceptors(new ErrorLoggingInterceptor(logger));
  }
  app.useGlobalInterceptors(new ResponseInterceptor());

  // const httpAdapter = app.get(HttpAdapterHost);
  // // 全局Filter只能有一个
  // const logger = new Logger();
  // app.useGlobalFilters(new HttpExceptionFilter(logger));
  // app.useGlobalFilters(new AllExceptionFilter(logger, httpAdapter));

  // 全局拦截器
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // app.useGlobalGuards()
  // 弊端 -> 无法使用DI -> 无法访问userService

  // app.useGlobalInterceptors(new SerializeInterceptor());

  // helmet头部安全
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
  // Tighter limit on the report path — dynamic segment prevents an exact prefix
  // match, so we use a middleware filter on the friend router.
  app.use('/api/v1/friend', (req: any, res: any, next: any) => {
    if (req.method === 'POST' && /^\/[^/]+\/report$/.test(req.path)) {
      return friendReportLimiter(req, res, next);
    }
    next();
  });
};

import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionFilter } from './filters/all-exception.filter';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import helmet from 'helmet';
import rateLimit, {
  type Options as RateLimitOptions,
} from 'express-rate-limit';

/** Strict limit for sensitive auth endpoints: 10 requests / 15 min per IP. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later.' },
} satisfies Partial<RateLimitOptions>);

/** Moderate limit for token refresh: 60 requests / 15 min per IP. */
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
} satisfies Partial<RateLimitOptions>);

/** Friend request spam protection: 30 attempts / 15 min per IP. */
const friendRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many friend requests, please try again later.' },
} satisfies Partial<RateLimitOptions>);

/** Coin gift abuse protection: 20 attempts / 15 min per IP. */
const coinGiftLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many gift attempts, please try again later.' },
} satisfies Partial<RateLimitOptions>);

/** Note write abuse protection: 60 creates/updates per 15 min per IP. */
const noteWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many note operations, please try again later.' },
} satisfies Partial<RateLimitOptions>);

/** Friend report spam protection: 10 reports per hour per IP. */
const friendReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many reports submitted, please try again later.' },
} satisfies Partial<RateLimitOptions>);

/** Circle writes: 40 mutating requests / 15 min per IP. */
const circleWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many circle operations, please try again later.' },
} satisfies Partial<RateLimitOptions>);

/** Trace writes: 120 mutating requests / 15 min per IP. */
const traceWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many moment operations, please try again later.' },
} satisfies Partial<RateLimitOptions>);

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

  app.setGlobalPrefix('api/v1');

  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(
    new AllExceptionFilter(new Logger('Exception'), httpAdapterHost),
    new PrismaExceptionFilter(),
  );
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
    rateLimit({
      windowMs: 1 * 60 * 1000,
      max: 300,
    }),
  );

  // Tighter limits on sensitive auth routes
  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/auth/register', authLimiter);
  app.use('/api/v1/auth/change-password', authLimiter);
  app.use('/api/v1/auth/refresh', refreshLimiter);
  app.use('/api/v1/auth/logout', logoutLimiter);
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
      return circleWriteLimiter(req, res, next);
    }
    next();
  });
  app.use('/api/v1/circle-plaza', (req: any, res: any, next: any) => {
    if (req.method === 'POST' || req.method === 'DELETE') {
      return circleWriteLimiter(req, res, next);
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

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { getServerConfig } from './config/server.config';
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

export const setupApp = (app: INestApplication) => {
  const config = getServerConfig();

  const flag: boolean = config['LOG_ON'] === 'true';
  // app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  flag && app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  app.setGlobalPrefix('api/v1');

  app.useGlobalFilters(new PrismaExceptionFilter());
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
  app.use('/api/v1/friend/requests', friendRequestLimiter);
  app.use('/api/v1/coin/gift', coinGiftLimiter);
};

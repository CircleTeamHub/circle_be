//这个文件负责环境变量的验证，使用 Joi 库来定义和校验 .env 中的配置。

import * as Joi from 'joi';

type EnvLike = NodeJS.ProcessEnv | Record<string, unknown>;

function readBooleanEnvFlag(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

export function allowsStartWithoutDatabase(
  env: EnvLike = process.env,
): boolean {
  return readBooleanEnvFlag(env['ALLOW_START_WITHOUT_DB']);
}

export function shouldSkipPrismaConnectOnBoot(
  env: EnvLike = process.env,
): boolean {
  return readBooleanEnvFlag(env['PRISMA_SKIP_CONNECT_ON_BOOT']);
}

export function createEnvValidationSchema(
  env: EnvLike = process.env,
): Joi.ObjectSchema {
  const databaseUrlSchema = allowsStartWithoutDatabase(env)
    ? Joi.string().allow('').optional()
    : Joi.string().required();
  const redisUrlSchema = Joi.string().uri({ scheme: ['redis', 'rediss'] });
  const productionRedisUrlSchema = redisUrlSchema.custom((value, helpers) => {
    const url = new URL(value);
    const queryPasswords = url.searchParams.getAll('password');
    if (queryPasswords.length > 1 || (url.password && queryPasswords.length)) {
      return helpers.message({
        custom: 'REDIS_URL must use exactly one password source',
      });
    }
    const queryPassword = queryPasswords[0];
    if (!url.password && !queryPassword) {
      return helpers.message({
        custom: 'REDIS_URL must include authentication credentials',
      });
    }
    const root = helpers.state.ancestors[0] as Record<string, unknown>;
    const allowInsecure =
      root['REDIS_ALLOW_INSECURE'] === true ||
      readBooleanEnvFlag(root['REDIS_ALLOW_INSECURE']);
    if (url.protocol !== 'rediss:' && !allowInsecure) {
      return helpers.message({
        custom: 'external production REDIS_URL must use rediss TLS',
      });
    }
    return value;
  });

  const isProduction = env['NODE_ENV'] === 'production';
  const secretMin = isProduction ? 32 : 8;

  return Joi.object({
    NODE_ENV: Joi.string()
      .valid('development', 'production', 'test')
      .default('development'),
    DATABASE_URL: databaseUrlSchema,
    // pg connection pool. Defaults match pg's own (max 10), except the acquire
    // timeout — pg waits forever for a free slot by default, so a saturated
    // pool hangs requests instead of surfacing an error.
    DATABASE_POOL_MAX: Joi.number().integer().min(1).default(10),
    DATABASE_POOL_ACQUIRE_TIMEOUT_MS: Joi.number()
      .integer()
      .min(1)
      .default(10000),
    SECRET: Joi.string().min(secretMin).required(),
    JWT_EXPIRES_IN: Joi.string().default('1h'),
    REFRESH_EXPIRES_IN: Joi.string().default('30d'),
    LOG_ON: Joi.boolean(),
    LOG_LEVEL: Joi.string(),
    HTTP_LOG_ON: Joi.boolean(),
    SLOW_REQUEST_MS: Joi.number().integer().min(1).default(1000),
    BUSINESS_LOG_ON: Joi.boolean(),
    EXTERNAL_LOG_ON: Joi.boolean(),
    RATE_LIMIT_LOG_ON: Joi.boolean(),
    // Error aggregation (optional). Disabled unless provider=sentry AND a dsn is
    // set; a missing dsn degrades to a no-op rather than failing boot.
    LOG_AGGREGATION_PROVIDER: Joi.string()
      .valid('none', 'sentry')
      .default('none'),
    SENTRY_DSN: Joi.string().uri().optional(),
    SENTRY_ENVIRONMENT: Joi.string().optional(),
    SENTRY_RELEASE: Joi.string().optional(),
    // When set, /metrics requires `Authorization: Bearer <token>`. Leave unset
    // only when the metrics port is reachable from a trusted network alone.
    METRICS_AUTH_TOKEN: Joi.string().optional(),
    REDIS_REQUIRED: Joi.boolean().default(false),
    REDIS_ALLOW_INSECURE: Joi.boolean().default(false),
    REDIS_URL: Joi.when('REDIS_REQUIRED', {
      is: true,
      then: Joi.when('NODE_ENV', {
        is: 'production',
        then: productionRedisUrlSchema.required(),
        otherwise: redisUrlSchema.required(),
      }),
      otherwise: Joi.when('NODE_ENV', {
        is: 'production',
        then: productionRedisUrlSchema.optional(),
        otherwise: redisUrlSchema.optional(),
      }),
    }),
    APP_PORT: Joi.number().integer().min(0).max(65535).default(3000),
    PRISMA_SKIP_CONNECT_ON_BOOT: Joi.boolean(),
    ALLOW_START_WITHOUT_DB: Joi.boolean(),
    OPENIM_API_URL: Joi.string().uri().optional(),
    // Posted to OpenIM's /auth/get_admin_token, so whoever holds it can mint an
    // admin token and act as any user — at least the blast radius of SECRET,
    // hence the same production floor. Gated on OPENIM_API_URL because leaving
    // the URL unset is the supported "IM disabled" state; setting the URL in
    // production and omitting the secret fails loudly rather than silently
    // dropping every IM feature (OpenimService treats an empty secret as off).
    OPENIM_ADMIN_SECRET: Joi.when('OPENIM_API_URL', {
      is: Joi.exist(),
      then: Joi.string().min(secretMin).required(),
      otherwise: Joi.string().optional(),
    }),
    LIVEKIT_URL: Joi.string().uri().optional(),
    LIVEKIT_API_KEY: Joi.string().optional(),
    LIVEKIT_API_SECRET: Joi.string().optional(),
    LIVEKIT_WEBHOOK_SECRET: Joi.string().optional(),
    LIVEKIT_TOKEN_TTL_SECONDS: Joi.number().integer().min(60).default(3600),
    CALL_RING_TIMEOUT_SECONDS: Joi.number().integer().min(5).default(45),
    CALL_MAX_PARTICIPANTS: Joi.number().integer().min(2).max(100).default(10),
    CALL_ALLOW_OFFLINE_INVITE: Joi.boolean().default(false),
    CALL_ENABLE_VIDEO: Joi.boolean().default(false),
    // 真实邮件投递（#82）。SMTP_HOST 未设 = 受支持的开发态（ConsoleMailer，
    // 验证码打日志）；设了 host 就必须配齐凭据 —— production 半配置要在启动期
    // 炸掉，而不是运行时静默不发信。465 → 隐式 TLS；587 → SMTP_SECURE=false
    // 走 STARTTLS（SmtpMailer 强制 requireTLS，明文投递不可配）。
    SMTP_HOST: Joi.string().hostname().optional(),
    SMTP_PORT: Joi.number().integer().min(1).max(65535).default(465),
    SMTP_SECURE: Joi.boolean().default(true),
    SMTP_USER: Joi.when('SMTP_HOST', {
      is: Joi.exist(),
      then: Joi.string().required(),
      otherwise: Joi.string().optional(),
    }),
    SMTP_PASS: Joi.when('SMTP_HOST', {
      is: Joi.exist(),
      then: Joi.string().required(),
      otherwise: Joi.string().optional(),
    }),
    MAIL_FROM: Joi.string().optional(),
    MINIO_ENDPOINT: Joi.string().uri().optional(),
    MINIO_ACCESS_KEY: Joi.string().optional(),
    MINIO_SECRET_KEY: Joi.string().optional(),
    MINIO_BUCKET: Joi.string().optional(),
    MINIO_PUBLIC_URL: Joi.string().uri().optional(),
    // Comma-separated list of allowed CORS origins. Required in production.
    ALLOWED_ORIGINS: Joi.when('NODE_ENV', {
      is: 'production',
      then: Joi.string().required(),
      otherwise: Joi.string().optional(),
    }),
    // Share-link JWT signing secret for temp chat. Required in production so a
    // misconfigured deploy fails fast at boot instead of at the first link request.
    TEMP_CHAT_LINK_SECRET: Joi.when('NODE_ENV', {
      is: 'production',
      then: Joi.string().min(32).required(),
      otherwise: Joi.string().min(8).optional(),
    }),
    NOTE_SHARE_WEB_BASE: Joi.string().uri().optional(),
  }).unknown(true);
}

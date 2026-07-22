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

// TTL 旋钮的可解析格式（与 refresh-token.service parseRefreshTtlMs / jwt 的
// ms 子集对齐）。放宽大小写与首尾空白由 trim 处理，这里只钉结构。
// review 修复（round 2）：必须为正 —— '0h' 这类值下游解析按无效回落默认，
// 运维显式配 0 却拿到 12h/1h 是静默放大，必须 fail boot。
const refreshTtlPattern = /^0*[1-9]\d*\s*[dhm]?$/i;
const jwtTtlPattern = /^0*[1-9]\d*\s*(ms|s|m|h|d)?$/i;
// review 修复（round 2）：admin refresh TTL 强制带单位 —— 裸数字按旧语义是
// 「天」，运维想写 12 小时漏了 h 会静默变 12 天，直接顶穿短会话窗口设计。
const adminRefreshTtlPattern = /^0*[1-9]\d*\s*[dhm]$/i;

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
    // #84：这个键从 schema 声明之日起就没被代码读过（代码读的是从未文档化的
    // REFRESH_EXPIRES_IN_DAYS），所有环境实际拿 7 天。现已接线。
    // review 修复 ×2：
    // - 不在 Joi 层给默认：ConfigModule 会先落默认再进服务，只配了旧
    //   REFRESH_EXPIRES_IN_DAYS 的环境会被 '7d' 顶掉、兼容回落成死代码。
    //   默认由 RefreshTokenService 在两个键都缺席时兜（同为 7d，行为不变）。
    // - pattern 钉死可解析格式：这是安全敏感的会话寿命旋钮，'8hours' 这类
    //   写错的值静默回落默认可能比运维显式配置的更长，必须 fail boot。
    REFRESH_EXPIRES_IN: Joi.string().pattern(refreshTtlPattern, {
      name: 'duration like 30d / 12h / 45m',
    }),
    // 旧名（纯天数）仅作兼容回落，同样 fail-boot 校验。
    REFRESH_EXPIRES_IN_DAYS: Joi.alternatives(
      Joi.number().positive(),
      Joi.string().pattern(/^0*[1-9]\d*\s*d?$/i, {
        name: 'positive day count like 14 / 14d',
      }),
    ),
    // #91：管理台会话独立 TTL（上限被 REFRESH_EXPIRES_IN 钳制，绝不长于用户）。
    ADMIN_REFRESH_EXPIRES_IN: Joi.string()
      .pattern(adminRefreshTtlPattern, {
        name: 'duration with an explicit unit, like 12h / 45m',
      })
      .default('12h'),
    ADMIN_JWT_EXPIRES_IN: Joi.string()
      .pattern(jwtTtlPattern, { name: 'duration like 15m / 900s' })
      .default('15m'),
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

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

  const isProduction = env['NODE_ENV'] === 'production';
  const secretMin = isProduction ? 32 : 8;

  return Joi.object({
    NODE_ENV: Joi.string()
      .valid('development', 'production', 'test')
      .default('development'),
    DATABASE_URL: databaseUrlSchema,
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
    APP_PORT: Joi.number().integer().min(0).max(65535).default(3000),
    PRISMA_SKIP_CONNECT_ON_BOOT: Joi.boolean(),
    ALLOW_START_WITHOUT_DB: Joi.boolean(),
    OPENIM_API_URL: Joi.string().uri().optional(),
    OPENIM_ADMIN_SECRET: Joi.string().optional(),
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

import { createEnvValidationSchema } from './env.validation';

describe('createEnvValidationSchema', () => {
  const baseEnv = {
    NODE_ENV: 'development',
    SECRET: 'test-secret',
  };

  it('requires DATABASE_URL by default', () => {
    const { error } = createEnvValidationSchema({
      ...baseEnv,
    }).validate(baseEnv);

    expect(error?.message).toContain('"DATABASE_URL" is required');
  });

  it('allows omitting DATABASE_URL when degraded startup is enabled', () => {
    const env = {
      ...baseEnv,
      ALLOW_START_WITHOUT_DB: 'true',
    };

    const { error, value } = createEnvValidationSchema(env).validate(env);

    expect(error).toBeUndefined();
    expect(value.ALLOW_START_WITHOUT_DB).toBe(true);
  });

  it('normalizes optional call configuration defaults', () => {
    const env = {
      ...baseEnv,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    };

    const { error, value } = createEnvValidationSchema(env).validate(env);

    expect(error).toBeUndefined();
    expect(value.LIVEKIT_TOKEN_TTL_SECONDS).toBe(3600);
    expect(value.CALL_RING_TIMEOUT_SECONDS).toBe(45);
    expect(value.CALL_MAX_PARTICIPANTS).toBe(10);
    expect(value.CALL_ENABLE_VIDEO).toBe(false);
  });

  it('accepts optional REDIS_URL for shared realtime and rate limiting', () => {
    const env = {
      ...baseEnv,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
    };

    const { error, value } = createEnvValidationSchema(env).validate(env);

    expect(error).toBeUndefined();
    expect(value.REDIS_URL).toBe('redis://localhost:6379');
  });

  it('allows production startup without Redis by default for backwards compatibility', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error).toBeUndefined();
  });

  it('requires REDIS_URL when strict Redis startup is explicitly enabled', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_REQUIRED: 'true',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error?.message).toContain('"REDIS_URL" is required');
  });

  it('requires REDIS_URL in development when strict mode is enabled', () => {
    const env = {
      ...baseEnv,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_REQUIRED: 'true',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error?.message).toContain('"REDIS_URL" is required');
  });

  it('accepts an authenticated Redis URL in production', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_URL: 'redis://default:secret@redis:6379',
      REDIS_ALLOW_INSECURE: 'true',
    };

    const { error, value } = createEnvValidationSchema(env).validate(env);

    expect(error).toBeUndefined();
    expect(value.REDIS_URL).toBe('redis://default:secret@redis:6379');
  });

  it('rejects non-Redis URL schemes', () => {
    const env = {
      ...baseEnv,
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      REDIS_URL: 'https://redis.example.com',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error?.message).toContain('REDIS_URL');
  });

  it('rejects unauthenticated Redis URLs in production', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_URL: 'redis://redis:6379',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error?.message).toContain('authentication credentials');
  });

  it('requires TLS for non-local production Redis endpoints', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_URL: 'redis://default:secret@cache.example.com:6379',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error?.message).toContain('rediss');
  });

  it('accepts authenticated TLS Redis endpoints in production', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_URL: 'rediss://default:secret@cache.example.com:6380',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error).toBeUndefined();
  });

  it('accepts ioredis query-string credentials over TLS', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_URL: 'rediss://cache.example.com:6380?password=secret',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error).toBeUndefined();
  });

  it('rejects ambiguous duplicate Redis password query parameters', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_URL: 'rediss://cache.example.com:6380?password=secret&password=',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error?.message).toContain('exactly one password source');
  });

  it('rejects mixed authority and query Redis passwords', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_URL:
        'rediss://default:authority@cache.example.com:6380?password=query',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error?.message).toContain('exactly one password source');
  });

  it('allows explicit cleartext Redis for private service DNS names', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
      REDIS_ALLOW_INSECURE: 'true',
      REDIS_URL: 'redis://default:secret@redis.default.svc.cluster.local:6379',
    };

    const { error } = createEnvValidationSchema(env).validate(env);

    expect(error).toBeUndefined();
  });
});

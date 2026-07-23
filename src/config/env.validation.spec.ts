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
    // FE#119 拍板：测试期默认开视频
    expect(value.CALL_ENABLE_VIDEO).toBe(true);
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

  describe('session TTL knobs (PR #117 review)', () => {
    const base = {
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'x'.repeat(64),
    };

    it('does NOT default REFRESH_EXPIRES_IN — legacy-only envs keep their fallback alive', () => {
      const env = { ...base, REFRESH_EXPIRES_IN_DAYS: '14' };
      const { error, value } = createEnvValidationSchema(env).validate(env, {
        allowUnknown: true,
      });
      expect(error).toBeUndefined();
      // Joi 层若默认 '7d'，RefreshTokenService 永远读到非空值，
      // REFRESH_EXPIRES_IN_DAYS 的兼容回落就成了死代码（会把 14d 环境降成 7d）
      expect(value.REFRESH_EXPIRES_IN).toBeUndefined();
    });

    it('rejects malformed TTLs at boot instead of silently defaulting', () => {
      for (const bad of [
        { REFRESH_EXPIRES_IN: '8hours' },
        { REFRESH_EXPIRES_IN: 'soon' },
        { ADMIN_REFRESH_EXPIRES_IN: '3600x' },
        { ADMIN_JWT_EXPIRES_IN: 'fifteen-minutes' },
        { REFRESH_EXPIRES_IN_DAYS: '-3' },
        // round 2：零时长（下游按无效回落默认 = 静默放大）
        { REFRESH_EXPIRES_IN: '0d' },
        { ADMIN_REFRESH_EXPIRES_IN: '0h' },
        { ADMIN_JWT_EXPIRES_IN: '0s' },
        { REFRESH_EXPIRES_IN_DAYS: '0' },
        // round 2：admin refresh 裸数字（旧语义=天，漏个 h 变 12 天）
        { ADMIN_REFRESH_EXPIRES_IN: '12' },
        // round 3：admin access 裸数字（'900' 按毫秒解析 = 1 秒 token）
        { ADMIN_JWT_EXPIRES_IN: '900' },
      ]) {
        const env = { ...base, ...bad };
        const { error } = createEnvValidationSchema(env).validate(env, {
          allowUnknown: true,
        });
        expect(error?.message).toBeDefined();
      }
    });

    it('accepts the documented duration formats', () => {
      const env = {
        ...base,
        REFRESH_EXPIRES_IN: '30d',
        ADMIN_REFRESH_EXPIRES_IN: '12h',
        ADMIN_JWT_EXPIRES_IN: '900s',
        REFRESH_EXPIRES_IN_DAYS: '14',
      };
      const { error } = createEnvValidationSchema(env).validate(env, {
        allowUnknown: true,
      });
      expect(error).toBeUndefined();
    });
  });

  describe('OPENIM_ADMIN_SECRET', () => {
    // The admin secret is POSTed to /auth/get_admin_token; whoever holds it can
    // mint an OpenIM admin token and act as any user. It is gated on
    // OPENIM_API_URL because an unset URL is the supported "IM disabled" state.
    const productionBase = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      SECRET: 'a-production-secret-that-is-over-32-characters',
      ALLOWED_ORIGINS: 'https://app.example.com',
      TEMP_CHAT_LINK_SECRET: 'a-temp-chat-secret-that-is-over-32-characters',
    };

    it('rejects the well-known OpenIM default secret in production', () => {
      const env = {
        ...productionBase,
        OPENIM_API_URL: 'http://im.example.com:10002',
        OPENIM_ADMIN_SECRET: 'openIM123',
      };

      const { error } = createEnvValidationSchema(env).validate(env);

      expect(error?.message).toContain('OPENIM_ADMIN_SECRET');
      expect(error?.message).toContain('at least 32');
    });

    it('requires OPENIM_ADMIN_SECRET in production once OPENIM_API_URL is set', () => {
      const env = {
        ...productionBase,
        OPENIM_API_URL: 'http://im.example.com:10002',
      };

      const { error } = createEnvValidationSchema(env).validate(env);

      expect(error?.message).toContain('"OPENIM_ADMIN_SECRET" is required');
    });

    it('allows production startup with OpenIM disabled (no API URL, no secret)', () => {
      const env = { ...productionBase };

      const { error } = createEnvValidationSchema(env).validate(env);

      expect(error).toBeUndefined();
    });

    it('accepts a short secret outside production so local OpenIM still boots', () => {
      const env = {
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        SECRET: 'test-secret',
        OPENIM_API_URL: 'http://127.0.0.1:10002',
        OPENIM_ADMIN_SECRET: 'openIM123',
      };

      const { error } = createEnvValidationSchema(env).validate(env);

      expect(error).toBeUndefined();
    });

    it('accepts a sufficiently long admin secret in production', () => {
      const env = {
        ...productionBase,
        OPENIM_API_URL: 'http://im.example.com:10002',
        OPENIM_ADMIN_SECRET: 'an-openim-admin-secret-over-32-characters',
      };

      const { error } = createEnvValidationSchema(env).validate(env);

      expect(error).toBeUndefined();
    });
  });
});

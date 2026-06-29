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
});

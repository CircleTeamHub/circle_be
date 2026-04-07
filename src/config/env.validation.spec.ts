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
});

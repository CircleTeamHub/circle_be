import { ConfigModule } from '@nestjs/config';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEmailBypassCode } from 'src/auth/email-code-bypass';
import { createEnvValidationSchema } from './env.validation';

it.each([
  ['preproduction', '999999'],
  [undefined, null],
])(
  'loads deployment stage %s from .env.production into the runtime bypass environment',
  async (deployEnv, expectedCode) => {
    const directory = mkdtempSync(join(tmpdir(), 'circle-email-bypass-'));
    const envFile = join(directory, '.env.production');
    const originalEnv = process.env;
    const fileEnv = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      SECRET: 'x'.repeat(32),
      TEMP_CHAT_LINK_SECRET: 'x'.repeat(32),
      ALLOWED_ORIGINS: 'https://app.example.com',
      METRICS_AUTH_TOKEN: 'test-only-metrics-token',
      EMAIL_CODE_DEV_BYPASS: '999999',
      ...(deployEnv ? { APP_DEPLOY_ENV: deployEnv } : {}),
    };

    // Only this locally generated fixture is written and removed.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(
      envFile,
      Object.entries(fileEnv)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    process.env = { NODE_ENV: 'production' };
    try {
      await ConfigModule.forRoot({
        envFilePath: envFile,
        validationSchema: createEnvValidationSchema(process.env),
      });

      expect(process.env.APP_DEPLOY_ENV).toBe(deployEnv ?? 'production');
      expect(process.env.EMAIL_CODE_DEV_BYPASS).toBe('999999');
      expect(
        resolveEmailBypassCode('test-only@example.com', 'RESET_PASSWORD'),
      ).toBe(expectedCode);
    } finally {
      process.env = originalEnv;
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      unlinkSync(envFile);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      rmdirSync(directory);
    }
  },
);

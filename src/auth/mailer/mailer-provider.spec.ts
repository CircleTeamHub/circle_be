import * as fs from 'node:fs';
import * as path from 'node:path';
import { createEnvValidationSchema } from 'src/config/env.validation';

const BASE_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  SECRET: 'x'.repeat(64),
};

describe('mailer provider wiring (#82)', () => {
  it('auth.module selects SmtpMailer on SMTP_HOST and error-logs the production console fallback', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/auth/auth.module.ts'),
      'utf8',
    );
    // factory 按 SMTP_HOST 切换真实实现
    expect(source).toMatch(/SMTP_HOST/);
    expect(source).toMatch(/new SmtpMailer\(configService\)/);
    // 生产落在 Console 路径必须以 error 级日志暴露（而不是静默）
    expect(source).toMatch(/'production'/);
    expect(source).toMatch(/\.error\(/);
    expect(source).toMatch(/new ConsoleMailer\(\)/);
    // 不再无条件绑定 ConsoleMailer
    expect(source).not.toMatch(/\{ provide: MAILER, useClass: ConsoleMailer \}/);
  });

  it('env schema requires credentials once SMTP_HOST is set', () => {
    const schema = createEnvValidationSchema(BASE_ENV);

    const missingCreds = schema.validate(
      { ...BASE_ENV, SMTP_HOST: 'smtp.example.com' },
      { allowUnknown: true },
    );
    expect(missingCreds.error?.message).toMatch(/SMTP_USER|SMTP_PASS/);

    const complete = schema.validate(
      {
        ...BASE_ENV,
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'bot@example.com',
        SMTP_PASS: 'auth-code',
      },
      { allowUnknown: true },
    );
    expect(complete.error).toBeUndefined();
    expect(complete.value.SMTP_PORT).toBe(465);
    expect(complete.value.SMTP_SECURE).toBe(true);

    // 未配置 SMTP 仍是受支持的开发态
    const unset = schema.validate(BASE_ENV, { allowUnknown: true });
    expect(unset.error).toBeUndefined();
  });
});

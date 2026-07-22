import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { EmailCodePurpose } from 'src/generated/prisma';
import { createEnvValidationSchema } from 'src/config/env.validation';
import { UnconfiguredMailer } from './unconfigured.mailer';

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
    // 生产缺 SMTP 必须 fail closed：绑 UnconfiguredMailer（503，绝不打码），
    // 且保留启动期 error 日志；ConsoleMailer 仅剩开发/测试路径。
    expect(source).toMatch(/'production'/);
    expect(source).toMatch(/\.error\(/);
    expect(source).toMatch(/new UnconfiguredMailer\(\)/);
    expect(source).toMatch(/new ConsoleMailer\(\)/);
    // 不再无条件绑定 ConsoleMailer
    expect(source).not.toMatch(
      /\{ provide: MAILER, useClass: ConsoleMailer \}/,
    );
    // 生产分支必须在 Console 回落之前 return（Console 不可达于生产）
    expect(source.indexOf('new UnconfiguredMailer()')).toBeLessThan(
      source.indexOf('new ConsoleMailer()'),
    );
  });

  it('UnconfiguredMailer answers 503 and never emits the code or full email', async () => {
    const mailer = new UnconfiguredMailer();
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      await expect(
        mailer.sendVerificationCode(
          'alice@example.com',
          '123456',
          EmailCodePurpose.LOGIN,
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      const logged = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('123456');
      expect(logged).not.toContain('alice@example.com');
    } finally {
      errorSpy.mockRestore();
    }
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

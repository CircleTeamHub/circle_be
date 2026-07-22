import { ConfigService } from '@nestjs/config';
import { EmailCodePurpose } from 'src/generated/prisma';

const createTransportMock = jest.fn();
const sendMailMock = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => {
    createTransportMock(...args);
    return { sendMail: sendMailMock };
  },
}));

// mock must be registered before this import (jest hoists jest.mock above it)
import { SmtpMailer } from './smtp.mailer';

function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('SmtpMailer', () => {
  beforeEach(() => {
    createTransportMock.mockClear();
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ messageId: 'x' });
  });

  it('builds an implicit-TLS transport for the default 465 config', () => {
    new SmtpMailer(
      configWith({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'bot@example.com',
        SMTP_PASS: 'auth-code',
      }),
    );

    expect(createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: 'bot@example.com', pass: 'auth-code' },
      // 未认证端点内联发信：连接/握手/收发都必须钉秒级超时
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
    });
  });

  it('enforces STARTTLS when secure=false (587) — plaintext delivery is unconfigurable', () => {
    new SmtpMailer(
      configWith({
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
        SMTP_USER: 'bot@example.com',
        SMTP_PASS: 'auth-code',
      }),
    );

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
  });

  it('sends the code with a purpose-specific subject and MAIL_FROM', async () => {
    const mailer = new SmtpMailer(
      configWith({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'bot@example.com',
        SMTP_PASS: 'auth-code',
        MAIL_FROM: '风信 <noreply@example.com>',
      }),
    );

    await mailer.sendVerificationCode(
      'alice@example.com',
      '123456',
      EmailCodePurpose.REGISTER,
    );

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const message = sendMailMock.mock.calls[0][0];
    expect(message.from).toBe('风信 <noreply@example.com>');
    expect(message.to).toBe('alice@example.com');
    expect(message.subject).toContain('注册');
    expect(message.text).toContain('123456');
    expect(message.html).toContain('123456');
  });

  it('falls back to SMTP_USER as the from address', async () => {
    const mailer = new SmtpMailer(
      configWith({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'bot@example.com',
        SMTP_PASS: 'auth-code',
      }),
    );

    await mailer.sendVerificationCode(
      'alice@example.com',
      '654321',
      EmailCodePurpose.LOGIN,
    );

    expect(sendMailMock.mock.calls[0][0].from).toBe('bot@example.com');
  });

  it('propagates transport failures instead of swallowing them', async () => {
    sendMailMock.mockRejectedValue(new Error('454 relay refused'));
    const mailer = new SmtpMailer(
      configWith({
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'bot@example.com',
        SMTP_PASS: 'auth-code',
      }),
    );

    await expect(
      mailer.sendVerificationCode(
        'alice@example.com',
        '111111',
        EmailCodePurpose.LOGIN,
      ),
    ).rejects.toThrow('454 relay refused');
  });
});

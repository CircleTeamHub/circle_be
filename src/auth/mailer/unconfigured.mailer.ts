import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailCodePurpose } from 'src/generated/prisma';
import { Mailer } from './mailer.interface';

/**
 * 生产环境缺 SMTP 配置时的 fail-closed Mailer（PR #116 review 修复）。
 *
 * 此前生产缺 SMTP_HOST 会回落 ConsoleMailer —— 每次 request-code 都把收件人
 * 和完整验证码打进集中式日志：用户收不到邮件，日志管道却成了 OTP 泄露面。
 * 这里改为：请求期直接 503（不打验证码、不打邮箱全文），把「配好 SMTP_*」
 * 变成唯一出路，同时保住部署本身可启动（比 fail boot 少救火一层）。
 */
@Injectable()
export class UnconfiguredMailer implements Mailer {
  private readonly logger = new Logger('UnconfiguredMailer');

  sendVerificationCode(
    email: string,
    _code: string,
    purpose: EmailCodePurpose,
  ): Promise<void> {
    const domain = email.split('@')[1] ?? 'unknown';
    this.logger.error(
      `refusing to deliver verification code (${purpose}) to *@${domain}: ` +
        'SMTP is not configured in production. Set SMTP_HOST/SMTP_USER/SMTP_PASS.',
    );
    return Promise.reject(
      new ServiceUnavailableException('邮件服务暂不可用，请稍后再试'),
    );
  }
}

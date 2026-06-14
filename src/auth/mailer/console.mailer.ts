import { Injectable, Logger } from '@nestjs/common';
import { EmailCodePurpose } from 'src/generated/prisma';
import { Mailer } from './mailer.interface';

/** 开发期 Mailer：把验证码打到日志，不真正发信。生产环境请替换为真实实现。 */
@Injectable()
export class ConsoleMailer implements Mailer {
  private readonly logger = new Logger('ConsoleMailer');

  sendVerificationCode(
    email: string,
    code: string,
    purpose: EmailCodePurpose,
  ): Promise<void> {
    this.logger.log(
      `[DEV] verification code for ${email} (${purpose}): ${code}`,
    );
    return Promise.resolve();
  }
}

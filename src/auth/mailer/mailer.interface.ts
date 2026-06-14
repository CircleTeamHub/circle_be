import { EmailCodePurpose } from 'src/generated/prisma';

/** DI token — 生产环境用真实实现覆盖此 provider 即可，业务代码零改动。 */
export const MAILER = Symbol('MAILER');

export interface Mailer {
  sendVerificationCode(
    email: string,
    code: string,
    purpose: EmailCodePurpose,
  ): Promise<void>;
}

import { EmailCodePurpose } from 'src/generated/prisma';

/** DI token — 生产环境用真实实现覆盖此 provider 即可，业务代码零改动。 */
export const MAILER = Symbol('MAILER');

export interface Mailer {
  sendVerificationCode(
    email: string,
    code: string,
    purpose: EmailCodePurpose,
  ): Promise<void>;
  /**
   * 投递通道是否可用（round 3 review）。requestCode 必须在「账号是否存在」
   * 分支之前统一失败 —— 否则 fail-closed 的 503 只打在可投递地址上，
   * 本身就成了未认证的账号枚举 oracle。缺省实现视为可用。
   */
  isAvailable?(): boolean;
}

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { EmailCodePurpose } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { normalizeEmail } from 'src/utils/email';
import { AuthErrorCode } from 'src/common/app-error-codes';
import { MAILER, Mailer } from './mailer/mailer.interface';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 秒
const MAX_ATTEMPTS = 5;

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private prisma: PrismaService,
    @Inject(MAILER) private mailer: Mailer,
  ) {}

  private generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  /**
   * 开发占位：真实邮件投递接通前，本地可用一个固定码直接通过验证。
   * 生产环境（NODE_ENV=production）永远返回 null —— 绝不放后门进线上。
   *
   * 安全（F-05）：**必须显式 opt-in**。没有内置默认码 —— 只有当
   * EMAIL_CODE_DEV_BYPASS 被显式设置为非空、非 "off" 值时才启用。这样任何
   * 非生产但共享/联网的环境（staging/preprod），只要没配这个变量，就没有
   * 任何后门码可用，攻击者无法用众所周知的 999999 登进去。
   * 本地开发在 .env.development 里设置该变量即可照常使用。
   */
  private getDevBypassCode(): string | null {
    if (process.env.NODE_ENV === 'production') return null;
    const value = process.env.EMAIL_CODE_DEV_BYPASS?.trim();
    if (!value || value.toLowerCase() === 'off') return null;
    return value;
  }

  async requestCode(
    rawEmail: string,
    purpose: EmailCodePurpose,
  ): Promise<void> {
    const email = normalizeEmail(rawEmail);

    const last = await this.prisma.emailVerificationCode.findFirst({
      where: { email, purpose },
      orderBy: { createdAt: 'desc' },
    });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new BadRequestException({
        message: '验证码发送过于频繁，请稍后再试',
        errorCode: AuthErrorCode.CodeRateLimited,
      });
    }

    const userExists = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (purpose === 'REGISTER' && userExists) {
      // 防账号枚举（F-07）：不再对已注册邮箱返回「已注册」的 409（那会泄漏邮箱是否已注册）。
      // 静默成功、不发码；真正的重复在 verify 落库时由 email unique 约束兜底（错误已泛化，
      // 见 F-06）。与下方 LOGIN 未注册的静默处理对称。
      return;
    }
    if (purpose === 'LOGIN' && !userExists) {
      // 防账号枚举：未注册邮箱静默成功，不创建记录、不发信。
      return;
    }
    if (purpose === 'RESET_PASSWORD' && !userExists) {
      // 同上（FE#92 忘记密码）：不存在的邮箱静默成功。
      return;
    }

    const code = this.generateCode();
    const codeHash = await argon2.hash(code);

    // 同 email+purpose 仅保留最新一条未消费记录。
    await this.prisma.emailVerificationCode.deleteMany({
      where: { email, purpose, consumedAt: null },
    });
    await this.prisma.emailVerificationCode.create({
      data: {
        email,
        codeHash,
        purpose,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    await this.mailer.sendVerificationCode(email, code, purpose);
  }

  async verifyCode(
    rawEmail: string,
    purpose: EmailCodePurpose,
    code: string,
  ): Promise<boolean> {
    const email = normalizeEmail(rawEmail);

    // Dev 占位：固定码直接通过（无需先请求验证码）。生产环境此处恒为 null。
    const bypass = this.getDevBypassCode();
    if (bypass && code === bypass) {
      this.logger.warn(
        `[DEV] email code bypass used for ${email} (${purpose}) — disable in production`,
      );
      return true;
    }

    const record = await this.prisma.emailVerificationCode.findFirst({
      where: {
        email,
        purpose,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!record || record.attempts >= MAX_ATTEMPTS) {
      return false;
    }

    const valid = await argon2.verify(record.codeHash, code);
    if (!valid) {
      await this.prisma.emailVerificationCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      return false;
    }

    await this.prisma.emailVerificationCode.update({
      where: { id: record.id },
      data: { consumedAt: new Date() },
    });
    return true;
  }
}

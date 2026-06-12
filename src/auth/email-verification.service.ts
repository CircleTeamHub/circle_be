import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { EmailCodePurpose } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { normalizeEmail } from 'src/utils/email';
import { MAILER, Mailer } from './mailer/mailer.interface';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 秒
const MAX_ATTEMPTS = 5;

@Injectable()
export class EmailVerificationService {
  constructor(
    private prisma: PrismaService,
    @Inject(MAILER) private mailer: Mailer,
  ) {}

  private generateCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  async requestCode(rawEmail: string, purpose: EmailCodePurpose): Promise<void> {
    const email = normalizeEmail(rawEmail);

    const last = await this.prisma.emailVerificationCode.findFirst({
      where: { email, purpose },
      orderBy: { createdAt: 'desc' },
    });
    if (last && Date.now() - last.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new BadRequestException('验证码发送过于频繁，请稍后再试');
    }

    const userExists = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (purpose === 'REGISTER' && userExists) {
      throw new ConflictException('该邮箱已注册');
    }
    if (purpose === 'LOGIN' && !userExists) {
      // 防账号枚举：未注册邮箱静默成功，不创建记录、不发信。
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

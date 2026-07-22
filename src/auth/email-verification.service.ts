import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import * as argon2 from 'argon2';
import { EmailCodePurpose } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { normalizeEmail } from 'src/utils/email';
import { AuthErrorCode } from 'src/common/app-error-codes';
import { MAILER, Mailer } from './mailer/mailer.interface';

/** SMTP 错误 → 可入日志的脱敏描述：类名 + code/responseCode + 打码正文。 */
function describeMailerError(error: unknown): string {
  const shaped = error as {
    name?: unknown;
    code?: unknown;
    responseCode?: unknown;
    message?: unknown;
  } | null;
  const parts = [
    typeof shaped?.name === 'string' ? shaped.name : 'Error',
    typeof shaped?.code === 'string' || typeof shaped?.code === 'number'
      ? `code=${shaped.code}`
      : null,
    typeof shaped?.responseCode === 'number'
      ? `responseCode=${shaped.responseCode}`
      : null,
    typeof shaped?.message === 'string'
      ? shaped.message.replace(/[^\s@<>()]+@[^\s@<>()]+/g, '<redacted-email>')
      : null,
  ].filter(Boolean);
  return parts.join(' ');
}

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
    // round 3 review（P1）：投递通道不可用时在**任何分支之前**统一失败。
    // 若放在防枚举早退之后，503 只会打在「会真正发信」的地址上 ——
    // register 对已注册邮箱静默 201、login 对未注册邮箱静默 201，
    // fail-closed 反而变成账号存在性 oracle。
    if (this.mailer.isAvailable && !this.mailer.isAvailable()) {
      throw new ServiceUnavailableException('邮件服务暂不可用，请稍后再试');
    }
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

    const code = this.generateCode();
    const codeHash = await argon2.hash(code);

    // review 修复（并发串行化）：删旧 + 建新放进 per-email+purpose advisory
    // 锁事务，并在锁内复检冷却。否则两个并发请求都能越过上面的冷却快查，
    // 各自 deleteMany+create+发信 —— 用户先收到的那封码已被后写的一条作废。
    // 锁内复检让后到者拿到 CodeRateLimited，只有一封信发出。
    const lockKey = `email-code:${purpose}:${email}`;
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const latest = await tx.emailVerificationCode.findFirst({
        where: { email, purpose },
        orderBy: { createdAt: 'desc' },
      });
      if (
        latest &&
        Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS
      ) {
        throw new BadRequestException({
          message: '验证码发送过于频繁，请稍后再试',
          errorCode: AuthErrorCode.CodeRateLimited,
        });
      }
      // review 修复（round 2）：旧未消费行的作废推迟到**新码送达之后** ——
      // 冷却期外的重发若在删旧后才失败，用户手里已送达的旧码会被连坐作废，
      // 落进「一个可用码都没有」的状态。verifyCode 取最新未消费行，新旧
      // 短暂并存时也永远只认新码，语义不变。
      return tx.emailVerificationCode.create({
        data: {
          email,
          codeHash,
          purpose,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      });
    });

    try {
      await this.mailer.sendVerificationCode(email, code, purpose);
      // 送达成功才作废旧码：同 email+purpose 只留刚送达的这一条未消费行。
      // round 3 review ×2：
      // - 只删 createdAt 更早的行 —— 本清理若被拖过冷却窗口，`id != created`
      //   会连后来重发的新码一起删掉；
      // - 失败不再静默吞：老行残留会在新码消费后重新可用（verifyCode 已
      //   加最新行判定兜底），但仍要在日志里可见。
      await this.prisma.emailVerificationCode
        .deleteMany({
          where: {
            email,
            purpose,
            consumedAt: null,
            createdAt: { lt: created.createdAt },
          },
        })
        .catch((cleanupError) => {
          this.logger.warn(
            `stale code cleanup failed (${purpose}): ${
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError)
            }`,
          );
        });
    } catch (error) {
      // review 修复（投递失败回滚）：不回滚的话这条没送达的行会占住 60s
      // 冷却 —— 用户立刻重试只会得到 CodeRateLimited，且不会再发一封。
      // 删行让重试立即可用（滥用防护由 setup 层 emailCodeLimiter 兜底），
      // 且此刻旧码原封未动，仍可验证。
      await this.prisma.emailVerificationCode
        .deleteMany({ where: { id: created.id } })
        .catch((rollbackError) => {
          // round 3 review：回滚失败必须可见 —— 未送达的行残留会占住 60s
          // 冷却并遮蔽更早已送达的码（verifyCode 只认最新行），需人工删除。
          this.logger.error(
            `undelivered code rollback failed (${purpose}) rowId=${created.id}: ${
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError)
            }`,
          );
        });
      if (error instanceof ServiceUnavailableException) throw error;
      // review 修复（round 2）：SMTP 报错常回带 RCPT 收件人全文，整棵 stack
      // 打日志等于把邮箱写进生产日志。只留脱敏元信息：错误类名、SMTP
      // code/responseCode、正文里的邮箱全部打码。
      this.logger.error(
        `verification mail delivery failed (${purpose}): ${describeMailerError(error)}`,
      );
      throw new ServiceUnavailableException('验证码发送失败，请稍后再试');
    }
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

    // round 3 review：候选行还必须是该 (email, purpose) 的**整体最新**行
    // （含已消费行）。否则「新码已被消费、旧码因清理失败仍在」的窗口里，
    // 旧码会重新变得可用 —— 一封邮箱里躺着的旧邮件成了第二把钥匙。
    const newest = await this.prisma.emailVerificationCode.findFirst({
      where: { email, purpose },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (newest && newest.id !== record.id) {
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

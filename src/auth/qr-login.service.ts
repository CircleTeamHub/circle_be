import {
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { QrErrorCode } from 'src/common/app-error-codes';
import { AuthService } from './auth.service';
import type { SessionContext } from './refresh-token.service';
import {
  describeQrLoginDevice,
  qrLoginVerificationCode,
} from './qr-login-context';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';

/**
 * 网页扫码登录（桌面网页版 M3）。
 *
 * 双令牌设计：qrToken 编进二维码给手机扫，pollKey 只留在发起的网页端 ——
 * 旁观者拍到二维码最多能"替你确认"，拿不到轮询凭证，永远换不走会话。
 *
 * 生命周期：PENDING --手机 approve--> APPROVED --网页首次轮询命中--> CONSUMED。
 * 换发会话发生在**轮询侧**（CONSUMED 原子抢占，updateMany 天然防并发双换）；
 * SessionContext 因此取自网页端请求 —— 会话管理页里这台设备显示的才是浏览器。
 *
 * 错误码复用 QrErrorCode.Expired/Invalid：前端 serverErrors 映射与跨仓契约
 * 测试零新增。
 */
const QR_LOGIN_TTL_MS = 2 * 60_000;
/** 过期后仍保留行的时长，之后由 cron 删除。 */
const QR_LOGIN_RETENTION_MS = 60 * 60_000;

export type QrLoginStatusResult =
  | { status: 'PENDING' | 'EXPIRED' }
  | {
      status: 'APPROVED';
      tokens: { accessToken: string; refreshToken: string };
    };

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

@Injectable()
export class QrLoginService {
  private readonly logger = new Logger(QrLoginService.name);
  private readonly loggingConfig = createLoggingConfig();
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async create(sessionContext?: SessionContext) {
    const requestDevice = describeQrLoginDevice(sessionContext);
    const session = await this.prisma.qrLoginSession.create({
      data: {
        qrToken: randomBytes(24).toString('base64url'),
        pollKey: randomBytes(24).toString('base64url'),
        requestDevice,
        expiresAt: new Date(Date.now() + QR_LOGIN_TTL_MS),
      },
      select: {
        qrToken: true,
        pollKey: true,
        requestDevice: true,
        expiresAt: true,
      },
    });
    return {
      qrToken: session.qrToken,
      pollKey: session.pollKey,
      requestDevice: session.requestDevice,
      verificationCode: qrLoginVerificationCode(session.qrToken),
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  /** 手机端扫码确认。要求会话仍 PENDING 且未过期。 */
  async approve(userId: string, qrToken: string) {
    const session = await this.prisma.qrLoginSession.findUnique({
      where: { qrToken },
    });
    if (!session || session.status !== 'PENDING') {
      throw new NotFoundException({
        message: '二维码已失效，请刷新后重试',
        errorCode: QrErrorCode.Invalid,
      });
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundException({
        message: '二维码已过期，请刷新后重试',
        errorCode: QrErrorCode.Expired,
      });
    }

    // 复用登录侧的账号闸门（ACTIVE、非 ADMIN）：不合格直接拒，
    // 不把不可登录的账号写成 approver。
    await this.authService.assertQrLoginEligible(userId);

    // expiresAt 也进谓词,理由与 status() 里那次消费相同:上面查过之后到这里
    // 之间隔着一次 assertQrLoginEligible 查库,足够跨过期限。不带这一条的话,
    // 掐着点确认会写出一个「已 APPROVED 但已过期」的行 —— 轮询侧照样拒,
    // 用户看到的是「手机说确认成功、网页一直不动」,最难排查的那种。
    const claimed = await this.prisma.qrLoginSession.updateMany({
      where: {
        id: session.id,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      data: { status: 'APPROVED', approvedByID: userId },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        message: '二维码已被使用',
        errorCode: QrErrorCode.Invalid,
      });
    }
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_qr_login_approved',
      actorId: userId,
      result: 'success',
      entityType: 'qr_login_session',
      entityId: session.id,
    });
    return { ok: true };
  }

  /**
   * 网页端轮询。除 PENDING/APPROVED 首胜之外一律回 EXPIRED —— 不存在、
   * pollKey 不对、已消费、已过期在响应上不可区分，不给探测面。
   */
  async status(
    qrToken: string,
    pollKey: string,
    sessionContext?: SessionContext,
  ): Promise<QrLoginStatusResult> {
    const session = await this.prisma.qrLoginSession.findUnique({
      where: { qrToken },
    });
    if (!session || !safeEqual(session.pollKey, pollKey)) {
      return { status: 'EXPIRED' };
    }
    // 过期先于状态判定。曾经只在 PENDING 分支里查 expiresAt —— 于是「临到期
    // 前一秒确认」的会话变成永久有效：APPROVED 之后拖几小时甚至几天再来轮询
    // 照样换得走完整会话，两分钟的有效期形同虚设。
    if (session.expiresAt.getTime() <= Date.now()) {
      return { status: 'EXPIRED' };
    }
    if (session.status === 'PENDING') {
      return { status: 'PENDING' };
    }
    if (session.status !== 'APPROVED' || !session.approvedByID) {
      return { status: 'EXPIRED' };
    }

    // 原子抢占消费位：并发双轮询只有一个能换走会话。expiresAt 也进谓词 ——
    // 上面那次检查到这里之间可能刚好跨过期限（check/update 竞态）。
    const consumed = await this.prisma.qrLoginSession.updateMany({
      where: {
        id: session.id,
        status: 'APPROVED',
        expiresAt: { gt: new Date() },
      },
      data: { status: 'CONSUMED', consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      return { status: 'EXPIRED' };
    }

    try {
      const tokens = await this.authService.issueQrLoginTokens(
        session.approvedByID,
        sessionContext,
      );
      return { status: 'APPROVED', tokens };
    } catch (error) {
      // 令牌没发出去就把消费位放回去。不放回的话，一次瞬时故障（DB 抖动、
      // JWT 签发失败）就把会话钉死在 CONSUMED：网页端后续每次轮询都拿
      // EXPIRED，用户除了重新扫码别无出路，而故障本身早就过去了。
      //
      // 残留风险留档：若失败发生在 finishLogin 建完 refresh session 之后，
      // 那条会话会成为孤儿（用户在会话管理页多看到一台设备）。它归属同一
      // 用户、受 RefreshTokenCleanup 管理，比「永久锁死」的代价小得多；
      // 要彻底消除需要把 issue 纳入同一事务，届时再改。
      await this.prisma.qrLoginSession
        .updateMany({
          where: { id: session.id, status: 'CONSUMED' },
          data: { status: 'APPROVED', consumedAt: null },
        })
        // 回滚失败不能盖掉原始错误 —— 那才是要往上抛的那个。
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * 清掉过了保留期的会话行。每个匿名 create 都插一行，没有任何删除路径的话
   * 这张认证表和它的两个唯一索引会随正常流量无限长大（刷一次二维码就是一行）。
   *
   * 保留期比 TTL 长一截：刚过期的行还要留着，好让还在轮询的网页端拿到
   * EXPIRED 而不是「查无此码」—— 两者响应虽同，行还在时少一次索引未命中。
   */
  purgeExpired(now: Date = new Date()) {
    return this.prisma.qrLoginSession.deleteMany({
      where: {
        expiresAt: { lt: new Date(now.getTime() - QR_LOGIN_RETENTION_MS) },
      },
    });
  }
}

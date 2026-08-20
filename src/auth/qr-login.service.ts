import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { QrErrorCode } from 'src/common/app-error-codes';
import { AuthService } from './auth.service';
import type { SessionContext } from './refresh-token.service';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async create() {
    const session = await this.prisma.qrLoginSession.create({
      data: {
        qrToken: randomBytes(24).toString('base64url'),
        pollKey: randomBytes(24).toString('base64url'),
        expiresAt: new Date(Date.now() + QR_LOGIN_TTL_MS),
      },
      select: { qrToken: true, pollKey: true, expiresAt: true },
    });
    return {
      qrToken: session.qrToken,
      pollKey: session.pollKey,
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

    const claimed = await this.prisma.qrLoginSession.updateMany({
      where: { id: session.id, status: 'PENDING' },
      data: { status: 'APPROVED', approvedByID: userId },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({
        message: '二维码已被使用',
        errorCode: QrErrorCode.Invalid,
      });
    }
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
    if (session.status === 'PENDING') {
      if (session.expiresAt.getTime() <= Date.now()) {
        return { status: 'EXPIRED' };
      }
      return { status: 'PENDING' };
    }
    if (session.status !== 'APPROVED' || !session.approvedByID) {
      return { status: 'EXPIRED' };
    }

    // 原子抢占消费位：并发双轮询只有一个能换走会话。
    const consumed = await this.prisma.qrLoginSession.updateMany({
      where: { id: session.id, status: 'APPROVED' },
      data: { status: 'CONSUMED', consumedAt: new Date() },
    });
    if (consumed.count !== 1) {
      return { status: 'EXPIRED' };
    }

    const tokens = await this.authService.issueQrLoginTokens(
      session.approvedByID,
      sessionContext,
    );
    return { status: 'APPROVED', tokens };
  }
}

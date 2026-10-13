import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { LoginChallengeStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthErrorCode } from 'src/common/app-error-codes';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationPushService } from 'src/notification/notification-push.service';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logSecurityEvent } from 'src/logging/security-event.logger';
import type { SessionContext } from './refresh-token.service';

/** 受信任设备做决定的窗口：人不一定拿着手机，给 5 分钟。 */
export const LOGIN_CHALLENGE_DECISION_MS = 5 * 60 * 1000;
/** 批准后验证码的有效期。 */
export const LOGIN_CHALLENGE_CODE_TTL_MS = 60 * 1000;
/** 单个验证请求最多输错次数，用完即作废。 */
export const LOGIN_CHALLENGE_MAX_ATTEMPTS = 5;
/** 同一账号在窗口内最多发起几次验证（防「弹窗轰炸」骗点同意）。 */
export const LOGIN_CHALLENGE_RATE_LIMIT = 5;
export const LOGIN_CHALLENGE_RATE_WINDOW_MS = 10 * 60 * 1000;
/** 超过这个年龄的验证请求在新建时顺手清掉。 */
const LOGIN_CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

// 客户端设备 ID：安全存储里的随机串（UUID / base64url）。只收这个字符集，
// 不合规就当没带 —— 它会被哈希后入库，不做任何拼接。
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_DEVICE_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 256;
const MAX_IP_LENGTH = 64;

export function hashDeviceId(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !DEVICE_ID_PATTERN.test(raw)) return null;
  return createHash('sha256').update(raw).digest('hex');
}

function hashCode(challengeId: string, code: string): string {
  return createHash('sha256').update(`${challengeId}:${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function truncate(value: string | null | undefined, max: number) {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export type LoginChallengeView = {
  id: string;
  expiresAt: Date;
  securityCodeAvailable: boolean;
};

export type LoginDecision =
  | { kind: 'trusted' }
  | { kind: 'challenge'; challenge: LoginChallengeView };

export type PendingLoginChallenge = {
  id: string;
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: 'PENDING' | 'APPROVED';
};

export type LoginChallengePublicStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CONSUMED';

@Injectable()
export class DeviceTrustService {
  private readonly logger = new Logger(DeviceTrustService.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    @Optional() private readonly push?: NotificationPushService,
  ) {}

  /**
   * 密码已核对通过后调用：受信任设备 / 账号还没有任何受信任设备 → 放行；
   * 否则创建（或复用）验证请求并通知受信任设备，调用方不得发 token。
   */
  async evaluateLogin(
    user: { id: string; loginSecurityCodeHash: string | null },
    context: SessionContext,
  ): Promise<LoginDecision> {
    const deviceKey = context.deviceKey ?? null;
    const now = new Date();

    if (deviceKey) {
      const existing = await this.prisma.trustedDevice.findUnique({
        where: { userId_deviceKey: { userId: user.id, deviceKey } },
        select: { revokedAt: true },
      });
      if (existing && !existing.revokedAt) {
        await this.touch(user.id, deviceKey, context, now);
        return { kind: 'trusted' };
      }
    }

    const trustedCount = await this.prisma.trustedDevice.count({
      where: { userId: user.id, revokedAt: null },
    });
    if (trustedCount === 0) {
      // 首台设备（新注册、或功能上线前从未在新版客户端上登录过的老账号）。
      if (deviceKey) await this.trust(user.id, deviceKey, context);
      return { kind: 'trusted' };
    }

    if (!deviceKey) {
      // 旧版客户端不带设备 ID，既没法绑定验证请求也没法记信任。
      throw new ForbiddenException({
        message: '检测到陌生设备登录，请升级到最新版本后重试',
        errorCode: AuthErrorCode.DeviceIdRequired,
      });
    }

    const securityCodeAvailable = Boolean(user.loginSecurityCodeHash);

    // 同一设备反复输密码：复用还在决定窗口内的请求，不再刷一遍弹窗。
    const reusable = await this.prisma.loginChallenge.findFirst({
      where: {
        userId: user.id,
        deviceKey,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, expiresAt: true },
    });
    if (reusable) {
      return {
        kind: 'challenge',
        challenge: { ...reusable, securityCodeAvailable },
      };
    }

    const challenge = await this.createChallenge(user.id, deviceKey, context);
    return {
      kind: 'challenge',
      challenge: { ...challenge, securityCodeAvailable },
    };
  }

  /** 验证码过期后新设备重新发起：沿用原请求的设备信息，计入频率限制。 */
  async resend(
    challengeId: string,
    deviceKey: string | null,
  ): Promise<LoginChallengeView> {
    const previous = await this.findForDevice(challengeId, deviceKey);
    const status = this.publicStatus(previous, new Date());
    if (status === 'REJECTED') this.throwRejected();
    if (status === 'CONSUMED') this.throwInvalid();
    if (status !== 'EXPIRED') {
      // 还在窗口里就不新建，直接沿用。
      return {
        id: previous.id,
        expiresAt: previous.expiresAt,
        securityCodeAvailable: await this.hasSecurityCode(previous.userId),
      };
    }
    const challenge = await this.createChallenge(
      previous.userId,
      previous.deviceKey,
      {
        deviceName: previous.deviceName,
        ip: previous.ip,
        userAgent: previous.userAgent,
      },
    );
    return {
      ...challenge,
      securityCodeAvailable: await this.hasSecurityCode(previous.userId),
    };
  }

  /** 受信任设备上待处理的登录请求（App 回到前台时拉一次，防推送丢失）。 */
  async listPending(
    userId: string,
    approverDeviceKey: string | null,
  ): Promise<PendingLoginChallenge[]> {
    if (!(await this.isTrusted(userId, approverDeviceKey))) return [];
    const rows = await this.prisma.loginChallenge.findMany({
      where: {
        userId,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        deviceName: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        expiresAt: true,
        status: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      status:
        row.status === LoginChallengeStatus.APPROVED ? 'APPROVED' : 'PENDING',
    }));
  }

  /**
   * 受信任设备点「是我」：生成 6 位验证码（只回给批准方，库里只存哈希）。
   * 决定窗口内可以重复点，每次都换新码、清零输错次数。
   */
  async approve(
    userId: string,
    approverDeviceKey: string | null,
    challengeId: string,
  ): Promise<{ code: string; codeExpiresAt: Date }> {
    await this.assertTrustedApprover(userId, approverDeviceKey);
    const now = new Date();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeExpiresAt = new Date(now.getTime() + LOGIN_CHALLENGE_CODE_TTL_MS);
    const updated = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challengeId,
        userId,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        expiresAt: { gt: now },
      },
      data: {
        status: LoginChallengeStatus.APPROVED,
        codeHash: hashCode(challengeId, code),
        codeExpiresAt,
        attempts: 0,
        decidedAt: now,
      },
    });
    if (updated.count !== 1) this.throwExpired();

    this.logSecurity('login_challenge_approved', userId, { challengeId });
    this.broadcastResolved(userId, challengeId, 'APPROVED');
    return { code, codeExpiresAt };
  }

  /** 受信任设备点「不是我」：作废请求，新设备那边轮询到 REJECTED。 */
  async reject(
    userId: string,
    approverDeviceKey: string | null,
    challengeId: string,
  ): Promise<void> {
    await this.assertTrustedApprover(userId, approverDeviceKey);
    const updated = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challengeId,
        userId,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
      },
      data: {
        status: LoginChallengeStatus.REJECTED,
        codeHash: null,
        codeExpiresAt: null,
        decidedAt: new Date(),
      },
    });
    // 已被别的设备处理掉 / 已过期都按成功返回：结果一样是「这次登录进不来」。
    if (updated.count === 1) {
      this.logSecurity('login_challenge_rejected', userId, { challengeId });
      this.broadcastResolved(userId, challengeId, 'REJECTED');
    }
  }

  /** 新设备轮询：只认发起它的那台设备。 */
  async status(
    challengeId: string,
    deviceKey: string | null,
  ): Promise<{
    status: LoginChallengePublicStatus;
    expiresAt: Date;
    codeExpiresAt: Date | null;
  }> {
    const challenge = await this.findForDevice(challengeId, deviceKey);
    return {
      status: this.publicStatus(challenge, new Date()),
      expiresAt: challenge.expiresAt,
      codeExpiresAt: challenge.codeExpiresAt,
    };
  }

  /**
   * 新设备输验证码。成功 → 请求标记 CONSUMED 并返回 userId，由调用方记信任、发 token。
   * 输错计次，满 LOGIN_CHALLENGE_MAX_ATTEMPTS 次请求作废。
   */
  async consumeWithCode(
    challengeId: string,
    deviceKey: string | null,
    code: string,
  ): Promise<{ userId: string; deviceKey: string }> {
    const challenge = await this.findForDevice(challengeId, deviceKey);
    const now = new Date();
    if (challenge.status === LoginChallengeStatus.REJECTED)
      this.throwRejected();
    if (challenge.status === LoginChallengeStatus.CONSUMED) this.throwInvalid();
    if (challenge.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) this.throwLocked();
    if (
      challenge.status !== LoginChallengeStatus.APPROVED ||
      !challenge.codeHash ||
      !challenge.codeExpiresAt ||
      challenge.codeExpiresAt <= now
    ) {
      // PENDING：受信任设备还没点同意，此时根本没有码可输。
      if (
        challenge.status === LoginChallengeStatus.PENDING &&
        challenge.expiresAt > now
      ) {
        throw new ForbiddenException({
          message: '验证码错误，请核对受信任设备上显示的验证码',
          errorCode: AuthErrorCode.DeviceCodeInvalid,
        });
      }
      this.throwExpired();
    }

    if (!sameHash(challenge.codeHash, hashCode(challenge.id, code))) {
      // 条件自增：并发输错不会越过上限。
      await this.prisma.loginChallenge.updateMany({
        where: {
          id: challenge.id,
          attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS },
        },
        data: { attempts: { increment: 1 } },
      });
      this.logSecurity('login_challenge_code_invalid', challenge.userId, {
        challengeId: challenge.id,
        attempts: challenge.attempts + 1,
      });
      if (challenge.attempts + 1 >= LOGIN_CHALLENGE_MAX_ATTEMPTS)
        this.throwLocked();
      throw new ForbiddenException({
        message: '验证码错误，请核对受信任设备上显示的验证码',
        errorCode: AuthErrorCode.DeviceCodeInvalid,
      });
    }

    // 只有一次能消费成功：并发的第二个请求在这里拿到 count=0。
    const consumed = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challenge.id,
        status: LoginChallengeStatus.APPROVED,
        codeHash: challenge.codeHash,
        codeExpiresAt: { gt: now },
      },
      data: { status: LoginChallengeStatus.CONSUMED, codeHash: null },
    });
    if (consumed.count !== 1) this.throwExpired();
    return { userId: challenge.userId, deviceKey: challenge.deviceKey };
  }

  /**
   * 兜底：受信任设备不在身边时改用登录安全码。安全码本身的校验与锁定由调用方
   * （AuthService.verifyLoginSecurityCode）完成；这里只负责确认请求还有效并消费。
   */
  async loadForSecurityCode(
    challengeId: string,
    deviceKey: string | null,
  ): Promise<{ id: string; userId: string; deviceKey: string }> {
    const challenge = await this.findForDevice(challengeId, deviceKey);
    const status = this.publicStatus(challenge, new Date());
    if (status === 'REJECTED') this.throwRejected();
    if (status === 'CONSUMED') this.throwInvalid();
    if (status === 'EXPIRED') this.throwExpired();
    return challenge;
  }

  async consumeAfterSecurityCode(challengeId: string): Promise<void> {
    const consumed = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challengeId,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        expiresAt: { gt: new Date() },
      },
      data: { status: LoginChallengeStatus.CONSUMED, codeHash: null },
    });
    if (consumed.count !== 1) this.throwExpired();
  }

  /** 新设备通过验证后：记为受信任，并告诉其他设备「XX 已登录」。 */
  async completeVerifiedLogin(
    userId: string,
    challengeId: string,
    deviceKey: string,
    context: SessionContext,
  ): Promise<void> {
    await this.trust(userId, deviceKey, context);
    this.logSecurity('login_challenge_consumed', userId, { challengeId });
    this.broadcastResolved(userId, challengeId, 'CONSUMED');
    void this.pushToUser(userId, {
      title: '新设备已登录',
      body: `你的账号已在 ${context.deviceName ?? '新设备'} 上登录。如果不是你本人，请立即在「登录设备管理」中移除并修改密码。`,
      data: { type: 'auth.login.device.added' },
    });
  }

  /** 新注册 / 续签 token 的设备：持有有效会话即视为受信任（上线迁移也靠这条）。 */
  async trust(
    userId: string,
    deviceKey: string,
    context: SessionContext,
  ): Promise<void> {
    const now = new Date();
    const deviceName = truncate(context.deviceName, MAX_DEVICE_NAME_LENGTH);
    const lastIp = truncate(context.ip, MAX_IP_LENGTH);
    await this.prisma.trustedDevice.upsert({
      where: { userId_deviceKey: { userId, deviceKey } },
      create: { userId, deviceKey, deviceName, lastIp, lastSeenAt: now },
      update: { deviceName, lastIp, lastSeenAt: now, revokedAt: null },
    });
  }

  /** refresh 成功后的尽力而为补记；任何错误都不能挡住续签。 */
  async trustOnRefresh(
    userId: string,
    deviceKey: string | null,
    context: SessionContext,
  ): Promise<void> {
    if (!deviceKey) return;
    try {
      await this.trust(userId, deviceKey, context);
    } catch (error) {
      this.logger.warn(
        `trustOnRefresh failed for ${userId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** 设备管理里移除某台设备：撤销它的信任，下次登录要重新验证。 */
  async revokeDevice(userId: string, deviceKey: string | null): Promise<void> {
    if (!deviceKey) return;
    await this.prisma.trustedDevice.updateMany({
      where: { userId, deviceKey, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** 退出其他设备：除当前设备外全部撤销信任。 */
  async revokeOtherDevices(
    userId: string,
    keepDeviceKey: string | null,
  ): Promise<void> {
    await this.prisma.trustedDevice.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(keepDeviceKey ? { deviceKey: { not: keepDeviceKey } } : {}),
      },
      data: { revokedAt: new Date() },
    });
  }

  async isTrusted(userId: string, deviceKey: string | null): Promise<boolean> {
    if (!deviceKey) return false;
    const row = await this.prisma.trustedDevice.findUnique({
      where: { userId_deviceKey: { userId, deviceKey } },
      select: { revokedAt: true },
    });
    return Boolean(row && !row.revokedAt);
  }

  private async createChallenge(
    userId: string,
    deviceKey: string,
    context: SessionContext,
  ): Promise<{ id: string; expiresAt: Date }> {
    const now = new Date();
    const recent = await this.prisma.loginChallenge.count({
      where: {
        userId,
        createdAt: {
          gt: new Date(now.getTime() - LOGIN_CHALLENGE_RATE_WINDOW_MS),
        },
      },
    });
    if (recent >= LOGIN_CHALLENGE_RATE_LIMIT) {
      this.logSecurity('login_challenge_rate_limited', userId, { recent });
      throw new HttpException(
        {
          message: '验证请求过于频繁，请 10 分钟后再试',
          errorCode: AuthErrorCode.DeviceVerificationRateLimited,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const challenge = await this.prisma.loginChallenge.create({
      data: {
        userId,
        deviceKey,
        deviceName: truncate(context.deviceName, MAX_DEVICE_NAME_LENGTH),
        ip: truncate(context.ip, MAX_IP_LENGTH),
        userAgent: truncate(context.userAgent, MAX_USER_AGENT_LENGTH),
        expiresAt: new Date(now.getTime() + LOGIN_CHALLENGE_DECISION_MS),
      },
      select: { id: true, expiresAt: true },
    });

    void this.prisma.loginChallenge
      .deleteMany({
        where: {
          userId,
          createdAt: {
            lt: new Date(now.getTime() - LOGIN_CHALLENGE_RETENTION_MS),
          },
        },
      })
      .catch(() => undefined);

    this.logSecurity('login_challenge_created', userId, {
      challengeId: challenge.id,
    });
    this.realtime.broadcast(userId, {
      type: 'auth.login.challenge.created',
      payload: { challengeId: challenge.id, changedAt: now.toISOString() },
    });
    void this.pushToUser(userId, {
      title: '陌生设备登录验证',
      body: `${context.deviceName ?? '一台新设备'} 正在尝试登录你的账号，点击查看并确认是否是你本人。`,
      data: { type: 'auth.login.challenge', challengeId: challenge.id },
    });
    return challenge;
  }

  private async touch(
    userId: string,
    deviceKey: string,
    context: SessionContext,
    now: Date,
  ) {
    await this.prisma.trustedDevice.update({
      where: { userId_deviceKey: { userId, deviceKey } },
      data: {
        lastSeenAt: now,
        lastIp: truncate(context.ip, MAX_IP_LENGTH),
        ...(context.deviceName
          ? { deviceName: truncate(context.deviceName, MAX_DEVICE_NAME_LENGTH) }
          : {}),
      },
    });
  }

  private async assertTrustedApprover(
    userId: string,
    approverDeviceKey: string | null,
  ): Promise<void> {
    if (!(await this.isTrusted(userId, approverDeviceKey))) {
      throw new ForbiddenException({
        message: '当前设备不是受信任设备，无法处理登录请求',
        errorCode: AuthErrorCode.DeviceNotTrusted,
      });
    }
  }

  private async findForDevice(challengeId: string, deviceKey: string | null) {
    const challenge = deviceKey
      ? await this.prisma.loginChallenge.findUnique({
          where: { id: challengeId },
        })
      : null;
    // 设备对不上与不存在同一回应：不给猜 id 留探测口。
    if (!challenge || challenge.deviceKey !== deviceKey) this.throwInvalid();
    return challenge;
  }

  private publicStatus(
    challenge: {
      status: LoginChallengeStatus;
      expiresAt: Date;
      codeExpiresAt: Date | null;
      attempts: number;
    },
    now: Date,
  ): LoginChallengePublicStatus {
    if (challenge.status === LoginChallengeStatus.REJECTED) return 'REJECTED';
    if (challenge.status === LoginChallengeStatus.CONSUMED) return 'CONSUMED';
    if (challenge.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) return 'EXPIRED';
    if (challenge.expiresAt > now) {
      return challenge.status === LoginChallengeStatus.APPROVED
        ? 'APPROVED'
        : 'PENDING';
    }
    // 决定窗口过了，但刚批准的码还在 60 秒内：照样可以输。
    if (
      challenge.status === LoginChallengeStatus.APPROVED &&
      challenge.codeExpiresAt &&
      challenge.codeExpiresAt > now
    ) {
      return 'APPROVED';
    }
    return 'EXPIRED';
  }

  private async hasSecurityCode(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { loginSecurityCodeHash: true },
    });
    return Boolean(user?.loginSecurityCodeHash);
  }

  private broadcastResolved(
    userId: string,
    challengeId: string,
    status: 'APPROVED' | 'REJECTED' | 'CONSUMED',
  ) {
    this.realtime.broadcast(userId, {
      type: 'auth.login.challenge.resolved',
      payload: { challengeId, status, changedAt: new Date().toISOString() },
    });
  }

  private async pushToUser(
    userId: string,
    payload: { title: string; body: string; data: Record<string, unknown> },
  ): Promise<void> {
    if (!this.push) return;
    try {
      const tokens = await this.push.listActiveTokens(userId);
      if (tokens.length === 0) return;
      await this.push.sendToTokens(tokens, {
        ...payload,
        priority: 'high',
        ttl: Math.floor(LOGIN_CHALLENGE_DECISION_MS / 1000),
      });
    } catch (error) {
      // 推送是加速通道：受信任设备回到前台会主动拉待处理请求。
      this.logger.warn(
        `login challenge push failed for ${userId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private logSecurity(
    securityEvent: string,
    userId: string,
    metadata: Record<string, unknown>,
  ) {
    logSecurityEvent(this.logger, {
      enabled: this.loggingConfig.securityLogOn,
      securityEvent,
      statusCode: 200,
      userId,
      metadata,
    });
  }

  private throwInvalid(): never {
    throw new NotFoundException({
      message: '登录验证请求无效，请重新登录',
      errorCode: AuthErrorCode.LoginChallengeInvalid,
    });
  }

  private throwExpired(): never {
    throw new ForbiddenException({
      message: '验证码已失效，请重新发起验证',
      errorCode: AuthErrorCode.LoginChallengeExpired,
    });
  }

  private throwRejected(): never {
    throw new ForbiddenException({
      message: '登录请求已被受信任设备拒绝',
      errorCode: AuthErrorCode.LoginChallengeRejected,
    });
  }

  private throwLocked(): never {
    throw new ForbiddenException({
      message: '验证码错误次数过多，本次验证已作废，请重新发起',
      errorCode: AuthErrorCode.LoginChallengeLocked,
    });
  }
}

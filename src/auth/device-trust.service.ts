import { withDatabaseWorkBudget } from '../utils/database-work-budget';
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { createHash, randomInt } from 'crypto';
import * as argon2 from 'argon2';
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
/** 同一账号、同一来源 IP 在窗口内最多发起几次验证（防「弹窗轰炸」骗点同意）。 */
export const LOGIN_CHALLENGE_RATE_LIMIT = 5;
/** 账号级总量（所有来源 IP 合计）。 */
export const LOGIN_CHALLENGE_ACCOUNT_RATE_LIMIT = 20;
export const LOGIN_CHALLENGE_RATE_WINDOW_MS = 10 * 60 * 1000;
/** 超过这个年龄的验证请求在新建时顺手清掉，定时清理也按这个口径。 */
export const LOGIN_CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;
/**
 * 登录安全码兜底的账号级额度：24 小时内该账号所有验证单累计输错（验证码 + 安全码）
 * 达到这个数，就不再接受安全码，只能等受信任设备批准。安全码可能只有 4 位，
 * 不能靠「每单 5 次 × 每 10 分钟 20 单」这种上限挡住穷举；也不能复用应用锁的
 * 错误计数——那样只知道密码的人就能把本人手机的应用锁锁住。
 */
export const LOGIN_CHALLENGE_SECURITY_CODE_DAILY_FAILURES = 10;
/**
 * 找回等待期：受信任设备全都用不了（唯一的手机重装 / 丢失 / 恢复出厂）时，新设备申请后
 * 要等这么久，期间所有受信任设备都会收到提醒并能拒绝。只知道密码的人也能申请，所以
 * 这段时间就是本人发现并拒绝的窗口——不能太短。
 */
export const LOGIN_RECOVERY_DELAY_MS = 24 * 60 * 60 * 1000;
/** 等待期结束后，在同一台设备上用密码登录完成找回的期限。 */
export const LOGIN_RECOVERY_COMPLETION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 同一账号同时进行中的找回申请上限（别人抢先占满会挡住本人，所以不设成 1）。 */
export const LOGIN_RECOVERY_MAX_ACTIVE = 3;
/**
 * 应用关闭时最多等在途的登录提醒推送这么久。推送只是加速通道（受信任设备回到
 * 前台会自己拉待处理请求），不能为它拖住发版切流；但也别在发出去的半路上把进程
 * 关掉。容器没配 stop_grace_period，Docker 默认 10 秒后 SIGKILL，聊天推送的
 * flush、连接池关闭、HTTP 收尾和 Sentry flush 都在这 10 秒里，所以只给它 2 秒。
 */
export const LOGIN_ALERT_SHUTDOWN_GRACE_MS = 2_000;
/** 锁内只做一次令牌查询；这个上限只防锁被别的认证事务长时间占住。 */
const LOGIN_ALERT_LOCK_TX_TIMEOUT_MS = 10_000;

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

function truncate(value: string | null | undefined, max: number) {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

export type LoginChallengeView = {
  id: string;
  expiresAt: Date;
  securityCodeAvailable: boolean;
  /** 已申请找回时的可完成时间；没申请为 null。 */
  recoveryAvailableAt: Date | null;
};

export type LoginDecision =
  | { kind: 'trusted' }
  | { kind: 'challenge'; challenge: LoginChallengeView }
  /** 找回等待期已过：验证单已被领取（CONSUMED），调用方完成找回并发 token。 */
  | { kind: 'recovered'; challengeId: string };

export type PendingLoginChallenge = {
  id: string;
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: 'PENDING' | 'APPROVED';
  recoveryAvailableAt: Date | null;
};

export type LoginChallengePublicStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CONSUMED';

@Injectable()
export class DeviceTrustService implements OnModuleDestroy {
  private readonly logger = new Logger(DeviceTrustService.name);
  private readonly loggingConfig = createLoggingConfig();
  /** 后台发出、尚未结束的登录提醒推送；onModuleDestroy 在连接池关闭前收尾。 */
  private readonly pendingPushes = new Set<Promise<void>>();
  private shuttingDown = false;

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
        // 受信任设备能登录 = 本人设备就在手边，能直接批准，进行中的找回一律取消。
        await this.cancelRecoveriesForActiveDevice(user.id, deviceKey);
        return { kind: 'trusted' };
      }
    }

    if (await this.isFirstDevice(user.id, now)) {
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

    // 找回等待期已过：这次密码登录就是完成找回的那一步（密码刚核对过）。
    const recovered = await this.claimMaturedRecovery(user.id, deviceKey, now);
    if (recovered) return { kind: 'recovered', challengeId: recovered };

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
      select: {
        id: true,
        userId: true,
        status: true,
        deviceName: true,
        expiresAt: true,
        codeExpiresAt: true,
        recoveryAvailableAt: true,
      },
    });
    if (reusable) {
      await this.reopenIfCodeExpired(reusable, now);
      return {
        kind: 'challenge',
        challenge: {
          id: reusable.id,
          expiresAt: reusable.expiresAt,
          securityCodeAvailable,
          recoveryAvailableAt: reusable.recoveryAvailableAt,
        },
      };
    }

    const challenge = await this.createChallenge(user.id, deviceKey, context);
    return {
      kind: 'challenge',
      challenge: {
        ...challenge,
        securityCodeAvailable,
        recoveryAvailableAt: null,
      },
    };
  }

  /** 验证码过期后新设备重新发起：沿用原请求的设备信息，计入频率限制。 */
  async resend(
    challengeId: string,
    deviceKey: string | null,
  ): Promise<LoginChallengeView> {
    const owner = await this.findForDevice(challengeId, deviceKey);
    return withDatabaseWorkBudget(this.prisma, () =>
      this.prisma.$transaction(
        async (tx) => {
          // $executeRaw：pg_advisory_xact_lock 返回 void，$queryRaw 反序列化不了（P2010 → 500）。
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth_session:${owner.userId}`}, 0))`;
          return this.resendLocked(challengeId, deviceKey);
        },
        { maxWait: 10000, timeout: 30000 },
      ),
    );
  }

  private async resendLocked(
    challengeId: string,
    deviceKey: string | null,
  ): Promise<LoginChallengeView> {
    const previous = await this.findForDevice(challengeId, deviceKey);
    const now = new Date();
    const status = this.publicStatus(previous, now);
    if (status === 'REJECTED') this.throwRejected();
    if (status === 'CONSUMED') this.throwInvalid();
    if (status !== 'EXPIRED') {
      // 批准过、但 60 秒的码已过期：退回待批准并重新通知，否则要干等到 5 分钟窗口结束。
      await this.reopenIfCodeExpired(previous, now);
      // 还在窗口里就不新建，直接沿用。
      return {
        id: previous.id,
        expiresAt: previous.expiresAt,
        securityCodeAvailable: await this.hasSecurityCode(previous.userId),
        recoveryAvailableAt: previous.recoveryAvailableAt,
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
      recoveryAvailableAt: null,
    };
  }

  /**
   * 新设备：账号下的受信任设备全都用不了时申请找回。等待期后在同一台设备上用密码
   * 登录即可完成；期间所有受信任设备收到提醒并能拒绝，改密 / 全部退出等也会取消。
   * 重复申请幂等（返回原来的可完成时间）。
   */
  async requestRecovery(
    challengeId: string,
    deviceKey: string | null,
  ): Promise<LoginChallengeView> {
    const owner = await this.findForDevice(challengeId, deviceKey);
    return withDatabaseWorkBudget(this.prisma, () =>
      this.prisma.$transaction(
        async (tx) => {
          // $executeRaw：pg_advisory_xact_lock 返回 void，$queryRaw 反序列化不了（P2010 → 500）。
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth_session:${owner.userId}`}, 0))`;
          return this.requestRecoveryLocked(challengeId, deviceKey);
        },
        { maxWait: 10000, timeout: 30000 },
      ),
    );
  }

  private async requestRecoveryLocked(
    challengeId: string,
    deviceKey: string | null,
  ): Promise<LoginChallengeView> {
    const challenge = await this.findForDevice(challengeId, deviceKey);
    const now = new Date();
    const status = this.publicStatus(challenge, now);
    if (status === 'REJECTED') this.throwRejected();
    if (status === 'CONSUMED') this.throwInvalid();
    if (challenge.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) this.throwLocked();
    if (status === 'EXPIRED') this.throwExpired();
    const securityCodeAvailable = await this.hasSecurityCode(challenge.userId);
    if (challenge.recoveryAvailableAt) {
      return {
        id: challenge.id,
        expiresAt: challenge.expiresAt,
        securityCodeAvailable,
        recoveryAvailableAt: challenge.recoveryAvailableAt,
      };
    }

    const active = await this.prisma.loginChallenge.count({
      where: {
        userId: challenge.userId,
        recoveryAvailableAt: { not: null },
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        expiresAt: { gt: now },
      },
    });
    if (active >= LOGIN_RECOVERY_MAX_ACTIVE) {
      this.logSecurity('login_recovery_limited', challenge.userId, { active });
      throw new HttpException(
        {
          message: '找回申请过多，请等现有申请处理完后再试',
          errorCode: AuthErrorCode.LoginRecoveryLimited,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const recoveryAvailableAt = new Date(
      now.getTime() + LOGIN_RECOVERY_DELAY_MS,
    );
    const expiresAt = new Date(
      recoveryAvailableAt.getTime() + LOGIN_RECOVERY_COMPLETION_WINDOW_MS,
    );
    const updated = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challenge.id,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        recoveryAvailableAt: null,
        expiresAt: { gt: now },
        attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS },
      },
      data: { recoveryRequestedAt: now, recoveryAvailableAt, expiresAt },
    });
    if (updated.count !== 1) this.throwExpired();

    this.logSecurity('login_recovery_requested', challenge.userId, {
      challengeId: challenge.id,
    });
    // 让受信任设备弹出「是否是你本人」（列表里带可完成时间，能看出是找回申请）。
    this.realtime.broadcast(challenge.userId, {
      type: 'auth.login.challenge.created',
      payload: { challengeId: challenge.id, changedAt: now.toISOString() },
    });
    this.dispatchPush(
      challenge.userId,
      {
        title: '有设备在申请找回你的账号',
        body: `${challenge.deviceName ?? '一台新设备'} 申请在 24 小时后登录你的账号。如果不是你本人，请立即拒绝并修改密码。`,
        data: { type: 'auth.login.challenge', challengeId: challenge.id },
      },
      Math.floor(LOGIN_RECOVERY_DELAY_MS / 1000),
    );
    return {
      id: challenge.id,
      expiresAt,
      securityCodeAvailable,
      recoveryAvailableAt,
    };
  }

  /**
   * 等待期已过的找回申请：条件更新领取为 CONSUMED（与并发的拒绝 / 作废二选一），
   * 领到返回验证单 id，由调用方在同一把账号锁里完成找回。
   */
  private async claimMaturedRecovery(
    userId: string,
    deviceKey: string,
    now: Date,
  ): Promise<string | null> {
    const matured = await this.prisma.loginChallenge.findFirst({
      where: {
        userId,
        deviceKey,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        recoveryAvailableAt: { lte: now },
        expiresAt: { gt: now },
        attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS },
      },
      orderBy: { recoveryAvailableAt: 'asc' },
      select: { id: true },
    });
    if (!matured) return null;
    const claimed = await this.prisma.loginChallenge.updateMany({
      where: {
        id: matured.id,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        recoveryAvailableAt: { lte: now },
        expiresAt: { gt: now },
      },
      data: {
        status: LoginChallengeStatus.CONSUMED,
        codeHash: null,
        codeExpiresAt: null,
        decidedAt: now,
      },
    });
    return claimed.count === 1 ? matured.id : null;
  }

  /**
   * 受信任设备在用（登录 / 续签）：本人能直接批准，别的设备发起的找回一律取消。
   * 只知道密码的人发起找回后，只要本人的手机还在正常使用，就不会等到期自动登录。
   */
  async cancelRecoveriesForActiveDevice(
    userId: string,
    activeDeviceKey: string,
  ): Promise<void> {
    const cancelled = await this.prisma.loginChallenge.updateManyAndReturn({
      where: {
        userId,
        deviceKey: { not: activeDeviceKey },
        recoveryAvailableAt: { not: null },
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
      select: { id: true },
    });
    for (const { id } of cancelled) {
      this.broadcastResolved(userId, id, 'REJECTED');
    }
    if (cancelled.length > 0) {
      this.logSecurity('login_recoveries_cancelled_by_trusted_device', userId, {
        count: cancelled.length,
      });
    }
  }

  /**
   * 找回完成中途失败时调用：把刚领取（CONSUMED）的找回退回 PENDING，重试可以再次领取。
   * 只认找回单（recoveryAvailableAt 非空），不会把普通验证单「复活」。尽力而为。
   */
  async releaseRecoveryClaim(challengeId: string): Promise<void> {
    try {
      await this.prisma.loginChallenge.updateMany({
        where: {
          id: challengeId,
          status: LoginChallengeStatus.CONSUMED,
          recoveryAvailableAt: { not: null },
        },
        data: { status: LoginChallengeStatus.PENDING, decidedAt: null },
      });
    } catch (error) {
      this.logger.warn(
        `release recovery claim failed for ${challengeId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** 找回完成后的通知（只走实时通道：此时其他设备的信任和会话马上被撤销）。 */
  logRecoveryCompleted(userId: string, challengeId: string) {
    this.logSecurity('login_recovery_completed', userId, { challengeId });
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
        // 只问还没人处理过的：批准的那台设备自己握着验证码，别的设备不必再问。
        status: LoginChallengeStatus.PENDING,
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
        recoveryAvailableAt: true,
      },
    });
    return rows.map((row) => ({ ...row, status: 'PENDING' as const }));
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
    const pending = await this.prisma.loginChallenge.findFirst({
      where: {
        id: challengeId,
        userId,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    if (!pending) this.throwExpired();
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
        codeHash: await argon2.hash(`${challengeId}:${code}`),
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
    recoveryAvailableAt: Date | null;
  }> {
    const challenge = await this.findForDevice(challengeId, deviceKey);
    return {
      status: this.publicStatus(challenge, new Date()),
      expiresAt: challenge.expiresAt,
      codeExpiresAt: challenge.codeExpiresAt,
      recoveryAvailableAt: challenge.recoveryAvailableAt,
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

    const reserved = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challenge.id,
        status: LoginChallengeStatus.APPROVED,
        codeHash: challenge.codeHash,
        codeExpiresAt: { gt: now },
        attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count !== 1) this.throwLocked();
    if (
      !(await argon2
        .verify(challenge.codeHash, `${challenge.id}:${code}`)
        .catch(() => false))
    ) {
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
        // 并发猜码时，别的请求可能已把次数用完。
        attempts: { lte: LOGIN_CHALLENGE_MAX_ATTEMPTS },
      },
      data: {
        status: LoginChallengeStatus.CONSUMED,
        codeHash: null,
        attempts: { decrement: 1 },
      },
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
    if (challenge.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) this.throwLocked();
    if (status === 'EXPIRED') this.throwExpired();
    return challenge;
  }

  /**
   * 安全码输错：与验证码共用这张验证单的次数上限（条件自增，并发也越不过去）。
   * 安全码可能只有 4 位，不能只靠账号级的锁。
   */
  async registerSecurityCodeFailure(challengeId: string): Promise<void> {
    const [counted] = await this.prisma.loginChallenge.updateManyAndReturn({
      where: {
        id: challengeId,
        attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    // 与验证码路径一致：这一次正好用完次数就直接回「已作废」，新设备立刻切到重新发起。
    if (!counted || counted.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS) {
      this.throwLocked();
    }
  }

  async consumeAfterSecurityCode(challengeId: string): Promise<void> {
    const consumed = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challengeId,
        status: {
          in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
        },
        expiresAt: { gt: new Date() },
        attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS },
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
    this.dispatchPush(userId, {
      title: '新设备已登录',
      body: `你的账号已在 ${context.deviceName ?? '新设备'} 上登录。如果不是你本人，请立即在「登录设备管理」中移除并修改密码。`,
      data: { type: 'auth.login.device.added' },
    });
  }

  /** 通过验证 / 首台设备：记为受信任（含恢复此前撤销的信任）。 */
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

  /**
   * 注册 / 续签时的尽力而为补记（上线迁移靠这条）：只在这台设备从没有记录时新建，
   * 绝不恢复已撤销的信任 —— 否则在设备管理里移除的设备，凭另一条没撤掉的会话续签
   * 一次就「复活」了。任何错误都不能挡住续签。
   */
  async trustOnRefresh(
    userId: string,
    deviceKey: string | null,
    context: SessionContext,
  ): Promise<void> {
    if (!deviceKey) return;
    try {
      const now = new Date();
      const existing = await this.prisma.trustedDevice.findUnique({
        where: { userId_deviceKey: { userId, deviceKey } },
        select: { revokedAt: true },
      });
      if (existing) {
        if (!existing.revokedAt) {
          await this.touch(userId, deviceKey, context, now);
        }
        return;
      }
      await this.prisma.trustedDevice.create({
        data: {
          userId,
          deviceKey,
          deviceName: truncate(context.deviceName, MAX_DEVICE_NAME_LENGTH),
          lastIp: truncate(context.ip, MAX_IP_LENGTH),
          lastSeenAt: now,
        },
      });
    } catch (error) {
      this.logger.warn(
        `trustOnRefresh failed for ${userId}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /** 设备管理里移除某台设备：撤销它的信任，下次登录要重新验证。 */
  async listDetachedDevices(userId: string) {
    const devices = await this.prisma.$queryRaw<
      Array<{
        id: string;
        deviceName: string | null;
        lastIp: string | null;
        createdAt: Date;
        lastSeenAt: Date;
      }>
    >`SELECT d."id", d."deviceName", d."lastIp", d."createdAt", d."lastSeenAt" FROM "TrustedDevice" d WHERE d."userId" = ${userId} AND d."revokedAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "RefreshToken" r WHERE r."userId" = d."userId" AND r."deviceKey" = d."deviceKey" AND r."revokedAt" IS NULL AND r."expiredAt" > NOW()) ORDER BY d."lastSeenAt" DESC, d."id" DESC LIMIT 100`;
    return devices.map((d) => ({
      id: d.id,
      deviceName: d.deviceName,
      ip: d.lastIp,
      userAgent: null,
      createdAt: d.createdAt,
      lastUsedAt: d.lastSeenAt,
      expiredAt: d.lastSeenAt,
      trustedOnly: true,
    }));
  }

  async deviceKeyForRecord(
    userId: string,
    recordId: string,
  ): Promise<string | null> {
    const record = await this.prisma.trustedDevice.findFirst({
      where: { id: recordId, userId, revokedAt: null },
      select: { deviceKey: true },
    });
    return record?.deviceKey ?? null;
  }

  async revokeDevice(userId: string, deviceKey: string | null): Promise<void> {
    if (!deviceKey) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.trustedDevice.updateMany({
        where: { userId, deviceKey, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.devicePushToken.updateMany({
        where: { userID: userId, deviceKey, disabledAt: null },
        data: { disabledAt: new Date() },
      });
    });
  }

  /** 退出其他设备：除当前设备外全部撤销信任。 */
  async revokeOtherDevices(
    userId: string,
    keepDeviceKey: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.trustedDevice.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(keepDeviceKey ? { deviceKey: { not: keepDeviceKey } } : {}),
        },
        data: { revokedAt: new Date() },
      });
      await tx.devicePushToken.updateMany({
        where: {
          userID: userId,
          disabledAt: null,
          ...(keepDeviceKey
            ? {
                OR: [
                  { deviceKey: { not: keepDeviceKey } },
                  { deviceKey: null },
                ],
              }
            : {}),
        },
        data: { disabledAt: new Date() },
      });
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

  /**
   * 「首台设备」= 没有任何受信任设备，并且也没有仍然有效的 APP 会话。
   * 后半句堵住上线窗口：老账号还没有信任记录，但本人手机上的旧会话还活着 ——
   * 这时直接放行，拿到密码的人就抢先成了受信任设备。本人设备续签一次即补记信任，
   * 之后就能批准；全部会话都已失效的账号才按首台设备处理。
   */
  private async isFirstDevice(userId: string, now: Date): Promise<boolean> {
    const trustedCount = await this.prisma.trustedDevice.count({
      where: { userId, revokedAt: null },
    });
    if (trustedCount > 0) return false;
    const liveSessions = await this.prisma.refreshToken.count({
      where: {
        userId,
        audience: 'APP',
        revokedAt: null,
        expiredAt: { gt: now },
      },
    });
    return liveSessions === 0;
  }

  private async createChallenge(
    userId: string,
    deviceKey: string,
    context: SessionContext,
  ): Promise<{ id: string; expiresAt: Date }> {
    const challenge = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const now = new Date();
      const windowStart = new Date(
        now.getTime() - LOGIN_CHALLENGE_RATE_WINDOW_MS,
      );
      const ip = truncate(context.ip, MAX_IP_LENGTH);
      // 按「账号 + 来源 IP」限：只知道密码的人刷满自己 IP 的额度，挡不住本人从别处
      // 登录；账号总量再兜一道，限制弹窗 / 推送轰炸。
      const [fromThisIp, total] = await Promise.all([
        tx.loginChallenge.count({
          where: { userId, ip, createdAt: { gt: windowStart } },
        }),
        tx.loginChallenge.count({
          where: { userId, createdAt: { gt: windowStart } },
        }),
      ]);
      if (
        fromThisIp >= LOGIN_CHALLENGE_RATE_LIMIT ||
        total >= LOGIN_CHALLENGE_ACCOUNT_RATE_LIMIT
      ) {
        this.logSecurity('login_challenge_rate_limited', userId, {
          fromThisIp,
          total,
        });
        throw new HttpException(
          {
            message: '验证请求过于频繁，请 10 分钟后再试',
            errorCode: AuthErrorCode.DeviceVerificationRateLimited,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return tx.loginChallenge.create({
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
    });
    const now = new Date();

    // 按过期时间清理：找回申请的有效期会延长到等待期之后，按创建时间清会在它
    // 刚能完成时就把它删掉。
    void this.prisma.loginChallenge
      .deleteMany({
        where: {
          userId,
          expiresAt: {
            lt: new Date(now.getTime() - LOGIN_CHALLENGE_RETENTION_MS),
          },
        },
      })
      .catch(() => undefined);

    this.logSecurity('login_challenge_created', userId, {
      challengeId: challenge.id,
    });
    this.notifyTrustedDevices(userId, challenge.id, context.deviceName, now);
    return challenge;
  }

  private notifyTrustedDevices(
    userId: string,
    challengeId: string,
    deviceName: string | null | undefined,
    now: Date,
  ) {
    this.realtime.broadcast(userId, {
      type: 'auth.login.challenge.created',
      payload: { challengeId, changedAt: now.toISOString() },
    });
    this.dispatchPush(userId, {
      title: '陌生设备登录验证',
      body: `${deviceName ?? '一台新设备'} 正在尝试登录你的账号，点击查看并确认是否是你本人。`,
      data: { type: 'auth.login.challenge', challengeId },
    });
  }

  /**
   * 批准后验证码已过期、决定窗口还开着：退回「待批准」并重新通知受信任设备。
   * 条件更新，并发的两次重发只有一次生效。
   */
  private async reopenIfCodeExpired(
    challenge: {
      id: string;
      userId: string;
      status: LoginChallengeStatus;
      deviceName: string | null;
      expiresAt: Date;
      codeExpiresAt: Date | null;
    },
    now: Date,
  ): Promise<void> {
    if (
      challenge.status !== LoginChallengeStatus.APPROVED ||
      !challenge.codeExpiresAt ||
      challenge.codeExpiresAt > now ||
      challenge.expiresAt <= now
    ) {
      return;
    }
    const reopened = await this.prisma.loginChallenge.updateMany({
      where: {
        id: challenge.id,
        status: LoginChallengeStatus.APPROVED,
        codeExpiresAt: { lte: now },
        expiresAt: { gt: now },
      },
      data: {
        status: LoginChallengeStatus.PENDING,
        codeHash: null,
        codeExpiresAt: null,
      },
    });
    if (reopened.count === 1) {
      this.logSecurity('login_challenge_reopened', challenge.userId, {
        challengeId: challenge.id,
      });
      this.notifyTrustedDevices(
        challenge.userId,
        challenge.id,
        challenge.deviceName,
        now,
      );
    }
  }

  /**
   * 改密 / 找回密码 / 全部退出 / 退出其他设备时调用：作废全部未完成的验证单。
   * 之前拿到过密码的人手里的验证单就此失效，重发也会被拒（REJECTED）。
   */
  async invalidateChallenges(userId: string): Promise<void> {
    const invalidated = await this.prisma.loginChallenge.updateManyAndReturn({
      where: {
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
      select: { id: true },
    });
    for (const { id } of invalidated) {
      this.broadcastResolved(userId, id, 'REJECTED');
    }
    if (invalidated.length > 0) {
      this.logSecurity('login_challenges_invalidated', userId, {
        count: invalidated.length,
      });
    }
  }

  /** Hold the account lock across budget checking, comparison and result recording. */
  async verifySecurityCodeFallback(
    challengeId: string,
    deviceKey: string | null,
    verify: () => Promise<boolean>,
  ): Promise<boolean> {
    const before = await this.findForDevice(challengeId, deviceKey);
    const outcome = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${before.userId} FOR UPDATE`;
        const challenge = await tx.loginChallenge.findUnique({
          where: { id: challengeId },
        });
        if (!challenge || challenge.deviceKey !== deviceKey)
          this.throwInvalid();
        const status = this.publicStatus(challenge, new Date());
        if (status === 'REJECTED') this.throwRejected();
        if (status === 'CONSUMED') this.throwInvalid();
        if (challenge.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS)
          this.throwLocked();
        if (status === 'EXPIRED') this.throwExpired();
        const failures = await tx.loginChallenge.aggregate({
          where: {
            userId: before.userId,
            createdAt: {
              gt: new Date(Date.now() - LOGIN_CHALLENGE_RETENTION_MS),
            },
          },
          _sum: { attempts: true },
        });
        if (
          (failures._sum.attempts ?? 0) >=
          LOGIN_CHALLENGE_SECURITY_CODE_DAILY_FAILURES
        )
          this.throwLocked();
        if (!(await verify())) {
          const [counted] = await tx.loginChallenge.updateManyAndReturn({
            where: {
              id: challengeId,
              attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS },
            },
            data: { attempts: { increment: 1 } },
            select: { attempts: true },
          });
          return !counted || counted.attempts >= LOGIN_CHALLENGE_MAX_ATTEMPTS
            ? 'locked'
            : 'invalid';
        }
        const consumed = await tx.loginChallenge.updateMany({
          where: {
            id: challengeId,
            status: {
              in: [LoginChallengeStatus.PENDING, LoginChallengeStatus.APPROVED],
            },
            attempts: { lt: LOGIN_CHALLENGE_MAX_ATTEMPTS },
          },
          data: { status: LoginChallengeStatus.CONSUMED, codeHash: null },
        });
        if (consumed.count !== 1) this.throwInvalid();
        return 'valid';
      },
      { maxWait: 10000, timeout: 10000 },
    );
    // Throw after committing the failed-attempt counter.
    if (outcome === 'locked') this.throwLocked();
    return outcome === 'valid';
  }

  /** 安全码兜底的账号级额度，超出即拒绝（只能等受信任设备批准）。 */
  async assertSecurityCodeFallbackBudget(userId: string): Promise<void> {
    const since = new Date(Date.now() - LOGIN_CHALLENGE_RETENTION_MS);
    const failures = await this.prisma.loginChallenge.aggregate({
      where: { userId, createdAt: { gt: since } },
      _sum: { attempts: true },
    });
    if (
      (failures._sum.attempts ?? 0) >=
      LOGIN_CHALLENGE_SECURITY_CODE_DAILY_FAILURES
    ) {
      this.logSecurity(
        'login_challenge_security_code_budget_exhausted',
        userId,
        {
          failures: failures._sum.attempts,
        },
      );
      this.throwLocked();
    }
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

  /**
   * 登录提醒是「发出去就不管」的后台任务：请求不等它，但要登记在案 ——
   * onModuleDestroy 据此在连接池关闭前等它收尾，关闭开始后也不再起新的。
   */
  private dispatchPush(
    userId: string,
    payload: { title: string; body: string; data: Record<string, unknown> },
    ttlSeconds?: number,
  ): void {
    if (this.shuttingDown) {
      // 关闭期间进来的请求不再推送；受信任设备回到前台照样能拉到待处理请求。
      this.logger.debug(
        `login alert push skipped during shutdown (${String(payload.data.type)})`,
      );
      return;
    }
    const task: Promise<void> = this.pushToUser(
      userId,
      payload,
      ttlSeconds,
    ).finally(() => this.pendingPushes.delete(task));
    this.pendingPushes.add(task);
  }

  /**
   * 等在途的登录提醒结束再让连接池关闭。AuthModule 和 PrismaModule 都是全局
   * 模块，Nest 对同一距离的模块按扫描顺序倒序调用 onModuleDestroy；AppModule
   * 先导入 PrismaModule 再导入 AuthModule，所以这里先跑
   * （src/auth/shutdown-order.spec.ts 钉住）。就算顺序哪天被打乱，连接池也只会
   * 等锁内那一次令牌查询，不会再被外部推送的 HTTP 拖住。等待有上限：推送服务
   * 卡住时照样关闭。
   */
  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.pendingPushes.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LOGIN_ALERT_SHUTDOWN_GRACE_MS);
    });
    await Promise.race([
      Promise.allSettled([...this.pendingPushes]),
      graceOver,
    ]);
    clearTimeout(timer);
    if (this.pendingPushes.size > 0) {
      this.logger.warn(
        `${this.pendingPushes.size} login alert push(es) still running after ${LOGIN_ALERT_SHUTDOWN_GRACE_MS}ms; shutting down without them`,
      );
    }
  }

  private async pushToUser(
    userId: string,
    payload: { title: string; body: string; data: Record<string, unknown> },
    ttlSeconds: number = Math.floor(LOGIN_CHALLENGE_DECISION_MS / 1000),
  ): Promise<void> {
    if (!this.push) return;
    const push = this.push;
    try {
      // 账号锁只罩住「谁还有资格收」这一次查询：与设备移除、推送地址注册串行，
      // 移除提交之后的提醒读不到被移除的设备（device-bound-push.e2e-spec）。
      // 发送是外部 HTTP，可能要好几秒，放在锁和事务之外 —— 否则这段时间这个用户
      // 的登录、刷新都排在锁后面，还占着一条连接，应用关闭也得等它。代价是读完
      // 令牌、发出之前那一瞬间移除的设备仍可能收到这条提醒，等同于「移除前一刻
      // 发出的提醒」：它的会话已吊销，收到了也批准不了。
      const tokens = await withDatabaseWorkBudget(this.prisma, () =>
        this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth_session:${userId}`}, 0))`;
            return push.listLoginAlertTokens(userId, tx);
          },
          { maxWait: 10000, timeout: LOGIN_ALERT_LOCK_TX_TIMEOUT_MS },
        ),
      );
      if (tokens.length === 0) return;
      await push.sendToTokens(tokens, {
        ...payload,
        priority: 'high',
        ttl: ttlSeconds,
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

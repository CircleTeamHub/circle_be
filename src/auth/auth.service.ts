import { withDatabaseWorkBudget } from '../utils/database-work-budget';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { EmailVerificationService } from './email-verification.service';
import {
  generateUniqueAccountId,
  generateUniqueRegistrationCode,
  isAccountIdentifierClaimCollision,
  isRegistrationCodeUniqueCollision,
  REGISTRATION_CODE_MAX_ATTEMPTS,
} from './account-id.unique';
import { normalizeEmail } from 'src/utils/email';
import {
  AuthErrorCode,
  FancyNumberErrorCode,
} from 'src/common/app-error-codes';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_ID_RULE_MESSAGE,
} from 'src/utils/account-id';
import {
  RefreshTokenAudience,
  RefreshTokenService,
  ReplayedRotation,
  SessionContext,
} from './refresh-token.service';
import { accessTokenTtlSeconds } from './session-revocation.service';
import { DeviceTrustService, LoginChallengeView } from './device-trust.service';
import { ConfigService } from '@nestjs/config';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { IconService } from 'src/icon/icon.service';
import { DisplayIconDto } from 'src/icon/dto/icon.dto';
import { USER_ME_SELECT } from 'src/user/user.select';
import { resolveEffectiveMembershipLevel } from 'src/membership/membership.catalog';
import { FancyNumberService } from 'src/fancy-number/fancy-number.service';
import {
  AvatarFramePublicAppearance,
  AvatarFrameService,
} from 'src/avatar-frame/avatar-frame.service';
import { lockFancyNumberUser } from 'src/fancy-number/fancy-number-user-lock';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import {
  buildPendingReferralData,
  readReferralRules,
  type ReferralRules,
} from 'src/referral/referral.rules';
import { logSecurityEvent } from 'src/logging/security-event.logger';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import { withSavepoint } from 'src/utils/prisma-savepoint';

const ME_SELECT = USER_ME_SELECT;

// lastOnline 只喂「N 分钟前在线」和管理台的活跃统计,分钟级精度足够:同一账号
// 60 秒内最多写一次。它在 User_lastOnline_idx 里,每次写都不是 HOT 更新,User 表
// 的十几个索引都要写新条目;me() 每次打开 App 都会调。
const LAST_ONLINE_WRITE_INTERVAL_MS = 60_000;

// 管理台按账号锁定（#83）：与 securityCode 锁定同款参数量级。
// 5 次错密码 → 锁 15 分钟；成功登录清零。只对 role=ADMIN 账号生效。
const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
const ADMIN_LOGIN_LOCK_MINUTES = 15;
// 管理台 access token 缩短（#91 目标 5-15 分钟）；可用 ADMIN_JWT_EXPIRES_IN 覆盖。
const DEFAULT_ADMIN_JWT_EXPIRES_IN = '15m';
const SECURITY_CODE_PATTERN = /^\d{4,6}$/;
// Persistent per-account lockout for security-code verification. Backs up the
// per-IP rate limiter so a distributed / IP-rotating attacker still can't
// brute-force a 4-6 digit code.
const MAX_SECURITY_CODE_ATTEMPTS = 5;
const SECURITY_CODE_LOCK_MS = 15 * 60 * 1000;

function assertValidSecurityCode(value: string, fieldName = 'securityCode') {
  if (!SECURITY_CODE_PATTERN.test(value)) {
    throw new BadRequestException({
      message: `${fieldName} 必须为4-6位数字`,
      errorCode: AuthErrorCode.SecurityCodeFormat,
    });
  }
}

function loginIdentifier(dto: LoginDto): string {
  return dto.identifier?.trim() || dto.email?.trim() || '';
}

/**
 * 续签事务的结局。会让请求失败的分支不在事务里抛:它们的写入(重放整族吊销、
 * 封禁 / ADMIN 全部吊销)必须提交,提交后再写 Redis 吊销标记、抛出原来的错误。
 */
type RefreshOutcome =
  | ReplayedRotation
  | { kind: 'missing' }
  | { kind: 'blocked'; userId: string; error: ForbiddenException }
  | {
      kind: 'issued';
      userId: string;
      tokens: { accessToken: string; refreshToken: string };
      cancelledRecoveries: string[];
    };

export type SafeUser = {
  id: string;
  accountId: string;
  inviteCode: string;
  nickname: string;
  avatarUrl: string | null;
  avatarFrame: string | null;
  avatarFrameAppearance: AvatarFramePublicAppearance | null;
  cover: string | null;
  email: string | null;
  phoneNumber: string | null;
  wechat: string | null;
  qq: string | null;
  whatsup: string | null;
  persona: string | null;
  helloWords: string | null;
  birthday: Date | null;
  gender: string;
  city: string | null;
  region: string | null;
  vipLevel: number;
  vipExpiresAt: Date | null;
  creditScore: number;
  receivedLikeCount: number;
  role: string;
  status: string;
  lastOnline: Date | null;
  createdAt: Date;
  updatedAt: Date;
  displayIcons: DisplayIconDto[];
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly loggingConfig = createLoggingConfig();
  private readonly referralRules: ReferralRules;

  constructor(
    private prisma: PrismaService,
    private refreshTokenService: RefreshTokenService,
    private jwt: JwtService,
    private iconService: IconService,
    private emailVerification: EmailVerificationService,
    private configService: ConfigService,
    private fancyNumberService: FancyNumberService,
    private avatarFrames: AvatarFrameService,
    private deviceTrust: DeviceTrustService,
  ) {
    this.referralRules = readReferralRules(configService);
  }

  async register(dto: RegisterDto, sessionContext?: SessionContext) {
    const email = normalizeEmail(dto.email);

    if (dto.password !== dto.confirmPassword) {
      throw new BadRequestException({
        message: '两次输入的密码不一致',
        errorCode: AuthErrorCode.PasswordMismatch,
      });
    }

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ConflictException({
        message: '该邮箱已注册',
        errorCode: AuthErrorCode.EmailTaken,
      });
    }

    const normalizedInviteCode = dto.inviteCode?.trim().toUpperCase() || null;
    const inviter = normalizedInviteCode
      ? await this.prisma.user.findUnique({
          where: { inviteCode: normalizedInviteCode },
          select: { id: true, status: true },
        })
      : null;
    const campaign =
      normalizedInviteCode && !inviter
        ? await this.prisma.campaignInvite.findUnique({
            where: { code: normalizedInviteCode },
            select: {
              id: true,
              enabled: true,
              expiresAt: true,
              maxUses: true,
              usedCount: true,
              owner: { select: { id: true, status: true, role: true } },
            },
          })
        : null;
    const campaignUsable =
      campaign &&
      campaign.enabled &&
      campaign.expiresAt > new Date() &&
      campaign.usedCount < campaign.maxUses &&
      campaign.owner.status === 'ACTIVE' &&
      campaign.owner.role !== 'ADMIN';
    if (
      normalizedInviteCode &&
      (!inviter || inviter.status !== 'ACTIVE') &&
      !campaignUsable
    ) {
      throw new BadRequestException({
        message: '邀请码无效',
        errorCode: AuthErrorCode.InviteCodeInvalid,
      });
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.createRegisteredUser(
      {
        passwordHash,
        nickname: dto.nickname,
        email,
        ...(inviter
          ? { invitedByUserId: inviter.id }
          : campaignUsable
            ? { invitedByUserId: campaign.owner.id }
            : {}),
      },
      campaignUsable ? campaign.id : undefined,
    );

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_register_success',
      actorId: user.id,
      result: 'success',
      entityType: 'user',
      entityId: user.id,
    });

    return this.withAccountAuthLock(user.id, async () => {
      if (sessionContext?.deviceKey)
        await this.deviceTrust.trust(
          user.id,
          sessionContext.deviceKey,
          sessionContext,
        );
      return this.issueTokens(
        user.id,
        user.accountId,
        user.role,
        sessionContext,
      );
    });
  }

  async login(dto: LoginDto, sessionContext?: SessionContext) {
    const identifier = loginIdentifier(dto);
    let where: Prisma.UserWhereUniqueInput | null = null;
    if (identifier.includes('@')) {
      where = { email: normalizeEmail(identifier) };
    } else if (ACCOUNT_ID_PATTERN.test(identifier)) {
      where = { accountId: identifier.toLowerCase() };
    }
    const user = where ? await this.prisma.user.findUnique({ where }) : null;

    // Use the same error for "no such user" and "inactive user" so the
    // endpoint cannot be used as an account-enumeration oracle. The actual
    // reason is logged server-side for ops debugging.
    if (!user || user.status !== 'ACTIVE') {
      if (user && user.status !== 'ACTIVE') {
        this.logger.warn(
          `Login attempt for non-active account ${user.id} (status=${user.status})`,
        );
      }
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_login_failed',
        actorId: user?.id,
        result: 'failure',
        metadata: {
          reason: user ? 'inactive_account' : 'invalid_credentials',
        },
      });
      throw new ForbiddenException({
        message: '邮箱、用户ID或密码错误',
        errorCode: AuthErrorCode.InvalidCredentials,
      });
    }

    // round 3 review（P1）：ADMIN 账号整体拒绝走普通登录 —— 即使密码正确，
    // 这里发出的是 APP audience 的长 TTL 会话，而任何只看 role、不看 audience
    // 的授权判断都会把它当成管理员，等于绕开短 TTL/审计的管理会话模型。
    // 管理台请走 /auth/admin/login。对外文案与普通失败一致（不泄露该邮箱是
    // 管理员）。锁定检查仍在其前（锁死期间不做密码比对）。
    const now = new Date();
    if (this.isAdminLockedNow(user, now)) {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_login_failed',
        actorId: user.id,
        result: 'failure',
        metadata: { reason: 'account_locked' },
      });
      throw new ForbiddenException({
        message: '邮箱、用户ID或密码错误',
        errorCode: AuthErrorCode.InvalidCredentials,
      });
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      if (user.role === 'ADMIN') {
        const lockedNow = await this.registerAdminLoginFailure(user.id, now);
        if (lockedNow) {
          logBusinessEvent(this.logger, {
            enabled: this.loggingConfig.businessLogOn,
            businessEvent: 'auth_admin_login_locked',
            actorId: user.id,
            result: 'failure',
            metadata: { lockMinutes: ADMIN_LOGIN_LOCK_MINUTES, via: 'login' },
          });
        }
      }
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_login_failed',
        actorId: user.id,
        result: 'failure',
        metadata: { reason: 'invalid_credentials' },
      });
      throw new ForbiddenException({
        message: '邮箱、用户ID或密码错误',
        errorCode: AuthErrorCode.InvalidCredentials,
      });
    }

    if (user.role === 'ADMIN') {
      await this.resetAdminLockCounters(user);
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_login_failed',
        actorId: user.id,
        result: 'failure',
        metadata: { reason: 'admin_must_use_admin_login' },
      });
      throw new ForbiddenException({
        message: '邮箱、用户ID或密码错误',
        errorCode: AuthErrorCode.InvalidCredentials,
      });
    }

    return this.withAccountAuthLock(user.id, async () => {
      const current = await this.prisma.user.findUnique({
        where: { id: user.id },
      });
      if (
        !current ||
        current.passwordHash !== user.passwordHash ||
        current.status !== 'ACTIVE' ||
        current.role === 'ADMIN'
      ) {
        throw new ForbiddenException({
          message: '邮箱、用户ID或密码错误',
          errorCode: AuthErrorCode.InvalidCredentials,
        });
      }
      // 密码对了也不等于能进：陌生设备必须先经受信任设备批准（只发验证单号，不发 token）。
      const decision = await this.deviceTrust.evaluateLogin(
        current,
        sessionContext ?? {},
      );
      if (decision.kind === 'challenge') {
        logBusinessEvent(this.logger, {
          enabled: this.loggingConfig.businessLogOn,
          businessEvent: 'auth_login_device_verification_required',
          actorId: user.id,
          result: 'success',
          entityType: 'login_challenge',
          entityId: decision.challenge.id,
        });
        return this.deviceVerificationResponse(decision.challenge);
      }
      if (decision.kind === 'recovered') {
        try {
          return await this.completeRecoveryLogin(
            current,
            decision.challengeId,
            sessionContext ?? {},
          );
        } catch (error) {
          // 领取已提交、后续步骤中途失败：退回「可领取」，让重试从头完整执行一遍。
          // 否则要么白等 24 小时重来，要么新设备已被信任却没撤掉丢失设备的信任和会话。
          await this.deviceTrust.releaseRecoveryClaim(decision.challengeId);
          throw error;
        }
      }
      return this.finishLogin(current, sessionContext);
    });
  }

  private deviceVerificationResponse(challenge: LoginChallengeView) {
    return {
      deviceVerificationRequired: true as const,
      challenge: {
        id: challenge.id,
        expiresAt: challenge.expiresAt,
        securityCodeAvailable: challenge.securityCodeAvailable,
        recoveryAvailableAt: challenge.recoveryAvailableAt,
      },
    };
  }

  /** 新设备：受信任设备全都用不了时申请找回（等待期后在这台设备上用密码登录即可）。 */
  async requestLoginRecovery(challengeId: string, deviceKey: string | null) {
    const challenge = await this.deviceTrust.requestRecovery(
      challengeId,
      deviceKey,
    );
    return this.deviceVerificationResponse(challenge);
  }

  /**
   * 找回等待期已过、这次密码登录来自申请找回的那台设备（调用方已持有账号锁）。
   * 这台设备成为唯一的受信任设备：先发 token，再撤销其他会话（多半在丢了的手机上）、
   * 其他设备的信任和其余进行中的验证单。先发后撤：撤销会写吊销边界，同一毫秒内
   * 签发的新 token 会被误判为已吊销。
   */
  private async completeRecoveryLogin(
    user: {
      id: string;
      accountId: string;
      role: string;
      nickname: string;
      avatarUrl: string | null;
      singleDeviceLoginEnabled: boolean;
    },
    challengeId: string,
    sessionContext: SessionContext,
  ) {
    const deviceKey = sessionContext.deviceKey;
    if (!deviceKey) {
      throw new ForbiddenException({
        message: '登录验证请求无效，请重新登录',
        errorCode: AuthErrorCode.LoginChallengeInvalid,
      });
    }
    this.touchLastOnline(user.id);
    const { sessionId, ...tokens } = await this.issueTokensWithSession(
      user.id,
      user.accountId,
      user.role,
      sessionContext,
    );
    await this.refreshTokenService.revokeOtherSessions(user.id, sessionId);
    await this.deviceTrust.revokeOtherDevices(user.id, deviceKey);
    await this.deviceTrust.invalidateChallenges(user.id);
    // Only enroll trust after every cleanup step succeeds. A retry must still
    // enter the recovery path if revocation or challenge invalidation fails.
    await this.deviceTrust.trust(user.id, deviceKey, sessionContext);
    this.deviceTrust.logRecoveryCompleted(user.id, challengeId);
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_login_recovered',
      actorId: user.id,
      result: 'success',
      entityType: 'login_challenge',
      entityId: challengeId,
    });
    return tokens;
  }

  /** 新设备：受信任设备批准后输入验证码，通过即记为受信任并发 token。 */
  async verifyLoginChallengeCode(
    challengeId: string,
    code: string,
    sessionContext: SessionContext,
  ) {
    const pending = await this.deviceTrust.loadForSecurityCode(
      challengeId,
      sessionContext.deviceKey ?? null,
    );
    return this.withAccountAuthLock(pending.userId, async () => {
      const { userId, deviceKey } = await this.deviceTrust.consumeWithCode(
        challengeId,
        sessionContext.deviceKey ?? null,
        code,
      );
      return this.finishChallengeLogin(
        userId,
        challengeId,
        deviceKey,
        sessionContext,
      );
    });
  }

  /** 新设备：受信任设备不在身边时，改用登录安全码通过验证。 */
  async verifyLoginChallengeSecurityCode(
    challengeId: string,
    securityCode: string,
    sessionContext: SessionContext,
  ) {
    const challenge = await this.deviceTrust.loadForSecurityCode(
      challengeId,
      sessionContext.deviceKey ?? null,
    );
    return this.withAccountAuthLock(challenge.userId, async () => {
      assertValidSecurityCode(securityCode);
      const user = await this.prisma.user.findUnique({
        where: { id: challenge.userId },
        select: { loginSecurityCodeHash: true },
      });
      if (!user?.loginSecurityCodeHash) {
        throw new ForbiddenException({
          message: '未设置登录安全码，请在受信任设备上确认登录',
          errorCode: AuthErrorCode.SecurityCodeNotSet,
        });
      }
      // 这条路径没有登录态，绝不能动应用锁的错误计数（securityCodeAttempts /
      // securityCodeLockedUntil）：否则只知道密码的人能故意输错，把本人手机的应用锁
      // 锁住，锁住期间批准弹窗也被藏起来。改用验证单自己的计次 + 账号级每日额度。
      const ok = await this.deviceTrust.verifySecurityCodeFallback(
        challenge.id,
        sessionContext.deviceKey ?? null,
        () => argon2.verify(user.loginSecurityCodeHash, securityCode),
      );
      if (!ok) {
        throw new ForbiddenException({
          message: '安全码错误',
          errorCode: AuthErrorCode.SecurityCodeInvalid,
        });
      }
      return this.finishChallengeLogin(
        challenge.userId,
        challenge.id,
        challenge.deviceKey,
        sessionContext,
      );
    });
  }

  private async finishChallengeLogin(
    userId: string,
    challengeId: string,
    deviceKey: string,
    sessionContext: SessionContext,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    // 验证期间账号被封 / 升成管理员：与 login() 同一套拒绝口径。
    if (!user || user.status !== 'ACTIVE' || user.role === 'ADMIN') {
      throw new ForbiddenException({
        message: '邮箱、用户ID或密码错误',
        errorCode: AuthErrorCode.InvalidCredentials,
      });
    }
    await this.deviceTrust.completeVerifiedLogin(
      userId,
      challengeId,
      deviceKey,
      sessionContext,
    );
    return this.finishLogin(user, { ...sessionContext, deviceKey });
  }

  async resendLoginChallenge(challengeId: string, deviceKey: string | null) {
    const challenge = await this.deviceTrust.resend(challengeId, deviceKey);
    return this.deviceVerificationResponse(challenge);
  }

  /** ADMIN 账号当前是否处于登录锁定期。锁死期间不做密码比对。 */
  private isAdminLockedNow(
    user: { role: string; adminLoginLockedUntil: Date | null },
    now: Date,
  ): boolean {
    return (
      user.role === 'ADMIN' &&
      !!user.adminLoginLockedUntil &&
      user.adminLoginLockedUntil > now
    );
  }

  /**
   * ADMIN 错误密码计数（DB 原子 increment）+ 到阈值的条件上锁转换。
   * 返回是否由本次失败触发锁定。/auth/login 与 /auth/admin/login 共用 ——
   * review 修复（round 2 P1）：普通登录路径也接受 ADMIN 账号，不共用计数的
   * 话攻击者换条路就能无限撞库，锁定形同虚设。
   */
  private async registerAdminLoginFailure(
    userId: string,
    now: Date,
  ): Promise<boolean> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { adminLoginAttempts: { increment: 1 } },
    });
    const locked = await this.prisma.user.updateMany({
      where: {
        id: userId,
        adminLoginAttempts: { gte: ADMIN_LOGIN_MAX_ATTEMPTS },
      },
      data: {
        adminLoginAttempts: 0,
        adminLoginLockedUntil: new Date(
          now.getTime() + ADMIN_LOGIN_LOCK_MINUTES * 60_000,
        ),
      },
    });
    return locked.count > 0;
  }

  /** 成功登录清零计数（只在有残留时写库，避免每次登录白写一行）。 */
  private async resetAdminLockCounters(user: {
    id: string;
    adminLoginAttempts: number;
    adminLoginLockedUntil: Date | null;
  }): Promise<void> {
    if (user.adminLoginAttempts !== 0 || user.adminLoginLockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { adminLoginAttempts: 0, adminLoginLockedUntil: null },
      });
    }
  }

  private adminLoginWhere(dto: LoginDto): Prisma.UserWhereUniqueInput {
    const identifier = loginIdentifier(dto);
    return identifier.includes('@')
      ? { email: normalizeEmail(identifier) }
      : { accountId: identifier.toLowerCase() };
  }

  async adminLogin(dto: LoginDto, sessionContext?: SessionContext) {
    const target = await this.prisma.user.findUnique({
      where: this.adminLoginWhere(dto),
      select: { id: true, accountId: true, role: true },
    });
    try {
      const login = await this.performAdminLogin(dto, sessionContext);
      try {
        await this.prisma.adminAuditLog.create({
          data: {
            actorID: login.userId,
            actorAccountId: login.accountId,
            action: 'admin.login.success',
            entityType: 'admin_session',
            ip: sessionContext?.ip?.slice(0, 64),
            userAgent: sessionContext?.userAgent?.slice(0, 256),
          },
        });
      } catch {
        this.logger.warn('Admin login success audit unavailable');
      }
      return login.tokens;
    } catch (error) {
      try {
        await this.prisma.adminAuditLog.create({
          data: {
            actorID: target?.role === 'ADMIN' ? target.id : 'anonymous',
            action: 'admin.login.failed',
            entityType: 'admin_session',
            ip: sessionContext?.ip?.slice(0, 64),
            userAgent: sessionContext?.userAgent?.slice(0, 256),
          },
        });
      } catch {
        this.logger.warn('Admin login audit unavailable');
      }
      throw error;
    }
  }

  private async performAdminLogin(
    dto: LoginDto,
    sessionContext?: SessionContext,
  ) {
    const user = await this.prisma.user.findUnique({
      where: this.adminLoginWhere(dto),
    });
    // 管理台事件必须可追溯来源（#90）：ip/userAgent 一律进 metadata。
    const adminAuditContext = {
      ip: sessionContext?.ip ?? null,
      userAgent: sessionContext?.userAgent ?? null,
    };

    if (!user || user.status !== 'ACTIVE') {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_admin_login_failed',
        actorId: user?.id,
        result: 'failure',
        metadata: {
          reason: user ? 'inactive_account' : 'invalid_credentials',
          ...adminAuditContext,
        },
      });
      throw new ForbiddenException('Invalid credentials or inactive account');
    }

    // 按账号锁定（#83）：admin 账号是唯一受保护对象 —— IP 限流挡不住分布式
    // 撞库，这里在账号维度兜底。锁定检查先于 argon2.verify，锁死期间不做
    // 密码比对（也顺带省掉被锁账号的 argon2 开销）。对外文案与其它失败一致，
    // 不泄露「已锁定」状态。
    const now = new Date();
    if (this.isAdminLockedNow(user, now)) {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_admin_login_failed',
        actorId: user.id,
        result: 'failure',
        metadata: { reason: 'account_locked', ...adminAuditContext },
      });
      throw new ForbiddenException('Invalid credentials or inactive account');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid || user.role !== 'ADMIN') {
      // 只有真正的 ADMIN 账号累计失败计数：对非 admin 账号计数会让任何人
      // 通过 adminLogin 刷别人的普通账号进锁定（DoS）。
      if (!valid && user.role === 'ADMIN') {
        // 原子计数 + 条件上锁（round 1 修复），与 /auth/login 共用同一辅助。
        const lockedNow = await this.registerAdminLoginFailure(user.id, now);
        if (lockedNow) {
          logBusinessEvent(this.logger, {
            enabled: this.loggingConfig.businessLogOn,
            businessEvent: 'auth_admin_login_locked',
            actorId: user.id,
            result: 'failure',
            metadata: {
              lockMinutes: ADMIN_LOGIN_LOCK_MINUTES,
              ...adminAuditContext,
            },
          });
        }
      }
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_admin_login_failed',
        actorId: user.id,
        result: 'failure',
        metadata: {
          reason: valid ? 'insufficient_role' : 'invalid_credentials',
          ...adminAuditContext,
        },
      });
      throw new ForbiddenException('Invalid credentials or inactive account');
    }

    const consoleAccess = await this.prisma.adminAccess.findUnique({
      where: { userID: user.id },
      select: { role: true },
    });
    if (!consoleAccess)
      throw new ForbiddenException('管理员尚未分配权限，请联系超级管理员');
    await this.resetAdminLockCounters(user);

    this.touchLastOnline(user.id);

    const tokens = await this.issueTokens(
      user.id,
      user.accountId,
      user.role,
      sessionContext,
      {
        audience: 'ADMIN',
        expectedPasswordHash: user.passwordHash,
      },
    );

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_admin_login_success',
      actorId: user.id,
      result: 'success',
      entityType: 'user',
      entityId: user.id,
      metadata: adminAuditContext,
    });

    return { tokens, userId: user.id, accountId: user.accountId };
  }

  // All admission/session issuance and account recovery share this distributed lock.
  // It uses a dedicated advisory namespace. Most callers' nested services retain
  // their own transactions; refresh() does all of its work on the lock's tx.
  private withAccountAuthLock<T>(
    userId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return withDatabaseWorkBudget(this.prisma, () =>
      this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth_session:${userId}`}, 0))`;
          return operation(tx);
        },
        { maxWait: 10000, timeout: 30000 },
      ),
    );
  }

  /** 密码登录共用的收尾：lastOnline、发 token、记日志。 */
  private async finishLogin(
    user: {
      id: string;
      accountId: string;
      role: string;
      nickname: string;
      avatarUrl: string | null;
      singleDeviceLoginEnabled: boolean;
    },
    sessionContext?: SessionContext,
  ) {
    // Fire-and-forget: lastOnline is best-effort and must never block token issuance.
    this.touchLastOnline(user.id);

    const tokens = await this.issueTokens(
      user.id,
      user.accountId,
      user.role,
      sessionContext,
    );

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_login_success',
      actorId: user.id,
      result: 'success',
      entityType: 'user',
      entityId: user.id,
    });

    return tokens;
  }

  async refresh(refreshToken: string, sessionContext?: SessionContext) {
    const owner = await this.refreshTokenService.ownerForToken(
      refreshToken,
      'APP',
    );
    // 整个续签只用账号锁这一个事务、一个连接:原来轮换 / 查用户 / 记 access 过期 /
    // 设备信任各自走 this.prisma,外层连接全程 idle in transaction 干等。
    const outcome = await this.withAccountAuthLock(owner, (tx) =>
      this.refreshLocked(tx, refreshToken, owner, sessionContext),
    );
    switch (outcome.kind) {
      case 'reuse':
        return this.refreshTokenService.rejectReplayedRotation(outcome);
      case 'missing':
        throw new NotFoundException({
          message: '用户不存在',
          errorCode: AuthErrorCode.UserNotFound,
        });
      case 'blocked':
        // revokeAll 的 Redis 那一半:数据库吊销已随轮换一起提交。
        await this.refreshTokenService.revokeAllAccessMarkers(outcome.userId);
        throw outcome.error;
      case 'issued':
        this.deviceTrust.announceCancelledRecoveries(
          outcome.userId,
          outcome.cancelledRecoveries,
        );
        return outcome.tokens;
    }
  }

  /** refresh 在账号锁事务里的全部工作;所有读写都走 tx。 */
  private async refreshLocked(
    tx: Prisma.TransactionClient,
    refreshToken: string,
    owner: string,
    sessionContext: SessionContext | undefined,
  ): Promise<RefreshOutcome> {
    const rotation = await this.refreshTokenService.rotateInTransaction(
      tx,
      refreshToken,
      owner,
      sessionContext,
      'APP',
    );
    if (rotation.kind === 'reuse') return rotation;
    const {
      token: newRefreshToken,
      userId,
      sessionId,
      deviceKey,
      deviceName,
    } = rotation;

    // 下面只用到这四列:不再整行读回(含 passwordHash、安全码哈希等)。
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, accountId: true, role: true, status: true },
    });
    if (!user) return { kind: 'missing' };

    // Banned/deleted users must not be able to keep refreshing tokens just
    // because they still hold a valid refresh token. Revoke their sessions
    // and reject the rotation result.
    if (user.status !== 'ACTIVE') {
      this.logger.warn(
        `Refresh blocked for non-active user ${user.id} (status=${user.status}); revoking sessions.`,
      );
      await this.refreshTokenService.revokeAllInTransaction(tx, user.id);
      return {
        kind: 'blocked',
        userId: user.id,
        error: new ForbiddenException({
          message: '账号已被禁用',
          errorCode: AuthErrorCode.AccountDisabled,
        }),
      };
    }

    // 与 login() 一致：ADMIN 账号不能持有 APP audience 会话。晋升前签发的 APP
    // refresh token 否则会一直续签出 role=ADMIN 的 APP access token，而任何只看
    // role、不看 audience 的授权判断都会把它当成管理员，等于绕开短 TTL/审计的
    // 管理会话模型。像 adminRefresh 一样撤销全部会话；文案与普通登录失败一致
    // （不泄露该账号是管理员）。
    if (user.role === 'ADMIN') {
      this.logger.warn(
        `Refresh blocked for ADMIN account ${user.id} on the APP audience; revoking sessions.`,
      );
      await this.refreshTokenService.revokeAllInTransaction(tx, user.id);
      return {
        kind: 'blocked',
        userId: user.id,
        error: new ForbiddenException({
          message: '邮箱、用户ID或密码错误',
          errorCode: AuthErrorCode.InvalidCredentials,
        }),
      };
    }

    // Fire-and-forget: lastOnline is best-effort and must never block token issuance.
    this.touchLastOnline(user.id);

    const accessToken = await this.signAccessToken(
      user.id,
      user.accountId,
      user.role,
      sessionId,
      'APP',
      tx,
    );
    // 原来这里还有一次 assertSessionActive:那时轮换已在另一个连接上提交,签发前可能
    // 被并发吊销。现在新会话行是本事务刚插入、尚未提交的:别的事务看不见它,也就改
    // 不了它;expiredAt = 插入时 + TTL(最短 1 分钟)而事务上限 30 秒。这次读取恒为真。
    //
    // 持有有效会话的设备就是本人设备：功能上线前已登录的设备靠这条补记信任，
    // 免得一升级所有人都变成「陌生设备」。只认会话绑定的设备，不认请求头里新报的。
    // 续签请求不带设备名头：受信任记录沿用会话上登录时记下的设备名。
    const trusted = await this.deviceTrust.trustOnRefresh(
      user.id,
      deviceKey,
      {
        ...sessionContext,
        deviceName: sessionContext?.deviceName ?? deviceName,
      },
      tx,
    );
    const cancelledRecoveries = deviceKey
      ? await this.cancelRecoveriesOnRefresh(tx, user.id, deviceKey, trusted)
      : [];
    return {
      kind: 'issued',
      userId: user.id,
      tokens: { accessToken, refreshToken: newRefreshToken },
      cancelledRecoveries,
    };
  }

  /**
   * 受信任设备还在正常使用：别的设备发起的找回申请取消（本人能直接批准）。
   * 尽力而为：失败不能挡住续签（下一次续签 / 登录会再取消一次）。保存点让失败的
   * 语句只回滚这一步，续签事务照常提交。trusted 是信任补记的结论；补记出错（null）
   * 时退回原来那次独立的 isTrusted 判定。
   */
  private async cancelRecoveriesOnRefresh(
    tx: Prisma.TransactionClient,
    userId: string,
    deviceKey: string,
    trusted: boolean | null,
  ): Promise<string[]> {
    if (trusted === false) return [];
    try {
      return await withSavepoint(tx, 'refresh_recovery_cancel', async () =>
        (trusted ?? (await this.deviceTrust.isTrusted(userId, deviceKey, tx)))
          ? this.deviceTrust.cancelRecoveries(userId, deviceKey, tx)
          : [],
      );
    } catch (error) {
      this.logger.warn(
        `cancel recoveries on refresh failed for ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  async adminRefresh(refreshToken: string, sessionContext?: SessionContext) {
    const {
      token: newRefreshToken,
      userId,
      sessionId,
    } = await this.refreshTokenService.rotate(
      refreshToken,
      sessionContext,
      'ADMIN',
    );

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.status !== 'ACTIVE' || user.role !== 'ADMIN') {
      this.logger.warn(
        `Admin refresh blocked for user ${user.id} (status=${user.status}, role=${user.role}); revoking sessions.`,
      );
      await this.refreshTokenService.revokeAll(user.id);
      throw new ForbiddenException('Admin account is not active');
    }

    this.touchLastOnline(user.id);

    const accessToken = await this.signAccessToken(
      user.id,
      user.accountId,
      user.role,
      sessionId,
      'ADMIN',
    );
    await this.refreshTokenService.assertSessionActive(user.id, sessionId);
    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(
    refreshToken: string,
    sessionContext?: SessionContext,
  ): Promise<void> {
    const revoked = await this.refreshTokenService.revoke(refreshToken);
    // 管理台登出此前完全无痕（#90）：事后取证时连「会话何时结束」都答不上来。
    // 普通用户登出量大且低敏，保持不记；ADMIN 会话必须留痕。
    // review 修复（round 2）：带上 ip/userAgent/sessionId —— 没有来源信息，
    // 正常登出与「被盗 refresh token 在别处被撤销」在审计里无从区分。
    if (revoked?.audience === 'ADMIN') {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_admin_logout',
        actorId: revoked.userId,
        result: 'success',
        entityType: 'user',
        entityId: revoked.userId,
        metadata: {
          sessionId: revoked.sessionId,
          ip: sessionContext?.ip ?? null,
          userAgent: sessionContext?.userAgent ?? null,
        },
      });
    }
  }

  async sessions(userId: string, currentSessionId?: string) {
    const sessions = [
      ...(await this.refreshTokenService.listActiveSessions(userId)),
      ...(await this.deviceTrust.listDetachedDevices(userId)),
    ];
    return sessions.map((session) => ({
      ...session,
      isCurrent: currentSessionId ? session.id === currentSessionId : false,
    }));
  }

  async logoutAll(userId: string, currentSessionId?: string): Promise<void> {
    return this.withAccountAuthLock(userId, async () => {
      // 「全部退出」多半是怀疑被盗号：发起这一步的设备之外，全部撤销信任，
      // 进行中的陌生设备验证一并作废。
      await this.revokeTrustExceptSession(userId, currentSessionId);
      await this.deviceTrust.invalidateChallenges(userId);
      await this.refreshTokenService.revokeAll(userId);
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_logout_all_success',
        actorId: userId,
        result: 'success',
        entityType: 'user',
        entityId: userId,
      });
    });
  }

  async logoutSession(
    userId: string,
    sessionId: string,
    currentSessionId?: string,
  ): Promise<void> {
    return this.withAccountAuthLock(userId, async () => {
      // 在设备管理里移除 = 撤销信任：这台设备再登录要重新经受信任设备批准。
      const deviceKey =
        (await this.refreshTokenService.findSessionDeviceKey(
          userId,
          sessionId,
        )) ?? (await this.deviceTrust.deviceKeyForRecord(userId, sessionId));
      const currentDeviceKey = currentSessionId
        ? await this.refreshTokenService.findSessionDeviceKey(
            userId,
            currentSessionId,
          )
        : null;
      await this.refreshTokenService.revokeSessionFamily(userId, sessionId);
      // 移除的是「本机的另一条旧登录记录」时只撤那一条：不能连带撤掉当前会话和本机信任。
      if (deviceKey && deviceKey !== currentDeviceKey) {
        // 同一台设备可能有多条会话（重装、重复登录）：一起撤掉，否则剩下那条还能续签。
        await this.refreshTokenService.revokeDeviceSessions(userId, deviceKey);
        await this.deviceTrust.revokeDevice(userId, deviceKey);
        await this.deviceTrust.invalidateChallenges(userId);
      }
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_session_logout',
        actorId: userId,
        result: 'success',
        entityType: 'session',
        entityId: sessionId,
      });
    });
  }

  async logoutOtherSessions(
    userId: string,
    currentSessionId?: string,
  ): Promise<void> {
    return this.withAccountAuthLock(userId, async () => {
      const currentDeviceKey = currentSessionId
        ? await this.refreshTokenService.findSessionDeviceKey(
            userId,
            currentSessionId,
          )
        : null;
      await this.refreshTokenService.revokeOtherSessions(
        userId,
        currentSessionId,
      );
      // 「退出其他设备」通常是怀疑被盗号：其他设备的信任一并撤销。当前会话还没
      // 绑定设备（旧客户端）时全部撤销信任，避免保留可疑设备。
      await this.deviceTrust.revokeOtherDevices(userId, currentDeviceKey);
      await this.deviceTrust.invalidateChallenges(userId);
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_other_sessions_logout',
        actorId: userId,
        result: 'success',
        entityType: 'user',
        entityId: userId,
      });
    });
  }

  /** 撤销除当前会话所在设备外的全部信任；当前会话未绑定设备时全部撤销。 */
  private async revokeTrustExceptSession(
    userId: string,
    currentSessionId?: string,
  ): Promise<void> {
    const keep = currentSessionId
      ? await this.refreshTokenService.findSessionDeviceKey(
          userId,
          currentSessionId,
        )
      : null;
    await this.deviceTrust.revokeOtherDevices(userId, keep);
  }

  async getSingleDeviceLoginStatus(
    userId: string,
  ): Promise<{ enabled: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { singleDeviceLoginEnabled: true },
    });
    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }
    return { enabled: user.singleDeviceLoginEnabled };
  }

  async setSingleDeviceLogin(
    userId: string,
    enabled: boolean,
    currentSessionId?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }

    await this.refreshTokenService.setSingleDeviceLogin(
      userId,
      enabled,
      currentSessionId,
    );
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_single_device_login_changed',
      actorId: userId,
      result: 'success',
      entityType: 'user',
      entityId: userId,
      metadata: { enabled },
    });
  }

  /**
   * 记一笔最近在线,fire-and-forget:失败只记日志,绝不阻塞登录 / 续签 / me。
   * - 条件写:库里的值在 LAST_ONLINE_WRITE_INTERVAL_MS 之内就跳过(0 行,不产生
   *   新行版本),写法同 ChatService.touchLastOnline;
   * - updateMany 不 RETURNING 整行(update 会把含 passwordHash 在内的全部列读回来,
   *   而调用方从不读返回值);用户行不存在时也不会像 update 那样抛 P2025。
   */
  private touchLastOnline(userId: string, now = new Date()): void {
    this.prisma.user
      .updateMany({
        where: {
          id: userId,
          OR: [
            { lastOnline: null },
            {
              lastOnline: {
                lt: new Date(now.getTime() - LAST_ONLINE_WRITE_INTERVAL_MS),
              },
            },
          ],
        },
        data: { lastOnline: now },
      })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${userId}: ${err?.message}`,
        ),
      );
  }

  async me(userId: string): Promise<SafeUser> {
    const [user, displayIcons, appearances] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: ME_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(userId),
      this.avatarFrames.resolvePublicAppearances([userId]),
    ]);

    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }

    // Fire-and-forget lastOnline update so a DB hiccup never blocks the read
    // and never produces a fabricated "success" response. The returned shape
    // shows the optimistic timestamp; persistence is best-effort (and throttled,
    // see touchLastOnline) — the response never depends on the write.
    const now = new Date();
    this.touchLastOnline(userId, now);

    return {
      ...user,
      // 对外只给有效档位：存量 vipLevel 在会员过期后仍留在列上，直到清扫任务回写。
      vipLevel: resolveEffectiveMembershipLevel(user, now),
      avatarFrameAppearance: appearances.get(userId)?.avatarFrame ?? null,
      lastOnline: now,
      displayIcons,
    };
  }

  /** FE#92 忘记密码第一步：发送重置验证码。防枚举语义在 email-verification 内。 */
  async requestPasswordReset(email: string): Promise<void> {
    try {
      const account = await this.prisma.user.findUnique({
        where: { email: normalizeEmail(email) },
        select: { role: true },
      });
      if (account?.role === 'ADMIN') return;
      await this.emailVerification.requestCode(
        normalizeEmail(email),
        'RESET_PASSWORD',
      );
      // 不带 actorId / 邮箱：请求方未认证，且邮箱是 PII；只留「发生过」。
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_password_reset_requested',
        result: 'success',
      });
    } catch (error) {
      // review 修复（防枚举）：冷却检查先于「未注册邮箱静默成功」——60s 内
      // 重复请求时，已注册邮箱会拿到 CodeRateLimited、未注册邮箱恒静默成功，
      // 差异本身就是账号存在性探针。把冷却也折叠成静默成功：60s 内的合法
      // 重复请求本来就不该再发一封；真实滥用由 IP 级 emailCodeLimiter 兜底。
      if (this.isCodeRateLimited(error)) return;
      // round 3 review：邮件服务故障（503）同理 —— 未注册邮箱在发信前就
      // 静默成功，已注册邮箱才会撞到 5xx，故障期间的差异同样是探针。
      // 静默成功 + error 日志（运维可见；用户重试由前端「未收到？重发」引导）。
      if (error instanceof ServiceUnavailableException) {
        this.logger.error(
          'password reset code delivery failed (mailer unavailable); returning generic success to stay non-enumerable',
        );
        // 用户侧看不出任何异常（防枚举），所以运维侧必须能看到：邮件服务挂了。
        reportOperationalError(error, {
          component: 'AuthService',
          operation: 'requestPasswordReset',
          kind: 'mailer_unavailable',
        });
        return;
      }
      throw error;
    }
  }

  private isCodeRateLimited(error: unknown): boolean {
    if (!(error instanceof BadRequestException)) return false;
    const response = error.getResponse();
    return (
      typeof response === 'object' &&
      response !== null &&
      (response as { errorCode?: string }).errorCode ===
        AuthErrorCode.CodeRateLimited
    );
  }

  /**
   * FE#92 忘记密码第二步：验证码换新密码。
   * 用户不存在与验证码错误共用同一个错误码（防枚举 —— requestCode 已对不存在
   * 邮箱静默成功，这里对称处理）。成功后撤销全部会话并留业务事件。
   */
  async resetPassword(
    rawEmail: string,
    code: string,
    newPassword: string,
  ): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const codeOk = await this.emailVerification.verifyCode(
      email,
      'RESET_PASSWORD',
      code,
    );
    if (!codeOk) {
      throw new ForbiddenException({
        message: '验证码错误或已过期',
        errorCode: AuthErrorCode.CodeInvalid,
      });
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE' || user.role === 'ADMIN') {
      throw new ForbiddenException({
        message: '验证码错误或已过期',
        errorCode: AuthErrorCode.CodeInvalid,
      });
    }

    return this.withAccountAuthLock(user.id, async () => {
      const passwordHash = await argon2.hash(newPassword);
      // round 3 review：改密与 refresh 撤销必须同事务 —— 分两步时撤销失败会
      // 留下「新密码已生效 + 旧会话全活着」的半态，客户端却拿到失败响应。
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: { passwordHash, accessTokensRevokedAt: new Date() },
        }),
        this.prisma.refreshToken.updateMany({
          where: { userId: user.id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      ]);
      // access token 吊销标记（Redis）单独尽力：失败时 refresh 已死、access
      // 最多再活一个 TTL；显式 error 让运维可见，不把已提交的改密翻成假失败。
      // 邮箱验证过的找回密码 = 设备丢失时的恢复通道：撤销全部信任。会话也已全撤，
      // 下一次登录的设备就是「首台设备」，不必再等一台已经找不回来的设备批准。
      await this.deviceTrust.revokeOtherDevices(user.id, null);
      // 旧密码下发起的验证单全部作废：之前拿到密码的人不能再靠它们重发、输码。
      await this.deviceTrust.invalidateChallenges(user.id);
      try {
        await this.refreshTokenService.revokeAllAccessMarkers(user.id);
      } catch (markerError) {
        this.logger.error(
          `password reset: access-token revocation marker failed for ${user.id}: ${
            markerError instanceof Error
              ? markerError.message
              : String(markerError)
          }`,
        );
      }
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_password_reset_success',
        actorId: user.id,
        result: 'success',
        entityType: 'user',
        entityId: user.id,
      });
    });
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    currentSessionId?: string,
  ): Promise<void> {
    return this.withAccountAuthLock(userId, async () => {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        throw new NotFoundException({
          message: '用户不存在',
          errorCode: AuthErrorCode.UserNotFound,
        });
      }

      if (user.role === 'ADMIN')
        throw new ForbiddenException(
          '管理员密码由超级管理员设置，请联系超级管理员',
        );

      const valid = await argon2.verify(user.passwordHash, oldPassword);
      if (!valid) {
        throw new UnauthorizedException({
          message: '当前密码不正确',
          errorCode: AuthErrorCode.PasswordIncorrect,
        });
      }

      const passwordHash = await argon2.hash(newPassword);
      await this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
      });

      // 改密通常是怀疑密码泄露：当前设备之外全部撤销信任，否则攻击者的设备
      // 拿到新密码后照样免批准登录。
      await this.revokeTrustExceptSession(userId, currentSessionId);
      await this.deviceTrust.invalidateChallenges(userId);
      // Invalidate all existing sessions after password change
      await this.refreshTokenService.revokeAll(userId);
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_change_password_success',
        actorId: userId,
        result: 'success',
        entityType: 'user',
        entityId: userId,
      });
    });
  }

  async changeAccountId(userId: string, accountId: string): Promise<SafeUser> {
    // 统一归一为小写后存储：accountId 唯一性与好友精确查找都按大小写不敏感
    // 处理，归一到小写后简单的精确查重 / DB 唯一约束即足以保证唯一性。
    const normalized = accountId.trim().toLowerCase();
    if (!ACCOUNT_ID_PATTERN.test(normalized)) {
      throw new BadRequestException({
        message: ACCOUNT_ID_RULE_MESSAGE,
        errorCode: AuthErrorCode.AccountIdInvalid,
      });
    }

    await this.fancyNumberService.ensureAccountIdChangeAllowed(userId);

    try {
      await runSerializableTransaction(this.prisma, async (tx) => {
        await lockFancyNumberUser(tx, userId);
        const activeLease = await tx.fancyNumberLease.findFirst({
          where: { userID: userId, endedAt: null },
          select: { id: true },
        });
        if (activeLease) {
          throw new ConflictException({
            message: '使用靓号期间不能修改账号 ID',
            errorCode: FancyNumberErrorCode.AccountIdLocked,
          });
        }

        const current = await tx.user.findUnique({
          where: { id: userId },
          select: { accountId: true },
        });
        if (!current) {
          throw new NotFoundException({
            message: '用户不存在',
            errorCode: AuthErrorCode.UserNotFound,
          });
        }
        if (current.accountId === normalized) {
          throw new BadRequestException({
            message: '新账号不能和当前账号相同',
            errorCode: AuthErrorCode.AccountIdUnchanged,
          });
        }

        const taken = await tx.user.findUnique({
          where: { accountId: normalized },
          select: { id: true },
        });
        if (taken) {
          throw new ConflictException({
            message: '该账号已被占用',
            errorCode: AuthErrorCode.AccountIdTaken,
          });
        }
        const identifierClaim = await tx.accountIdentifier.findUnique({
          where: { value: normalized },
          select: {
            currentUserID: true,
            reservedForUserID: true,
            inviteOwnerUserID: true,
            fancyNumber: { select: { id: true } },
          },
        });
        if (
          identifierClaim &&
          ((identifierClaim.currentUserID !== null &&
            identifierClaim.currentUserID !== userId) ||
            identifierClaim.reservedForUserID !== null ||
            (identifierClaim.inviteOwnerUserID !== null &&
              identifierClaim.inviteOwnerUserID !== userId) ||
            identifierClaim.fancyNumber !== null)
        ) {
          throw new ConflictException({
            message: '该账号已被占用',
            errorCode: AuthErrorCode.AccountIdTaken,
          });
        }

        await tx.user.update({
          where: { id: userId },
          data: { accountId: normalized },
        });
      });
    } catch (err) {
      // 查重与写入之间被并发抢占：唯一约束兜底，转成友好的 409。
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          message: '该账号已被占用',
          errorCode: AuthErrorCode.AccountIdTaken,
        });
      }
      throw err;
    }

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_change_account_id_success',
      actorId: userId,
      result: 'success',
      entityType: 'user',
      entityId: userId,
    });

    return this.me(userId);
  }

  async getLoginSecurityCodeStatus(
    userId: string,
  ): Promise<{ enabled: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { loginSecurityCodeHash: true },
    });

    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }

    return { enabled: Boolean(user.loginSecurityCodeHash) };
  }

  async setLoginSecurityCode(
    userId: string,
    securityCode: string,
    oldSecurityCode?: string,
  ): Promise<void> {
    assertValidSecurityCode(securityCode);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { loginSecurityCodeHash: true },
    });

    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }

    if (user.loginSecurityCodeHash) {
      if (!oldSecurityCode) {
        throw new UnauthorizedException({
          message: '当前安全码不正确',
          errorCode: AuthErrorCode.SecurityCodeInvalid,
        });
      }
      assertValidSecurityCode(oldSecurityCode, 'oldSecurityCode');
      const oldCodeValid = await argon2.verify(
        user.loginSecurityCodeHash,
        oldSecurityCode,
      );
      if (!oldCodeValid) {
        throw new UnauthorizedException({
          message: '当前安全码不正确',
          errorCode: AuthErrorCode.SecurityCodeInvalid,
        });
      }
    }

    const loginSecurityCodeHash = await argon2.hash(securityCode);
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        loginSecurityCodeHash,
        securityCodeAttempts: 0,
        securityCodeLockedUntil: null,
      },
    });
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_security_code_set',
      actorId: userId,
      result: 'success',
      entityType: 'user',
      entityId: userId,
    });
  }

  async disableLoginSecurityCode(
    userId: string,
    securityCode: string,
  ): Promise<void> {
    assertValidSecurityCode(securityCode);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { loginSecurityCodeHash: true },
    });

    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }

    if (!user.loginSecurityCodeHash) {
      return;
    }

    const valid = await argon2.verify(user.loginSecurityCodeHash, securityCode);
    if (!valid) {
      throw new UnauthorizedException({
        message: '安全码不正确',
        errorCode: AuthErrorCode.SecurityCodeInvalid,
      });
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        loginSecurityCodeHash: null,
        securityCodeAttempts: 0,
        securityCodeLockedUntil: null,
      },
    });
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_security_code_disabled',
      actorId: userId,
      result: 'success',
      entityType: 'user',
      entityId: userId,
    });
  }

  async verifyLoginSecurityCode(
    userId: string,
    securityCode: string,
  ): Promise<{ ok: boolean }> {
    assertValidSecurityCode(securityCode);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        loginSecurityCodeHash: true,
        securityCodeAttempts: true,
        securityCodeLockedUntil: true,
      },
    });

    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }

    if (!user.loginSecurityCodeHash) {
      return { ok: false };
    }

    const now = new Date();
    if (user.securityCodeLockedUntil && user.securityCodeLockedUntil > now) {
      throw new ForbiddenException({
        message: '安全码错误次数过多，请稍后再试',
        errorCode: AuthErrorCode.SecurityCodeLocked,
      });
    }

    const valid = await argon2.verify(user.loginSecurityCodeHash, securityCode);

    if (!valid) {
      const attempts = user.securityCodeAttempts + 1;
      const shouldLock = attempts >= MAX_SECURITY_CODE_ATTEMPTS;
      // On lockout, reset the counter so the next window starts fresh after the
      // lock expires. Read-then-write here is fine: any race only grants a
      // couple of extra guesses, and the per-IP limiter already caps the rate.
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          securityCodeAttempts: shouldLock ? 0 : attempts,
          securityCodeLockedUntil: shouldLock
            ? new Date(now.getTime() + SECURITY_CODE_LOCK_MS)
            : user.securityCodeLockedUntil,
        },
      });
      logSecurityEvent(this.logger, {
        enabled: this.loggingConfig.securityLogOn,
        securityEvent: shouldLock
          ? 'security_code_locked'
          : 'security_code_invalid',
        statusCode: shouldLock ? 403 : 200,
        userId,
        metadata: { attempts },
      });
      if (shouldLock) {
        this.logger.warn(
          `Security code locked for user ${userId} after ${MAX_SECURITY_CODE_ATTEMPTS} failed attempts.`,
        );
        throw new ForbiddenException({
          message: '安全码错误次数过多，请稍后再试',
          errorCode: AuthErrorCode.SecurityCodeLocked,
        });
      }
      return { ok: false };
    }

    // Success: clear any accumulated failures / lock.
    if (user.securityCodeAttempts !== 0 || user.securityCodeLockedUntil) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { securityCodeAttempts: 0, securityCodeLockedUntil: null },
      });
    }

    return { ok: true };
  }

  private async createRegisteredUser(
    data: Omit<Prisma.UserUncheckedCreateInput, 'accountId' | 'inviteCode'>,
    campaignID?: string,
  ) {
    const maxAttempts = REGISTRATION_CODE_MAX_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const [accountId, inviteCode] = await Promise.all([
        generateUniqueAccountId(this.prisma),
        generateUniqueRegistrationCode(this.prisma),
      ]);
      try {
        return await this.prisma.$transaction(async (tx) => {
          if (campaignID) {
            const claimed = await tx.$queryRaw<Array<{ id: string }>>`
              UPDATE "CampaignInvite" SET "usedCount" = "usedCount" + 1, "updatedAt" = CURRENT_TIMESTAMP
              WHERE "id" = ${campaignID} AND "enabled" = true AND "expiresAt" > CURRENT_TIMESTAMP AND "usedCount" < "maxUses"
              AND EXISTS (SELECT 1 FROM "User" WHERE "User"."id" = "CampaignInvite"."ownerUserID" AND "status" = 'ACTIVE' AND "role" <> 'ADMIN')
              RETURNING "id"`;
            if (claimed.length !== 1)
              throw new BadRequestException({
                message: '邀请码已失效或使用次数已满',
                errorCode: AuthErrorCode.InviteCodeInvalid,
              });
          }
          const user = await tx.user.create({
            data: {
              ...data,
              accountId,
              inviteCode,
            },
          });
          if (campaignID)
            await tx.campaignInviteUse.create({
              data: { campaignID, userID: user.id },
            });
          if (data.invitedByUserId) {
            await tx.referral.create({
              data: buildPendingReferralData(this.referralRules, {
                inviterId: data.invitedByUserId,
                inviteeId: user.id,
                createdAt: user.createdAt,
              }),
            });
          }
          return user;
        });
      } catch (error) {
        // 唯一索引冲突(P2002)和触发器的认领冲突(plpgsql P0001)都是"这个候选值
        // 被并发注册抢走了",都该换一组码重试;只有其它错误才真正上抛。
        if (
          isRegistrationCodeUniqueCollision(error) ||
          isAccountIdentifierClaimCollision(error, [accountId, inviteCode])
        ) {
          if (attempt < maxAttempts - 1) continue;
          break;
        }
        throw error;
      }
    }

    throw new ServiceUnavailableException(
      'Failed to create a user with unique account and invite codes',
    );
  }

  private async issueTokens(
    userId: string,
    accountId: string,
    role: string,
    sessionContext?: SessionContext,
    options?: {
      audience?: RefreshTokenAudience;
      expectedPasswordHash?: string;
    },
  ) {
    const { accessToken, refreshToken } = await this.issueTokensWithSession(
      userId,
      accountId,
      role,
      sessionContext,
      options,
    );
    return { accessToken, refreshToken };
  }

  /** 同 issueTokens，另外带回新会话 id（不进响应体，只给需要「撤销其他会话」的调用方）。 */
  private async issueTokensWithSession(
    userId: string,
    accountId: string,
    role: string,
    sessionContext?: SessionContext,
    options?: {
      audience?: RefreshTokenAudience;
      expectedPasswordHash?: string;
    },
  ) {
    const audience = options?.audience ?? 'APP';
    let createSession: Promise<{ token: string; sessionId: string }>;
    if (audience === 'APP') {
      createSession = this.refreshTokenService.createAppSession(
        userId,
        sessionContext,
      );
    } else {
      createSession =
        this.refreshTokenService.createSessionForCurrentSingleDeviceSetting(
          userId,
          sessionContext,
          audience,
        );
    }

    const { token: refreshToken, sessionId } = await createSession;
    // Reject a login authenticated with a password reset during session issuance.
    if (audience === 'ADMIN' && options?.expectedPasswordHash) {
      const current = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          passwordHash: true,
          status: true,
          role: true,
          accountId: true,
        },
      });
      if (
        current?.passwordHash !== options.expectedPasswordHash ||
        current.status !== 'ACTIVE' ||
        current.role !== 'ADMIN' ||
        current.accountId !== accountId
      ) {
        await this.refreshTokenService.revoke(refreshToken);
        throw new UnauthorizedException('密码或账号状态已变化，请重新登录');
      }
    }
    const accessToken = await this.signAccessToken(
      userId,
      accountId,
      role,
      sessionId,
      audience,
    );
    await this.refreshTokenService.assertSessionActive(userId, sessionId);
    return { accessToken, refreshToken, sessionId };
  }

  private async signAccessToken(
    userId: string,
    accountId: string,
    role: string,
    sessionId?: string,
    audience: RefreshTokenAudience = 'APP',
    tx?: Prisma.TransactionClient,
  ): Promise<string> {
    const issuedAtMs = Date.now();
    const payload = {
      sub: userId,
      accountId,
      role,
      sid: sessionId,
      aud: audience,
      issuedAtMs,
    };
    const globalSeconds = accessTokenTtlSeconds(
      this.configService.get<string | number>('JWT_EXPIRES_IN') ?? '1h',
    );
    let expiresIn = globalSeconds;
    let accessToken: string;
    // ADMIN audience 用更短的 access TTL（#91）：全局 JWT_EXPIRES_IN 仍管普通
    // 用户；管理台 access token 默认 15 分钟，可用 ADMIN_JWT_EXPIRES_IN 覆盖。
    if (audience === 'ADMIN') {
      const adminExpiresIn =
        this.configService.get<string>('ADMIN_JWT_EXPIRES_IN') ??
        DEFAULT_ADMIN_JWT_EXPIRES_IN;
      // review 修复（钳到吊销窗口）：SessionRevocationService 的吊销标记
      // TTL 按全局 JWT_EXPIRES_IN 定长 —— admin access TTL 若配得更长，
      // 标记先过期、被吊销的 admin token 会「复活」。上限=全局 TTL。
      const adminSeconds = accessTokenTtlSeconds(adminExpiresIn);
      if (adminSeconds > globalSeconds) {
        this.logger.warn(
          `ADMIN_JWT_EXPIRES_IN (${adminExpiresIn}) exceeds JWT_EXPIRES_IN — ` +
            'clamping admin access TTL to the global value so revocation ' +
            'markers always outlive the token',
        );
      }
      expiresIn = Math.min(adminSeconds, globalSeconds);
      accessToken = await this.jwt.signAsync(payload, { expiresIn });
    } else {
      accessToken = await this.jwt.signAsync(payload);
    }
    if (sessionId) {
      const expiresAt = new Date(issuedAtMs + expiresIn * 1000);
      try {
        if (tx) {
          // 续签事务里:保存点让失败只回滚这一条,不把整个续签事务拖进 aborted。
          await withSavepoint(tx, 'refresh_access_expiry', () =>
            this.refreshTokenService.recordAccessTokenIssued(
              userId,
              sessionId,
              expiresAt,
              tx,
            ),
          );
        } else {
          await this.refreshTokenService.recordAccessTokenIssued(
            userId,
            sessionId,
            expiresAt,
          );
        }
      } catch (error) {
        // Never fail token issuance on this metadata: outside a transaction the
        // session row is already committed, and failing would strand the new
        // refresh token and make a retry look like token reuse.
        // A null expiry is safe: revocation records a conservative full TTL.
        this.logger.warn({
          event: 'access_token_expiry_metadata_persist_failed',
          operation: 'signAccessToken',
          fallback: 'conservative_access_ttl',
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
    return accessToken;
  }
}

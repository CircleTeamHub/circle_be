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
import { LoginWithCodeDto } from './dto/login-with-code.dto';
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
  QrErrorCode,
} from 'src/common/app-error-codes';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_ID_RULE_MESSAGE,
} from 'src/utils/account-id';
import {
  RefreshTokenAudience,
  RefreshTokenService,
  SessionContext,
} from './refresh-token.service';
import { accessTokenTtlSeconds } from './session-revocation.service';
import { ConfigService } from '@nestjs/config';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { IconService } from 'src/icon/icon.service';
import { DisplayIconDto } from 'src/icon/dto/icon.dto';
import { USER_ME_SELECT } from 'src/user/user.select';
import {
  EffectiveMembershipAppearance,
  resolveMembershipAppearance,
} from 'src/membership/membership-appearance';
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

const ME_SELECT = USER_ME_SELECT;

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
  storedVipLevel: number;
  vipExpiresAt: Date | null;
  membership: EffectiveMembershipAppearance;
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
  ) {
    this.referralRules = readReferralRules(configService);
  }

  async register(dto: RegisterDto, sessionContext?: SessionContext) {
    const email = normalizeEmail(dto.email);

    const codeOk = await this.emailVerification.verifyCode(
      email,
      'REGISTER',
      dto.code,
    );
    if (!codeOk) {
      throw new BadRequestException({
        message: '验证码错误或已过期',
        errorCode: AuthErrorCode.CodeInvalid,
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
    if (normalizedInviteCode && (!inviter || inviter.status !== 'ACTIVE')) {
      throw new BadRequestException({
        message: '邀请码无效',
        errorCode: AuthErrorCode.InviteCodeInvalid,
      });
    }

    const passwordHash = await argon2.hash(dto.password);
    const user = await this.createRegisteredUser({
      passwordHash,
      nickname: dto.nickname,
      email,
      ...(inviter ? { invitedByUserId: inviter.id } : {}),
    });

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_register_success',
      actorId: user.id,
      result: 'success',
      entityType: 'user',
      entityId: user.id,
    });

    return this.issueTokens(
      user.id,
      user.accountId,
      user.role,
      sessionContext,
      dto.platform,
    );
  }

  async login(dto: LoginDto, sessionContext?: SessionContext) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

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
        message: '邮箱或密码错误',
        errorCode: AuthErrorCode.InvalidCredentials,
      });
    }

    // round 3 review（P1）：ADMIN 账号整体拒绝走普通登录 —— 即使密码正确，
    // 这里发出的是 APP audience 的长 TTL 会话 + IM token，而 /roles 等管理
    // 端点（JwtGuard+RoleGuard）会接受它，等于绕开短 TTL/审计的管理会话
    // 模型。管理台请走 /auth/admin/login。对外文案与普通失败一致（不泄露
    // 该邮箱是管理员）。锁定检查仍在其前（锁死期间不做密码比对）。
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
        message: '邮箱或密码错误',
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
        message: '邮箱或密码错误',
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
        message: '邮箱或密码错误',
        errorCode: AuthErrorCode.InvalidCredentials,
      });
    }
    return this.finishLogin(user, sessionContext, dto.platform);
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

  async adminLogin(dto: LoginDto, sessionContext?: SessionContext) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });
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

    await this.resetAdminLockCounters(user);

    this.prisma.user
      .update({ where: { id: user.id }, data: { lastOnline: new Date() } })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${user.id}: ${err?.message}`,
        ),
      );

    const tokens = await this.issueTokens(
      user.id,
      user.accountId,
      user.role,
      sessionContext,
      undefined,
      {
        audience: 'ADMIN',
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

    return tokens;
  }

  async loginWithCode(dto: LoginWithCodeDto, sessionContext?: SessionContext) {
    const email = normalizeEmail(dto.email);

    const codeOk = await this.emailVerification.verifyCode(
      email,
      'LOGIN',
      dto.code,
    );
    if (!codeOk) {
      throw new ForbiddenException({
        message: '验证码错误或已过期',
        errorCode: AuthErrorCode.CodeInvalid,
      });
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        message: '验证码错误或已过期',
        errorCode: AuthErrorCode.CodeInvalid,
      });
    }

    return this.finishLogin(user, sessionContext, dto.platform);
  }

  async requestEmailCode(
    email: string,
    purpose: 'register' | 'login',
  ): Promise<void> {
    await this.emailVerification.requestCode(
      email,
      purpose === 'register' ? 'REGISTER' : 'LOGIN',
    );
  }

  /** 密码登录与验证码登录共用的收尾：lastOnline、发 token、记日志。 */
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
    platform?: 1 | 2 | 5,
  ) {
    // Fire-and-forget: lastOnline is best-effort and must never block token issuance.
    this.prisma.user
      .update({ where: { id: user.id }, data: { lastOnline: new Date() } })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${user.id}: ${err?.message}`,
        ),
      );

    const tokens = await this.issueTokens(
      user.id,
      user.accountId,
      user.role,
      sessionContext,
      platform,
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

  /**
   * 扫码登录的账号闸门：与普通登录同一政策 —— ACTIVE 且非 ADMIN
   * （管理台自有短 TTL 会话模型，扫码不放行）。文案统一"二维码已失效"，
   * 不泄露账号状态。
   */
  async assertQrLoginEligible(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, role: true },
    });
    if (!user || user.status !== 'ACTIVE' || user.role === 'ADMIN') {
      throw new ForbiddenException({
        message: '二维码已失效，请刷新后重试',
        errorCode: QrErrorCode.Invalid,
      });
    }
  }

  /** 扫码登录消费侧换发正式会话（QrLoginService 在 CONSUMED 抢占成功后调）。 */
  async issueQrLoginTokens(userId: string, sessionContext?: SessionContext) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'ACTIVE' || user.role === 'ADMIN') {
      throw new ForbiddenException({
        message: '二维码已失效，请刷新后重试',
        errorCode: QrErrorCode.Invalid,
      });
    }
    return this.finishLogin(user, sessionContext);
  }

  async refresh(refreshToken: string, sessionContext?: SessionContext) {
    const {
      token: newRefreshToken,
      userId,
      sessionId,
    } = await this.refreshTokenService.rotate(
      refreshToken,
      sessionContext,
      'APP',
    );

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }

    // Banned/deleted users must not be able to keep refreshing tokens just
    // because they still hold a valid refresh token. Revoke their sessions
    // and reject the rotation result.
    if (user.status !== 'ACTIVE') {
      this.logger.warn(
        `Refresh blocked for non-active user ${user.id} (status=${user.status}); revoking sessions.`,
      );
      await this.refreshTokenService.revokeAll(user.id);
      throw new ForbiddenException({
        message: '账号已被禁用',
        errorCode: AuthErrorCode.AccountDisabled,
      });
    }

    // Fire-and-forget: lastOnline is best-effort and must never block token issuance.
    this.prisma.user
      .update({ where: { id: user.id }, data: { lastOnline: new Date() } })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${user.id}: ${err?.message}`,
        ),
      );

    const accessToken = await this.signAccessToken(
      user.id,
      user.accountId,
      user.role,
      sessionId,
      'APP',
    );
    await this.refreshTokenService.assertSessionActive(user.id, sessionId);
    return { accessToken, refreshToken: newRefreshToken };
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

    this.prisma.user
      .update({ where: { id: user.id }, data: { lastOnline: new Date() } })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${user.id}: ${err?.message}`,
        ),
      );

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
    const sessions = await this.refreshTokenService.listActiveSessions(userId);
    return sessions.map((session) => ({
      ...session,
      isCurrent: currentSessionId ? session.id === currentSessionId : false,
    }));
  }

  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokenService.revokeAll(userId);
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_logout_all_success',
      actorId: userId,
      result: 'success',
      entityType: 'user',
      entityId: userId,
    });
  }

  async logoutSession(userId: string, sessionId: string): Promise<void> {
    await this.refreshTokenService.revokeSession(userId, sessionId);
  }

  async logoutOtherSessions(
    userId: string,
    currentSessionId?: string,
  ): Promise<void> {
    await this.refreshTokenService.revokeOtherSessions(
      userId,
      currentSessionId,
    );
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
    // shows the optimistic timestamp; persistence is best-effort.
    const now = new Date();
    this.prisma.user
      .update({ where: { id: userId }, data: { lastOnline: now } })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${userId}: ${err?.message}`,
        ),
      );

    const membership = resolveMembershipAppearance(user, now);
    const { vipLevel: storedVipLevel, ...safeUser } = user;

    return {
      ...safeUser,
      storedVipLevel,
      vipLevel: membership.effectiveLevel,
      membership,
      avatarFrameAppearance: appearances.get(userId)?.avatarFrame ?? null,
      lastOnline: now,
      displayIcons,
    };
  }

  /** FE#92 忘记密码第一步：发送重置验证码。防枚举语义在 email-verification 内。 */
  async requestPasswordReset(email: string): Promise<void> {
    try {
      await this.emailVerification.requestCode(
        normalizeEmail(email),
        'RESET_PASSWORD',
      );
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
    if (!user || user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        message: '验证码错误或已过期',
        errorCode: AuthErrorCode.CodeInvalid,
      });
    }

    const passwordHash = await argon2.hash(newPassword);
    // round 3 review：改密与 refresh 撤销必须同事务 —— 分两步时撤销失败会
    // 留下「新密码已生效 + 旧会话全活着」的半态，客户端却拿到失败响应。
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // access token 吊销标记（Redis）单独尽力：失败时 refresh 已死、access
    // 最多再活一个 TTL；显式 error 让运维可见，不把已提交的改密翻成假失败。
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
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException({
        message: '用户不存在',
        errorCode: AuthErrorCode.UserNotFound,
      });
    }

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
  }

  /**
   * 修改 accountId（登录 / 好友搜索用的句柄）。
   * - 不影响会话：与改密码不同，改 accountId 不撤销登录态。
   * - 唯一性：先查重给出明确 409，并发竞态最终由 DB 唯一约束（P2002）兜底。
   * 返回与 /auth/me 完全一致的资料，调用方据此 setUser。
   */
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
  ) {
    const maxAttempts = REGISTRATION_CODE_MAX_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const [accountId, inviteCode] = await Promise.all([
        generateUniqueAccountId(this.prisma),
        generateUniqueRegistrationCode(this.prisma),
      ]);
      try {
        return await this.prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              ...data,
              accountId,
              inviteCode,
            },
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
    platformID?: 1 | 2 | 5,
    options?: {
      audience?: RefreshTokenAudience;
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
    const accessToken = await this.signAccessToken(
      userId,
      accountId,
      role,
      sessionId,
      audience,
    );
    await this.refreshTokenService.assertSessionActive(userId, sessionId);
    return { accessToken, refreshToken };
  }

  private signAccessToken(
    userId: string,
    accountId: string,
    role: string,
    sessionId?: string,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<string> {
    const payload = {
      sub: userId,
      accountId,
      role,
      sid: sessionId,
      aud: audience,
      issuedAtMs: Date.now(),
    };
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
      const globalSeconds = accessTokenTtlSeconds(
        this.configService.get<string | number>('JWT_EXPIRES_IN') ?? '1h',
      );
      if (adminSeconds > globalSeconds) {
        this.logger.warn(
          `ADMIN_JWT_EXPIRES_IN (${adminExpiresIn}) exceeds JWT_EXPIRES_IN — ` +
            'clamping admin access TTL to the global value so revocation ' +
            'markers always outlive the token',
        );
      }
      return this.jwt.signAsync(payload, {
        expiresIn: Math.min(adminSeconds, globalSeconds),
      });
    }
    return this.jwt.signAsync(payload);
  }
}

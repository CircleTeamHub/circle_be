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
  generateUniqueRegistrationCode,
  isRegistrationCodeUniqueCollision,
  REGISTRATION_CODE_MAX_ATTEMPTS,
} from './account-id.unique';
import { normalizeEmail } from 'src/utils/email';
import { AuthErrorCode } from 'src/common/app-error-codes';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_ID_RULE_MESSAGE,
} from 'src/utils/account-id';
import {
  RefreshTokenAudience,
  RefreshTokenService,
  SessionContext,
} from './refresh-token.service';
import { OpenimService } from 'src/openim/openim.service';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';
import { IconService } from 'src/icon/icon.service';
import { DisplayIconDto } from 'src/icon/dto/icon.dto';
import { USER_ME_SELECT } from 'src/user/user.select';

const ME_SELECT = USER_ME_SELECT;
const SECURITY_CODE_PATTERN = /^\d{4,6}$/;
// Persistent per-account lockout for security-code verification. Backs up the
// per-IP rate limiter so a distributed / IP-rotating attacker still can't
// brute-force a 4-6 digit code.
const MAX_SECURITY_CODE_ATTEMPTS = 5;
const SECURITY_CODE_LOCK_MS = 15 * 60 * 1000;

/**
 * OpenIM 1004「record not found」——请求的用户还没在 OpenIM 落库。
 * getUserToken 抢在异步注册前面时会命中，属于可重试的瞬时竞态。
 */
export function isOpenImRecordNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return (
    message.includes('record not found') ||
    message.includes('RecordNotFound') ||
    message.includes('1004')
  );
}

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
  creditScore: number;
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

  constructor(
    private prisma: PrismaService,
    private refreshTokenService: RefreshTokenService,
    private jwt: JwtService,
    private openim: OpenimService,
    private iconService: IconService,
    private emailVerification: EmailVerificationService,
  ) {}

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

    const normalizedInviteCode = dto.inviteCode?.trim().toLowerCase() || null;
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
      ...(inviter ? { invitedBy: { connect: { id: inviter.id } } } : {}),
    });

    // Sync to OpenIM non-blocking. Mark openimSynced=true on success so
    // login() can detect and retry if this first attempt failed.
    this.openim
      .registerUser(user.id, user.nickname, user.avatarUrl)
      .then(() =>
        this.prisma.user.update({
          where: { id: user.id },
          data: { openimSynced: true },
        }),
      )
      .catch((err) =>
        this.logger.warn(
          `OpenIM registerUser failed for ${user.id}: ${err?.message}. Will retry on next login.`,
        ),
      );

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

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
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

    return this.finishLogin(user, sessionContext, dto.platform);
  }

  async adminLogin(dto: LoginDto, sessionContext?: SessionContext) {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || user.status !== 'ACTIVE') {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_admin_login_failed',
        actorId: user?.id,
        result: 'failure',
        metadata: {
          reason: user ? 'inactive_account' : 'invalid_credentials',
        },
      });
      throw new ForbiddenException('Invalid credentials or inactive account');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid || user.role !== 'ADMIN') {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'auth_admin_login_failed',
        actorId: user.id,
        result: 'failure',
        metadata: {
          reason: valid ? 'insufficient_role' : 'invalid_credentials',
        },
      });
      throw new ForbiddenException('Invalid credentials or inactive account');
    }

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
        issueImToken: false,
        revokeExistingSessions: user.singleDeviceLoginEnabled,
      },
    );

    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'auth_admin_login_success',
      actorId: user.id,
      result: 'success',
      entityType: 'user',
      entityId: user.id,
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

  /** 密码登录与验证码登录共用的收尾：OpenIM 重同步、lastOnline、发 token、记日志。 */
  private async finishLogin(
    user: {
      id: string;
      accountId: string;
      role: string;
      nickname: string;
      avatarUrl: string | null;
      openimSynced: boolean;
      singleDeviceLoginEnabled: boolean;
    },
    sessionContext?: SessionContext,
    platform?: 1 | 2 | 5,
  ) {
    // Retry OpenIM registration for users that weren't synced at register time
    // (e.g. OpenIM was down). Non-blocking — login succeeds regardless.
    if (!user.openimSynced) {
      this.openim
        .registerUser(user.id, user.nickname, user.avatarUrl)
        .then(() =>
          this.prisma.user.update({
            where: { id: user.id },
            data: { openimSynced: true },
          }),
        )
        .catch((err) =>
          this.logger.warn(
            `OpenIM re-sync failed for ${user.id}: ${err?.message}`,
          ),
        );
    }

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
      { revokeExistingSessions: user.singleDeviceLoginEnabled },
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
    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokenService.revoke(refreshToken);
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

    await this.prisma.user.update({
      where: { id: userId },
      data: { singleDeviceLoginEnabled: enabled },
    });

    if (enabled) {
      await this.refreshTokenService.revokeOtherSessions(
        userId,
        currentSessionId,
      );
    }
  }

  async me(userId: string): Promise<SafeUser> {
    const [user, displayIcons] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: ME_SELECT,
      }),
      this.iconService.getDisplayIconsForUser(userId),
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

    return { ...user, lastOnline: now, displayIcons };
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

    const current = await this.prisma.user.findUnique({
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

    const taken = await this.prisma.user.findUnique({
      where: { accountId: normalized },
      select: { id: true },
    });
    if (taken) {
      throw new ConflictException({
        message: '该账号已被占用',
        errorCode: AuthErrorCode.AccountIdTaken,
      });
    }

    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { accountId: normalized },
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
    data: Omit<Prisma.UserCreateInput, 'accountId' | 'inviteCode'>,
  ) {
    const maxAttempts = REGISTRATION_CODE_MAX_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const registrationCode = await generateUniqueRegistrationCode(
        this.prisma,
      );
      try {
        return await this.prisma.user.create({
          data: {
            ...data,
            accountId: registrationCode,
            inviteCode: registrationCode,
          },
        });
      } catch (error) {
        if (isRegistrationCodeUniqueCollision(error)) {
          if (attempt < maxAttempts - 1) continue;
          break;
        }
        throw error;
      }
    }

    throw new ServiceUnavailableException(
      'Failed to create a user with a unique registration code',
    );
  }

  private async issueTokens(
    userId: string,
    accountId: string,
    role: string,
    sessionContext?: SessionContext,
    platformID?: 1 | 2 | 5,
    options?: {
      revokeExistingSessions?: boolean;
      audience?: RefreshTokenAudience;
      issueImToken?: boolean;
    },
  ) {
    if (options?.revokeExistingSessions) {
      await this.refreshTokenService.revokeAll(userId);
    }

    const audience = options?.audience ?? 'APP';
    const issueImToken = options?.issueImToken ?? true;

    const [{ token: refreshToken, sessionId }, imToken] = await Promise.all([
      this.refreshTokenService.create(userId, sessionContext, audience),
      issueImToken ? this.resolveImToken(userId, platformID) : '',
    ]);
    const accessToken = await this.signAccessToken(
      userId,
      accountId,
      role,
      sessionId,
      audience,
    );
    return issueImToken
      ? { accessToken, refreshToken, imToken }
      : { accessToken, refreshToken };
  }

  /**
   * 单独签发 IM token，供客户端在「不重新登录」的前提下重建 IM 会话
   * （登录时 imToken 为空、IM token 过期、连接瞬时失败后恢复等）。
   *
   * 身份只来自调用方的 JWT —— 见 AuthController.imToken，不接受任何 userId 入参。
   *
   * 与登录的差异只在失败语义：登录时 IM 只是附加能力，拿不到 token 也要放行；
   * 而这个接口的全部意义就是返回 token，此时再退化成空串就成了「200 + 静默失败」，
   * 客户端无法区分「IM 未配置」和「OpenIM 挂了」，只能把空值存下来再次陷入
   * resolveImToken 注释里描述的死角。因此这里显式抛 503，让客户端能退避重试。
   */
  async getImToken(
    userId: string,
    platformID?: 1 | 2 | 5,
  ): Promise<{ imToken: string }> {
    const imToken = await this.resolveImToken(userId, platformID);
    if (!imToken) {
      throw new ServiceUnavailableException(
        'IM token is temporarily unavailable',
      );
    }
    return { imToken };
  }

  /**
   * 取 OpenIM 用户 token。IM 不是登录的硬依赖：拿不到时退化为空串，让登录照常完成。
   * 但失败必须「喊出来」——否则 OpenIM 宕机（如 Kafka 抽风导致 get_user_token 超时）时，
   * 前端只会静默拿到空 imToken、连不上 IM、会话加载不出来，问题极难定位。
   *
   * 注意：OpenIM 被显式禁用（未配置 API/secret）时 getUserToken 直接返回空串、不抛错，
   * 因此这里的 error 日志只会在「真实故障」时触发，不会对预期内的禁用态误报。
   */
  private async resolveImToken(
    userId: string,
    platformID?: 1 | 2 | 5,
  ): Promise<string> {
    // OpenIM 用户注册是异步非阻塞的（见 registerUser 调用点），注册后紧接着的首个
    // getUserToken 可能抢在用户落库之前，OpenIM 返回 1004 "record not found"。这是
    // 可自愈的瞬时竞态 —— 短暂退避后重试即可，避免把「空 imToken」持久化到客户端
    // （客户端只在登录时刷新 imToken，一旦存了空值会静默跳过 IM 登录、极难定位）。
    // 真正的宕机/超时不重试：重试也白搭，且每次 getUserToken 有 5s 超时，重试会把
    // 登录拖到十几秒。这类情况退化为空串并 error 喊出来。
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.openim.getUserToken(userId, platformID);
      } catch (err) {
        if (attempt < MAX_ATTEMPTS && isOpenImRecordNotFoundError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
          continue;
        }
        this.logger.error(
          `OpenIM getUserToken failed for userId=${userId} platformID=${platformID ?? 'default'} ` +
            `after ${attempt} attempt(s); returning empty imToken — client IM login will be skipped`,
          err instanceof Error ? err.stack : String(err),
        );
        return '';
      }
    }
    return '';
  }

  private signAccessToken(
    userId: string,
    accountId: string,
    role: string,
    sessionId?: string,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<string> {
    return this.jwt.signAsync({
      sub: userId,
      accountId,
      role,
      sid: sessionId,
      aud: audience,
      issuedAtMs: Date.now(),
    });
  }
}

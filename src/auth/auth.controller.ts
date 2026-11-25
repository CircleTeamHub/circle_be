import { AnonymousAccess } from 'src/guards/anonymous-access.decorator';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Request, Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AuthErrorCode } from 'src/common/app-error-codes';
import { AuthService } from './auth.service';
import { AuthSessionDto } from './dto/auth-session.dto';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { LoginDto } from './dto/login.dto';
import {
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './dto/password-reset.dto';
import {
  RefreshTokenDto,
  SessionRefreshTokenDto,
} from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeAccountIdDto } from './dto/change-account-id.dto';
import { ChangeEmailDto, RequestEmailChangeDto } from './dto/change-email.dto';
import {
  LoginSecurityCodeDto,
  SetLoginSecurityCodeDto,
} from './dto/login-security-code.dto';
import { SingleDeviceLoginDto } from './dto/single-device-login.dto';
import { LoginChallengeCodeDto } from './dto/login-challenge.dto';
import {
  DeviceTrustService,
  hashDeviceId,
  hashStableDeviceId,
} from './device-trust.service';
import { SecurityQuestionsService } from './security-questions.service';
import {
  SetSecurityQuestionsDto,
  VerifySecurityQuestionsDto,
} from './dto/security-questions.dto';
import { RefreshTokenService } from './refresh-token.service';
import { SelfUserDto } from 'src/user/dto/public-user.dto';
import { Serialize } from 'src/decorators/serialize.decorator';
import { SessionContext } from './refresh-token.service';
import type { RequestWithUser } from './types';
import {
  clearRefreshCookie,
  isWebSession,
  moveRefreshTokenToCookie,
  readCookie,
  REFRESH_COOKIE,
  webDeviceKey,
} from './web-session';
import { WebSessionChangedException } from './web-session-changed.exception';

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

/** 传了 res 的路由（会发 token 的那几条）在网页端缺设备 cookie 时当场发一个。 */
function getSessionContext(req?: Request, res?: Response): SessionContext {
  if (!req) {
    return {};
  }

  return {
    deviceName: getHeaderValue(req.headers['x-device-name']),
    // 用 Express 的 req.ip（setup.ts 里 trust proxy = 1，取的是反代填的那一跳）。
    // request-ip 会优先信任客户端自带的 X-Client-IP 等头，可伪造——这个 IP 用于
    // 按来源限流陌生设备验证、并展示在受信任设备的批准弹窗里。
    ip: req.ip ?? null,
    userAgent: getHeaderValue(req.headers['user-agent']),
    // 客户端安全存储里的随机设备 ID，只以哈希形式进入服务端。网页端的设备 ID
    // 在 HttpOnly cookie 里（脚本拿不到，也就不会带 X-Device-Id）。
    deviceKey: isWebSession(req)
      ? webDeviceKey(req, res)
      : hashDeviceId(getHeaderValue(req.headers['x-device-id'])),
    stableDeviceKey: hashStableDeviceId(
      getHeaderValue(req.headers['x-stable-device-id']),
    ),
  };
}

/** 原生 App 的 refresh token 仍在请求体里，缺了照旧 400。 */
function bodyRefreshToken(dto: SessionRefreshTokenDto): string {
  if (!dto.refreshToken) {
    throw new BadRequestException('refreshToken should not be empty');
  }
  return dto.refreshToken;
}

function webSessionBinding(
  req: Request,
  allowRestore = false,
): string | undefined {
  const authorization = getHeaderValue(req.headers.authorization) ?? '';
  const binding = /^WebSession (\S+)$/i.exec(authorization)?.[1];
  if (allowRestore && binding === 'restore') return undefined;
  if (binding && isUUID(binding, '4')) return binding;
  throw new WebSessionChangedException();
}

/**
 * 网页端会话模式（见 web-session.ts）：refresh token 写进 HttpOnly cookie `circle_rt`，
 * 响应体只有 `{ accessToken }`；设备 ID 取自 cookie `circle_did`，不读 X-Device-Id。
 */
const ApiWebSessionHeader = () =>
  ApiHeader({
    name: 'X-Web-Session',
    required: false,
    description:
      "Web client only, value '1'. The refresh token is set as the HttpOnly cookie circle_rt (Path=/api/v1/auth); the response exposes only accessToken. Refresh and logout require Authorization: WebSession <session UUID>. A cold-start refresh uses Authorization: WebSession restore. The device id comes from the HttpOnly cookie circle_did instead of X-Device-Id.",
  });

@Controller('auth')
@ApiTags('Auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private deviceTrust: DeviceTrustService,
    private refreshTokens: RefreshTokenService,
    private securityQuestions: SecurityQuestionsService,
  ) {}

  /**
   * 批准方的设备：只认会话绑定的设备（不可伪造）。
   *
   * 功能上线前签发的老会话还没绑定设备。这里不能凭 access token 把请求头里的
   * 设备 ID 绑上去——偷到一枚短期 access token 就能换来永久信任，还会把本人的
   * 会话族绑到别人的设备上。改为返回 AUTH_SESSION_DEVICE_UNBOUND：客户端用
   * refresh token 续签一次（续签时绑定设备并补记信任），再重试。
   */
  private async approverDeviceKey(req: RequestWithUser) {
    const { userId, sessionId } = req.user;
    const bound = sessionId
      ? await this.refreshTokens.findSessionDeviceKey(userId, sessionId)
      : null;
    if (bound) return bound;
    if (getSessionContext(req).deviceKey) {
      throw new ConflictException({
        message: '登录状态需要更新，请稍后重试',
        errorCode: AuthErrorCode.SessionDeviceUnbound,
      });
    }
    return null;
  }

  /** 网页端：发出的 refresh token 写进 cookie，响应体只留 access token。 */
  private respond<T extends object>(req: Request, res: Response, result: T) {
    return isWebSession(req)
      ? moveRefreshTokenToCookie(
          res,
          result,
          this.refreshTokens.ttlMsFor('APP'),
        )
      : result;
  }

  @AnonymousAccess('Account registration')
  @Post('register')
  @ApiWebSessionHeader()
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({ type: RegisterDto })
  @ApiHeader({
    name: 'x-device-name',
    required: false,
    description: 'Optional device name to store with the refresh session',
  })
  @ApiCreatedResponse({
    description: 'User registered successfully',
    type: AuthTokensDto,
  })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(
      req,
      res,
      await this.authService.register(dto, getSessionContext(req, res)),
    );
  }

  @AnonymousAccess('Password login')
  @Post('login')
  @ApiWebSessionHeader()
  @ApiOperation({ summary: 'Login with email or user ID and password' })
  @ApiBody({ type: LoginDto })
  @ApiHeader({
    name: 'x-device-name',
    required: false,
    description: 'Optional device name to store with the refresh session',
  })
  @ApiCreatedResponse({ description: 'Login successful', type: AuthTokensDto })
  @ApiForbiddenResponse({
    description: 'Invalid credentials or inactive account',
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(
      req,
      res,
      await this.authService.login(dto, getSessionContext(req, res)),
    );
  }

  @AnonymousAccess('One-time trusted-device code')
  @Post('login-challenges/:challengeId/verify')
  @ApiWebSessionHeader()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'New device: submit the code shown on a trusted device',
  })
  @ApiHeader({ name: 'x-device-id', required: true })
  @ApiBody({ type: LoginChallengeCodeDto })
  @ApiCreatedResponse({ type: AuthTokensDto })
  async verifyLoginChallenge(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Body() dto: LoginChallengeCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(
      req,
      res,
      await this.authService.verifyLoginChallengeCode(
        challengeId,
        dto.code,
        getSessionContext(req, res),
      ),
    );
  }

  @AnonymousAccess('Login challenge and security code')
  @Post('login-challenges/:challengeId/security-code')
  @ApiWebSessionHeader()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'New device: pass verification with the login security code',
  })
  @ApiHeader({ name: 'x-device-id', required: true })
  @ApiBody({ type: LoginSecurityCodeDto })
  @ApiCreatedResponse({ type: AuthTokensDto })
  async verifyLoginChallengeSecurityCode(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Body() dto: LoginSecurityCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(
      req,
      res,
      await this.authService.verifyLoginChallengeSecurityCode(
        challengeId,
        dto.securityCode,
        getSessionContext(req, res),
      ),
    );
  }

  @AnonymousAccess('Device-bound login challenge')
  @Get('login-challenges/:challengeId/security-questions')
  @Header('Cache-Control', 'no-store')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'New device: which security questions the account has set',
  })
  @ApiHeader({ name: 'x-device-id', required: true })
  loginChallengeSecurityQuestions(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Req() req: Request,
  ) {
    return this.authService.loginChallengeSecurityQuestions(
      challengeId,
      getSessionContext(req).deviceKey ?? null,
    );
  }

  @AnonymousAccess('Login challenge and security answers')
  @Post('login-challenges/:challengeId/security-questions')
  @ApiWebSessionHeader()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'New device: pass verification by answering the security questions',
  })
  @ApiHeader({ name: 'x-device-id', required: true })
  @ApiBody({ type: VerifySecurityQuestionsDto })
  @ApiCreatedResponse({ type: AuthTokensDto })
  async verifyLoginChallengeSecurityQuestions(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Body() dto: VerifySecurityQuestionsDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(
      req,
      res,
      await this.authService.verifyLoginChallengeSecurityQuestions(
        challengeId,
        dto.answers,
        getSessionContext(req, res),
      ),
    );
  }

  @AnonymousAccess('Device-bound login challenge')
  @Post('login-challenges/:challengeId/resend')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'New device: start a new verification request' })
  @ApiHeader({ name: 'x-device-id', required: true })
  resendLoginChallenge(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Req() req: Request,
  ) {
    return this.authService.resendLoginChallenge(
      challengeId,
      getSessionContext(req).deviceKey ?? null,
    );
  }

  @AnonymousAccess('Device-bound login challenge and recovery waiting period')
  @Post('login-challenges/:challengeId/recovery')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'New device: no trusted device available — request recovery after a waiting period',
  })
  @ApiHeader({ name: 'x-device-id', required: true })
  requestLoginRecovery(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Req() req: Request,
  ) {
    return this.authService.requestLoginRecovery(
      challengeId,
      getSessionContext(req).deviceKey ?? null,
    );
  }

  @AnonymousAccess('Device-bound login challenge')
  @Get('login-challenges/:challengeId/status')
  // 状态每几秒就变，绝不能被任何一层缓存。
  @Header('Cache-Control', 'no-store')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'New device: poll verification status' })
  @ApiHeader({ name: 'x-device-id', required: true })
  loginChallengeStatus(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Req() req: Request,
  ) {
    return this.deviceTrust.status(
      challengeId,
      getSessionContext(req).deviceKey ?? null,
    );
  }

  @Get('login-challenges')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Trusted device: pending login requests from unknown devices',
  })
  async pendingLoginChallenges(@Req() req: RequestWithUser) {
    return this.deviceTrust.listPending(
      req.user.userId,
      await this.approverDeviceKey(req),
    );
  }

  @Post('login-challenges/:challengeId/approve')
  @UseGuards(JwtGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Trusted device: approve and get a one-time code (60s)',
  })
  async approveLoginChallenge(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.deviceTrust.approve(
      req.user.userId,
      await this.approverDeviceKey(req),
      challengeId,
    );
  }

  @Post('login-challenges/:challengeId/reject')
  @UseGuards(JwtGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Trusted device: reject the login request' })
  async rejectLoginChallenge(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Req() req: RequestWithUser,
  ) {
    await this.deviceTrust.reject(
      req.user.userId,
      await this.approverDeviceKey(req),
      challengeId,
    );
  }

  @AnonymousAccess('Admin password login')
  @Post('admin/login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Admin web login with password' })
  @ApiBody({ type: LoginDto })
  @ApiHeader({
    name: 'x-device-name',
    required: false,
    description: 'Optional device name to store with the admin refresh session',
  })
  @ApiCreatedResponse({
    description: 'Admin login successful',
    type: AuthTokensDto,
  })
  @ApiForbiddenResponse({
    description: 'Invalid credentials, inactive account, or non-admin user',
  })
  adminLogin(@Body() dto: LoginDto, @Req() req?: Request) {
    return this.authService.adminLogin(dto, getSessionContext(req));
  }

  @AnonymousAccess('Refresh token credential')
  @Post('refresh')
  @ApiWebSessionHeader()
  @ApiOperation({ summary: 'Refresh an access token' })
  @ApiBody({ type: SessionRefreshTokenDto })
  @ApiHeader({
    name: 'x-device-name',
    required: false,
    description: 'Optional device name to update for the rotated session',
  })
  @ApiHeader({
    name: 'x-stable-device-id',
    required: false,
    description:
      'Android only: the ANDROID_ID-derived device id this install would use after a reinstall',
  })
  @ApiHeader({
    name: 'idempotency-key',
    required: false,
    description:
      'UUID v4 of this refresh attempt; resent unchanged when the previous result never arrived',
  })
  @ApiCreatedResponse({
    description: 'Token refreshed successfully',
    type: AuthTokensDto,
  })
  async refresh(
    @Body() dto: SessionRefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const attemptId = getHeaderValue(req.headers['idempotency-key']);
    const context = {
      ...getSessionContext(req, res),
      rotationAttemptId: attemptId && isUUID(attemptId, '4') ? attemptId : null,
      requestReceivedAt: new Date(),
    };
    if (!isWebSession(req)) {
      return this.authService.refresh(bodyRefreshToken(dto), context);
    }
    try {
      const refreshToken = readCookie(req, REFRESH_COOKIE);
      if (!refreshToken) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }
      return this.respond(
        req,
        res,
        await this.authService.refresh(refreshToken, {
          ...context,
          expectedSessionId: webSessionBinding(req, true),
        }),
      );
    } catch (error) {
      // 死掉的 refresh token 别让浏览器一直重放；设备 cookie 保留。
      if (error instanceof UnauthorizedException) clearRefreshCookie(res);
      throw error;
    }
  }

  @AnonymousAccess('Admin refresh token credential')
  @Post('admin/refresh')
  @ApiOperation({ summary: 'Refresh an admin web access token' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiHeader({
    name: 'x-device-name',
    required: false,
    description: 'Optional device name to update for the rotated admin session',
  })
  @ApiCreatedResponse({
    description: 'Admin token refreshed successfully',
    type: AuthTokensDto,
  })
  adminRefresh(@Body() dto: RefreshTokenDto, @Req() req?: Request) {
    return this.authService.adminRefresh(
      dto.refreshToken,
      getSessionContext(req),
    );
  }

  @AnonymousAccess('Refresh token revocation')
  @Post('logout')
  @ApiWebSessionHeader()
  @ApiOperation({ summary: 'Logout and revoke a refresh token' })
  @ApiBody({ type: SessionRefreshTokenDto })
  @ApiOkResponse({ description: 'Logout successful' })
  async logout(
    @Body() dto: SessionRefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!isWebSession(req)) {
      return this.authService.logout(
        bodyRefreshToken(dto),
        getSessionContext(req),
      );
    }
    const refreshToken = readCookie(req, REFRESH_COOKIE);
    if (refreshToken) {
      await this.authService.logout(refreshToken, {
        ...getSessionContext(req),
        expectedSessionId: webSessionBinding(req),
      });
    }
    clearRefreshCookie(res);
  }

  @Get('sessions')
  @UseGuards(JwtGuard)
  @Serialize(AuthSessionDto)
  @ApiOperation({ summary: 'List active device sessions for the current user' })
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Active refresh token sessions',
    type: AuthSessionDto,
    isArray: true,
  })
  sessions(@Req() req: RequestWithUser) {
    return this.authService.sessions(req.user.userId, req.user.sessionId);
  }

  @Post('logout-all')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Logout all devices for the current user' })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'All device sessions revoked' })
  logoutAll(@Req() req: RequestWithUser) {
    return this.authService.logoutAll(req.user.userId, req.user.sessionId);
  }

  @Delete('sessions/:sessionId')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Logout a selected device session' })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Selected session revoked' })
  logoutSession(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.authService.logoutSession(
      req.user.userId,
      sessionId,
      req.user.sessionId,
    );
  }

  @Post('logout-others')
  @UseGuards(JwtGuard)
  @ApiOperation({
    summary: 'Logout all device sessions except the current one',
  })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Other sessions revoked' })
  logoutOtherSessions(@Req() req: RequestWithUser) {
    return this.authService.logoutOtherSessions(
      req.user.userId,
      req.user.sessionId,
    );
  }

  @Get('single-device-login')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Get single-device login setting' })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Single-device login status' })
  getSingleDeviceLoginStatus(@Req() req: RequestWithUser) {
    return this.authService.getSingleDeviceLoginStatus(req.user.userId);
  }

  @Put('single-device-login')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Update single-device login setting' })
  @ApiBearerAuth()
  @ApiBody({ type: SingleDeviceLoginDto })
  @ApiOkResponse({ description: 'Single-device login setting updated' })
  setSingleDeviceLogin(
    @Body() dto: SingleDeviceLoginDto,
    @Req() req: RequestWithUser,
  ) {
    return this.authService.setSingleDeviceLogin(
      req.user.userId,
      dto.enabled,
      req.user.sessionId,
    );
  }

  @AnonymousAccess('Password recovery request')
  @Post('password/reset-request')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Request a password-reset code (FE#92; silent for unknown emails)',
  })
  @ApiBody({ type: RequestPasswordResetDto })
  @ApiCreatedResponse({ description: 'Code sent (or silently ignored)' })
  requestPasswordReset(@Body() dto: RequestPasswordResetDto) {
    return this.authService.requestPasswordReset(dto.email);
  }

  @AnonymousAccess('Password recovery code')
  @Post('password/reset')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Reset password with an emailed code (revokes all sessions)',
  })
  @ApiBody({ type: ResetPasswordDto })
  @ApiOkResponse({ description: 'Password reset' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.email, dto.code, dto.newPassword);
  }

  @Post('change-password')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Change password (invalidates all sessions)' })
  @ApiBearerAuth()
  @ApiBody({ type: ChangePasswordDto })
  @ApiOkResponse({ description: 'Password changed successfully' })
  changePassword(@Body() dto: ChangePasswordDto, @Req() req: RequestWithUser) {
    return this.authService.changePassword(
      req.user.userId,
      dto.oldPassword,
      dto.newPassword,
      req.user.sessionId,
    );
  }

  @Post('email/change-request')
  @UseGuards(JwtGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiBearerAuth()
  requestEmailChange(
    @Body() dto: RequestEmailChangeDto,
    @Req() req: RequestWithUser,
  ) {
    return this.authService.requestEmailChange(
      req.user.userId,
      dto.email,
      dto.password,
    );
  }

  @Post('email/change')
  @UseGuards(JwtGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  changeEmail(@Body() dto: ChangeEmailDto, @Req() req: RequestWithUser) {
    return this.authService.changeEmail(
      req.user.userId,
      dto.email,
      dto.password,
      dto.code,
    );
  }

  @Post('change-account-id')
  @UseGuards(JwtGuard)
  @Serialize(SelfUserDto)
  @ApiOperation({ summary: 'Change account ID (login & friend-search handle)' })
  @ApiBearerAuth()
  @ApiBody({ type: ChangeAccountIdDto })
  @ApiOkResponse({ description: 'Account ID changed', type: SelfUserDto })
  changeAccountId(
    @Body() dto: ChangeAccountIdDto,
    @Req() req: RequestWithUser,
  ) {
    return this.authService.changeAccountId(req.user.userId, dto.accountId);
  }

  @Get('security-questions')
  @UseGuards(JwtGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Security questions the account has set' })
  @ApiBearerAuth()
  async getSecurityQuestions(@Req() req: RequestWithUser) {
    return {
      questionKeys: await this.securityQuestions.questionKeys(req.user.userId),
    };
  }

  @Put('security-questions')
  @UseGuards(JwtGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Set or replace the two security questions' })
  @ApiBearerAuth()
  @ApiBody({ type: SetSecurityQuestionsDto })
  setSecurityQuestions(
    @Body() dto: SetSecurityQuestionsDto,
    @Req() req: RequestWithUser,
  ) {
    return this.securityQuestions.set(
      req.user.userId,
      dto.password,
      dto.questions,
    );
  }

  @Get('security-code')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Get login security code status' })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Login security code status' })
  getLoginSecurityCodeStatus(@Req() req: RequestWithUser) {
    return this.authService.getLoginSecurityCodeStatus(req.user.userId);
  }

  @Put('security-code')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Enable or change login security code' })
  @ApiBearerAuth()
  @ApiBody({ type: SetLoginSecurityCodeDto })
  @ApiOkResponse({ description: 'Login security code saved' })
  setLoginSecurityCode(
    @Body() dto: SetLoginSecurityCodeDto,
    @Req() req: RequestWithUser,
  ) {
    return this.authService.setLoginSecurityCode(
      req.user.userId,
      dto.securityCode,
      dto.oldSecurityCode,
    );
  }

  @Delete('security-code')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Disable login security code' })
  @ApiBearerAuth()
  @ApiBody({ type: LoginSecurityCodeDto })
  @ApiOkResponse({ description: 'Login security code disabled' })
  disableLoginSecurityCode(
    @Body() dto: LoginSecurityCodeDto,
    @Req() req: RequestWithUser,
  ) {
    return this.authService.disableLoginSecurityCode(
      req.user.userId,
      dto.securityCode,
    );
  }

  @Post('security-code/verify')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Verify login security code' })
  @ApiBearerAuth()
  @ApiBody({ type: LoginSecurityCodeDto })
  @ApiOkResponse({ description: 'Login security code verification result' })
  verifyLoginSecurityCode(
    @Body() dto: LoginSecurityCodeDto,
    @Req() req: RequestWithUser,
  ) {
    return this.authService.verifyLoginSecurityCode(
      req.user.userId,
      dto.securityCode,
    );
  }

  @Get('me')
  @UseGuards(JwtGuard)
  @Serialize(SelfUserDto)
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Current user profile', type: SelfUserDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token' })
  me(@Req() req: RequestWithUser) {
    return this.authService.me(req.user.userId);
  }
}

import { AnonymousAccess } from 'src/guards/anonymous-access.decorator';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import {
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
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
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
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeAccountIdDto } from './dto/change-account-id.dto';
import {
  LoginSecurityCodeDto,
  SetLoginSecurityCodeDto,
} from './dto/login-security-code.dto';
import { SingleDeviceLoginDto } from './dto/single-device-login.dto';
import { LoginChallengeCodeDto } from './dto/login-challenge.dto';
import { DeviceTrustService, hashDeviceId } from './device-trust.service';
import { RefreshTokenService } from './refresh-token.service';
import { SelfUserDto } from 'src/user/dto/public-user.dto';
import { Serialize } from 'src/decorators/serialize.decorator';
import { SessionContext } from './refresh-token.service';
import type { RequestWithUser } from './types';

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

function getSessionContext(req?: Request): SessionContext {
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
    // 客户端安全存储里的随机设备 ID，只以哈希形式进入服务端。
    deviceKey: hashDeviceId(getHeaderValue(req.headers['x-device-id'])),
  };
}

@Controller('auth')
@ApiTags('Auth')
export class AuthController {
  constructor(
    private authService: AuthService,
    private deviceTrust: DeviceTrustService,
    private refreshTokens: RefreshTokenService,
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

  @AnonymousAccess('Account registration')
  @Post('register')
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
  register(@Body() dto: RegisterDto, @Req() req?: Request) {
    return this.authService.register(dto, getSessionContext(req));
  }

  @AnonymousAccess('Password login')
  @Post('login')
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
  login(@Body() dto: LoginDto, @Req() req?: Request) {
    return this.authService.login(dto, getSessionContext(req));
  }

  @AnonymousAccess('One-time trusted-device code')
  @Post('login-challenges/:challengeId/verify')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'New device: submit the code shown on a trusted device',
  })
  @ApiHeader({ name: 'x-device-id', required: true })
  @ApiBody({ type: LoginChallengeCodeDto })
  @ApiCreatedResponse({ type: AuthTokensDto })
  verifyLoginChallenge(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Body() dto: LoginChallengeCodeDto,
    @Req() req: Request,
  ) {
    return this.authService.verifyLoginChallengeCode(
      challengeId,
      dto.code,
      getSessionContext(req),
    );
  }

  @AnonymousAccess('Login challenge and security code')
  @Post('login-challenges/:challengeId/security-code')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'New device: pass verification with the login security code',
  })
  @ApiHeader({ name: 'x-device-id', required: true })
  @ApiBody({ type: LoginSecurityCodeDto })
  @ApiCreatedResponse({ type: AuthTokensDto })
  verifyLoginChallengeSecurityCode(
    @Param('challengeId', ParseUUIDPipe) challengeId: string,
    @Body() dto: LoginSecurityCodeDto,
    @Req() req: Request,
  ) {
    return this.authService.verifyLoginChallengeSecurityCode(
      challengeId,
      dto.securityCode,
      getSessionContext(req),
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
  @ApiOperation({ summary: 'Refresh an access token' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiHeader({
    name: 'x-device-name',
    required: false,
    description: 'Optional device name to update for the rotated session',
  })
  @ApiCreatedResponse({
    description: 'Token refreshed successfully',
    type: AuthTokensDto,
  })
  refresh(@Body() dto: RefreshTokenDto, @Req() req?: Request) {
    return this.authService.refresh(dto.refreshToken, getSessionContext(req));
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
  @ApiOperation({ summary: 'Logout and revoke a refresh token' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({ description: 'Logout successful' })
  logout(@Body() dto: RefreshTokenDto, @Req() req?: Request) {
    return this.authService.logout(dto.refreshToken, getSessionContext(req));
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

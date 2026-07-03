import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import * as requestIp from 'request-ip';
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
import { AuthService } from './auth.service';
import { AuthSessionDto } from './dto/auth-session.dto';
import { AuthTokensDto } from './dto/auth-tokens.dto';
import { LoginDto } from './dto/login.dto';
import { LoginWithCodeDto } from './dto/login-with-code.dto';
import { RequestEmailCodeDto } from './dto/request-email-code.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeAccountIdDto } from './dto/change-account-id.dto';
import {
  LoginSecurityCodeDto,
  SetLoginSecurityCodeDto,
} from './dto/login-security-code.dto';
import { SingleDeviceLoginDto } from './dto/single-device-login.dto';
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
    ip: requestIp.getClientIp(req) ?? req.ip ?? null,
    userAgent: getHeaderValue(req.headers['user-agent']),
  };
}

@Controller('auth')
@ApiTags('Auth')
export class AuthController {
  constructor(private authService: AuthService) {}

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

  @Post('login')
  @ApiOperation({ summary: 'Login with username and password' })
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

  @Post('admin/login')
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

  @Post('email/request-code')
  @ApiOperation({ summary: 'Request an email verification code' })
  @ApiBody({ type: RequestEmailCodeDto })
  @ApiCreatedResponse({
    description: 'Verification code sent (or silently ignored)',
  })
  requestEmailCode(@Body() dto: RequestEmailCodeDto) {
    return this.authService.requestEmailCode(dto.email, dto.purpose);
  }

  @Post('login/code')
  @ApiOperation({ summary: 'Login with email and verification code' })
  @ApiBody({ type: LoginWithCodeDto })
  @ApiHeader({
    name: 'x-device-name',
    required: false,
    description: 'Optional device name to store with the refresh session',
  })
  @ApiCreatedResponse({ description: 'Login successful', type: AuthTokensDto })
  @ApiForbiddenResponse({ description: 'Invalid or expired code' })
  loginWithCode(@Body() dto: LoginWithCodeDto, @Req() req?: Request) {
    return this.authService.loginWithCode(dto, getSessionContext(req));
  }

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

  @Post('logout')
  @ApiOperation({ summary: 'Logout and revoke a refresh token' })
  @ApiBody({ type: RefreshTokenDto })
  @ApiOkResponse({ description: 'Logout successful' })
  logout(@Body() dto: RefreshTokenDto) {
    return this.authService.logout(dto.refreshToken);
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
    return this.authService.logoutAll(req.user.userId);
  }

  @Delete('sessions/:sessionId')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Logout a selected device session' })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'Selected session revoked' })
  logoutSession(
    @Param('sessionId') sessionId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.authService.logoutSession(req.user.userId, sessionId);
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

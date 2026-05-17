import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
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
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
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
    return this.authService.sessions(req.user.userId);
  }

  @Post('logout-all')
  @UseGuards(JwtGuard)
  @ApiOperation({ summary: 'Logout all devices for the current user' })
  @ApiBearerAuth()
  @ApiOkResponse({ description: 'All device sessions revoked' })
  logoutAll(@Req() req: RequestWithUser) {
    return this.authService.logoutAll(req.user.userId);
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

import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { SetLoginSecurityCodeDto } from '../dto/login-security-code.dto';

describe('AuthController', () => {
  let controller: AuthController;

  const mockTokenPayload = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  };

  const mockAuthService: Partial<AuthService> = {
    register: (_dto: RegisterDto) => Promise.resolve(mockTokenPayload as any),
    login: (_dto: LoginDto) => Promise.resolve(mockTokenPayload as any),
    adminLogin: (_dto: LoginDto) => Promise.resolve(mockTokenPayload as any),
    loginWithCode: (_dto: any) => Promise.resolve(mockTokenPayload as any),
    requestEmailCode: jest.fn((_email: string, _purpose: string) =>
      Promise.resolve(),
    ),
    refresh: (_token: string) => Promise.resolve(mockTokenPayload as any),
    adminRefresh: (_token: string) => Promise.resolve(mockTokenPayload as any),
    logout: (_token: string) => Promise.resolve(),
    sessions: jest.fn((_userId: string) =>
      Promise.resolve([
        {
          id: 'session-1',
          isCurrent: true,
          deviceName: 'MacBook Pro',
          ip: '127.0.0.1',
          userAgent: 'PostmanRuntime',
          createdAt: new Date(),
          lastUsedAt: new Date(),
          expiredAt: new Date(Date.now() + 1000 * 60 * 60),
        },
      ]),
    ),
    logoutAll: jest.fn((_userId: string) => Promise.resolve()),
    logoutSession: jest.fn((_userId: string, _sessionId: string) =>
      Promise.resolve(),
    ),
    logoutOtherSessions: jest.fn((_userId: string, _sessionId?: string) =>
      Promise.resolve(),
    ),
    getSingleDeviceLoginStatus: jest.fn((_userId: string) =>
      Promise.resolve({ enabled: false }),
    ),
    setSingleDeviceLogin: jest.fn(
      (_userId: string, _enabled: boolean, _sessionId?: string) =>
        Promise.resolve(),
    ),
    getLoginSecurityCodeStatus: jest.fn((_userId: string) =>
      Promise.resolve({ enabled: true }),
    ),
    setLoginSecurityCode: jest.fn(
      (_userId: string, _securityCode: string, _oldSecurityCode?: string) =>
        Promise.resolve(),
    ),
    disableLoginSecurityCode: jest.fn(
      (_userId: string, _securityCode: string) => Promise.resolve(),
    ),
    verifyLoginSecurityCode: jest.fn((_userId: string, _securityCode: string) =>
      Promise.resolve({ ok: true }),
    ),
    me: (_userId: string) =>
      Promise.resolve({
        id: 'uuid-1',
        accountId: 'testuser',
        nickname: 'Test User',
        avatarUrl: null,
        avatarFrame: null,
        cover: null,
        email: null,
        phoneNumber: null,
        wechat: null,
        qq: null,
        whatsup: null,
        persona: null,
        helloWords: null,
        birthday: null,
        gender: 'unset',
        city: null,
        region: null,
        vipLevel: 0,
        creditScore: 0,
        role: 'USER',
        status: 'ACTIVE',
        lastOnline: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        displayIcons: [],
      }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('register returns tokens', async () => {
    const result = await controller.register({
      email: 'user@example.com',
      code: '123456',
      password: 'password1',
      nickname: 'Test User',
    } as any);
    expect(result).toEqual(mockTokenPayload);
  });

  it('login returns tokens', async () => {
    const result = await controller.login({
      email: 'user@example.com',
      password: 'password1',
    } as any);
    expect(result).toEqual(mockTokenPayload);
  });

  it('adminLogin returns admin-scoped tokens', async () => {
    const result = await controller.adminLogin({
      email: 'admin@example.com',
      password: 'password1',
    } as any);

    expect(result).toEqual(mockTokenPayload);
  });

  it('loginWithCode returns tokens', async () => {
    const result = await controller.loginWithCode({
      email: 'user@example.com',
      code: '123456',
    } as any);
    expect(result).toEqual(mockTokenPayload);
  });

  it('requestEmailCode maps purpose and delegates to service', async () => {
    await controller.requestEmailCode({
      email: 'user@example.com',
      purpose: 'register',
    });
    expect(mockAuthService.requestEmailCode).toHaveBeenCalledWith(
      'user@example.com',
      'register',
    );
  });

  it('refresh returns tokens', async () => {
    const dto: RefreshTokenDto = { refreshToken: 'refresh-token' };
    const result = await controller.refresh(dto);
    expect(result).toEqual(mockTokenPayload);
  });

  it('adminRefresh returns admin-scoped tokens', async () => {
    const dto: RefreshTokenDto = { refreshToken: 'refresh-token' };
    const result = await controller.adminRefresh(dto);
    expect(result).toEqual(mockTokenPayload);
  });

  it('sessions returns the current user sessions', async () => {
    const result = await controller.sessions({
      user: { userId: 'uuid-1', sessionId: 'session-1' },
    } as any);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('session-1');
    expect(mockAuthService.sessions).toHaveBeenCalledWith(
      'uuid-1',
      'session-1',
    );
  });

  it('logoutAll revokes all sessions for the current user', async () => {
    await controller.logoutAll({ user: { userId: 'uuid-1' } } as any);

    expect(mockAuthService.logoutAll).toHaveBeenCalledWith('uuid-1');
  });

  it('logoutSession revokes a selected session for the current user', async () => {
    await controller.logoutSession('session-2', {
      user: { userId: 'uuid-1' },
    } as any);

    expect(mockAuthService.logoutSession).toHaveBeenCalledWith(
      'uuid-1',
      'session-2',
    );
  });

  it('logoutOtherSessions keeps the current session and revokes the rest', async () => {
    await controller.logoutOtherSessions({
      user: { userId: 'uuid-1', sessionId: 'session-1' },
    } as any);

    expect(mockAuthService.logoutOtherSessions).toHaveBeenCalledWith(
      'uuid-1',
      'session-1',
    );
  });

  it('gets and updates single-device login status', async () => {
    await expect(
      controller.getSingleDeviceLoginStatus({
        user: { userId: 'uuid-1' },
      } as any),
    ).resolves.toEqual({ enabled: false });

    await controller.setSingleDeviceLogin({ enabled: true }, {
      user: { userId: 'uuid-1', sessionId: 'session-1' },
    } as any);

    expect(mockAuthService.setSingleDeviceLogin).toHaveBeenCalledWith(
      'uuid-1',
      true,
      'session-1',
    );
  });

  it('returns login security code status for the current user', async () => {
    const result = await controller.getLoginSecurityCodeStatus({
      user: { userId: 'uuid-1' },
    } as any);

    expect(result).toEqual({ enabled: true });
    expect(mockAuthService.getLoginSecurityCodeStatus).toHaveBeenCalledWith(
      'uuid-1',
    );
  });

  it('sets login security code for the current user', async () => {
    const dto: SetLoginSecurityCodeDto = {
      securityCode: '1234',
      oldSecurityCode: '654321',
    };

    await controller.setLoginSecurityCode(dto, {
      user: { userId: 'uuid-1' },
    } as any);

    expect(mockAuthService.setLoginSecurityCode).toHaveBeenCalledWith(
      'uuid-1',
      '1234',
      '654321',
    );
  });

  it('disables login security code for the current user', async () => {
    await controller.disableLoginSecurityCode({ securityCode: '1234' }, {
      user: { userId: 'uuid-1' },
    } as any);

    expect(mockAuthService.disableLoginSecurityCode).toHaveBeenCalledWith(
      'uuid-1',
      '1234',
    );
  });

  it('verifies login security code for the current user', async () => {
    const result = await controller.verifyLoginSecurityCode(
      { securityCode: '1234' },
      {
        user: { userId: 'uuid-1' },
      } as any,
    );

    expect(result).toEqual({ ok: true });
    expect(mockAuthService.verifyLoginSecurityCode).toHaveBeenCalledWith(
      'uuid-1',
      '1234',
    );
  });
});

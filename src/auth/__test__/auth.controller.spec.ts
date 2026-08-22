import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AuthController, getQrLoginStatusTracker } from '../auth.controller';
import { QrLoginService } from '../qr-login.service';
import { AuthService } from '../auth.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { SetLoginSecurityCodeDto } from '../dto/login-security-code.dto';
import request from 'supertest';

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
        inviteCode: 'testuser',
        nickname: 'Test User',
        avatarUrl: null,
        avatarFrame: null,
        avatarFrameAppearance: null,
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
        storedVipLevel: 0,
        vipExpiresAt: null,
        membership: {
          effectiveLevel: 0,
          key: 'regular',
          appearance: { nameColor: 'default', badge: null },
          active: false,
          lifetime: false,
        },
        creditScore: 0,
        receivedLikeCount: 0,
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
      // 找回密码路由挂 ThrottlerGuard，需要模块选项在位（本 spec 直呼 handler）。
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        {
          provide: QrLoginService,
          useValue: {
            create: jest.fn(),
            status: jest.fn(),
            approve: jest.fn(),
          },
        },
      ],
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

const mockAuthServiceForQr: Partial<AuthService> = {};

describe('AuthController 扫码登录端点的传输面', () => {
  const qrLoginService = {
    create: jest.fn(),
    status: jest.fn().mockResolvedValue({ status: 'PENDING' }),
    approve: jest.fn(),
  };
  let controller: AuthController;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }])],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthServiceForQr },
        { provide: QrLoginService, useValue: qrLoginService },
      ],
    }).compile();
    controller = module.get<AuthController>(AuthController);
  });

  it('轮询凭证从 body 读，不经过 query', async () => {
    await controller.qrLoginStatus('qr-token', { pollKey: 'secret-key' });
    expect(qrLoginService.status).toHaveBeenCalledWith(
      'qr-token',
      'secret-key',
      {},
    );
  });

  it('创建会话记录服务端看到的浏览器上下文', async () => {
    await controller.createQrLogin({
      headers: { 'user-agent': 'Chrome on macOS' },
      ip: '203.0.113.10',
    } as any);
    expect(qrLoginService.create).toHaveBeenCalledWith({
      deviceName: null,
      ip: '203.0.113.10',
      userAgent: 'Chrome on macOS',
    });
  });

  it('同 IP 的不同二维码使用独立 session tracker', async () => {
    const first = await getQrLoginStatusTracker(
      {
        ip: '203.0.113.10',
        params: { token: 'a'.repeat(32) },
        body: { pollKey: 'p'.repeat(32) },
      },
      {} as never,
    );
    const second = await getQrLoginStatusTracker(
      {
        ip: '203.0.113.10',
        params: { token: 'b'.repeat(32) },
        body: { pollKey: 'p'.repeat(32) },
      },
      {} as never,
    );
    const sameFromAnotherIp = await getQrLoginStatusTracker(
      {
        ip: '203.0.113.11',
        params: { token: 'a'.repeat(32) },
        body: { pollKey: 'p'.repeat(32) },
      },
      {} as never,
    );
    const differentPollKey = await getQrLoginStatusTracker(
      {
        ip: '203.0.113.10',
        params: { token: 'a'.repeat(32) },
        body: { pollKey: 'x'.repeat(32) },
      },
      {} as never,
    );

    expect(first).not.toBe(second);
    expect(first).toBe(sameFromAnotherIp);
    expect(first).not.toBe(differentPollKey);
    expect(first).not.toContain('a'.repeat(32));
    expect(first).not.toContain('p'.repeat(32));
  });

  it('轮询走 POST + no-store：带令牌的响应不该被任何一层缓存', () => {
    const handler = AuthController.prototype.qrLoginStatus;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
      RequestMethod.POST,
    );
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      'qr-login/:token/status',
    );
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([
      { name: 'Cache-Control', value: 'no-store' },
    ]);
  });

  it('三个端点各自挂了 ThrottlerGuard（没有全局守卫兜底）', () => {
    // AppModule 没注册全局 ThrottlerGuard，光有 @Throttle 是不生效的限速牌。
    for (const handler of [
      AuthController.prototype.createQrLogin,
      AuthController.prototype.qrLoginStatus,
      AuthController.prototype.approveQrLogin,
    ]) {
      const guards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[];
      expect(guards).toContain(ThrottlerGuard);
    }
    // 确认端点仍然要求登录态。
    expect(
      Reflect.getMetadata(
        GUARDS_METADATA,
        AuthController.prototype.approveQrLogin,
      ),
    ).toContain(JwtGuard);
  });
});

describe('AuthController 扫码登录 session 限流', () => {
  let app: INestApplication;
  const qrLoginService = {
    create: jest.fn(),
    status: jest.fn().mockResolvedValue({ status: 'PENDING' }),
    approve: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([
          { name: 'default', ttl: 60_000, limit: 1_000 },
          { name: 'qrSession', ttl: 60_000, limit: 20 },
        ]),
      ],
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthServiceForQr },
        { provide: QrLoginService, useValue: qrLoginService },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('错误 pollKey 不会耗尽正确凭证的 session bucket', async () => {
    const token = 'q'.repeat(32);
    const wrongPollKey = 'w'.repeat(32);
    const correctPollKey = 'p'.repeat(32);
    const endpoint = `/auth/qr-login/${token}/status`;

    for (let index = 0; index < 20; index += 1) {
      await request(app.getHttpServer())
        .post(endpoint)
        .send({ pollKey: wrongPollKey })
        .expect(200);
    }
    await request(app.getHttpServer())
      .post(endpoint)
      .send({ pollKey: wrongPollKey })
      .expect(429);

    await request(app.getHttpServer())
      .post(endpoint)
      .send({ pollKey: correctPollKey })
      .expect(200);

    for (let index = 1; index < 20; index += 1) {
      await request(app.getHttpServer())
        .post(endpoint)
        .send({ pollKey: correctPollKey })
        .expect(200);
    }
    await request(app.getHttpServer())
      .post(endpoint)
      .send({ pollKey: correctPollKey })
      .expect(429);
  });
});

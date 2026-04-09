import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';

describe('AuthController', () => {
  let controller: AuthController;

  const mockTokenPayload = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  };

  const mockAuthService: Partial<AuthService> = {
    register: (_dto: RegisterDto) => Promise.resolve(mockTokenPayload as any),
    login: (_dto: LoginDto) => Promise.resolve(mockTokenPayload as any),
    refresh: (_token: string) => Promise.resolve(mockTokenPayload as any),
    logout: (_token: string) => Promise.resolve(),
    sessions: jest.fn((_userId: string) =>
      Promise.resolve([
        {
          id: 'session-1',
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
        role: 'USER',
        status: 'ACTIVE',
        lastOnline: null,
        createdAt: new Date(),
        updatedAt: new Date(),
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
    const dto: RegisterDto = {
      accountId: 'testuser',
      password: 'password1',
      nickname: 'Test User',
    };
    const result = await controller.register(dto);
    expect(result).toEqual(mockTokenPayload);
  });

  it('login returns tokens', async () => {
    const dto: LoginDto = { accountId: 'testuser', password: 'password1' };
    const result = await controller.login(dto);
    expect(result).toEqual(mockTokenPayload);
  });

  it('refresh returns tokens', async () => {
    const dto: RefreshTokenDto = { refreshToken: 'refresh-token' };
    const result = await controller.refresh(dto);
    expect(result).toEqual(mockTokenPayload);
  });

  it('sessions returns the current user sessions', async () => {
    const result = await controller.sessions({
      user: { userId: 'uuid-1' },
    } as any);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('session-1');
  });

  it('logoutAll revokes all sessions for the current user', async () => {
    await controller.logoutAll({ user: { userId: 'uuid-1' } } as any);

    expect(mockAuthService.logoutAll).toHaveBeenCalledWith('uuid-1');
  });
});

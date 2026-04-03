import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';

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
    me: (_userId: string) =>
      Promise.resolve({
        id: 'uuid-1',
        accountId: 'ACC_ABC123',
        username: 'testuser',
        nickname: 'Test User',
        avatarUrl: null,
        role: 'USER',
        status: 'ACTIVE',
        createdAt: new Date(),
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
      username: 'testuser',
      password: 'password1',
      nickname: 'Test User',
    };
    const result = await controller.register(dto);
    expect(result).toEqual(mockTokenPayload);
  });

  it('login returns tokens', async () => {
    const dto: LoginDto = { username: 'testuser', password: 'password1' };
    const result = await controller.login(dto);
    expect(result).toEqual(mockTokenPayload);
  });
});

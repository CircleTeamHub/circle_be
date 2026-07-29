import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { UserController } from '../user.controller';
import { UserService } from '../user.service';

describe('POST /user/appearances HTTP pipeline', () => {
  let app: INestApplication;
  const service = {
    getAppearances: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    service.getAppearances.mockResolvedValue({
      alias: { vipLevel: 0, avatarFrame: null },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [UserController],
      providers: [{ provide: UserService, useValue: service }],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): {
            getRequest(): {
              headers: Record<string, string | undefined>;
              user?: { userId: string };
            };
          };
        }) => {
          const req = context.switchToHttp().getRequest();
          if (req.headers.authorization !== 'Bearer valid-user-token') {
            throw new UnauthorizedException();
          }
          req.user = { userId: 'authenticated-user' };
          return true;
        },
      })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects requests without a valid JWT', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/user/appearances')
      .send({ ids: ['alias'] })
      .expect(401);

    expect(service.getAppearances).not.toHaveBeenCalled();
  });

  it('returns 200 and forwards permissive UUID/OpenIM-style aliases', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/user/appearances')
      .set('Authorization', 'Bearer valid-user-token')
      .send({ ids: ['alias', 'not-a-uuid'] })
      .expect(200)
      .expect({ alias: { vipLevel: 0, avatarFrame: null } });

    expect(service.getAppearances).toHaveBeenCalledWith([
      'alias',
      'not-a-uuid',
    ]);
  });

  it('accepts exactly 200 ids', async () => {
    const ids = Array.from({ length: 200 }, (_, index) => `alias-${index}`);

    await request(app.getHttpServer())
      .post('/api/v1/user/appearances')
      .set('Authorization', 'Bearer valid-user-token')
      .send({ ids })
      .expect(200);

    expect(service.getAppearances).toHaveBeenCalledWith(ids);
  });

  it.each([
    ['a missing ids field', {}],
    ['an empty ids array', { ids: [] }],
    [
      'more than 200 ids',
      {
        ids: Array.from({ length: 201 }, (_, index) => `alias-${index}`),
      },
    ],
    ['an extra field', { ids: ['alias'], userId: 'attacker-user' }],
  ])('rejects %s before calling the service', async (_case, body) => {
    await request(app.getHttpServer())
      .post('/api/v1/user/appearances')
      .set('Authorization', 'Bearer valid-user-token')
      .send(body)
      .expect(400);

    expect(service.getAppearances).not.toHaveBeenCalled();
  });
});

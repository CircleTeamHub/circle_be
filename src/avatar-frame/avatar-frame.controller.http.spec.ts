import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AvatarFrameController } from './avatar-frame.controller';
import { AvatarFrameService } from './avatar-frame.service';

describe('AvatarFrameController HTTP pipeline', () => {
  let app: INestApplication;
  const frameId = '10000000-0000-4000-8000-000000000001';
  const service = {
    getInventory: jest.fn(),
    setEquipped: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    service.getInventory.mockResolvedValue({
      equippedFrameId: null,
      items: [],
    });
    service.setEquipped.mockImplementation(
      (_userId: string, selectedFrameId: string | null) =>
        Promise.resolve({
          equippedFrameId: selectedFrameId,
          items: [],
        }),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [AvatarFrameController],
      providers: [{ provide: AvatarFrameService, useValue: service }],
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
          const request = context.switchToHttp().getRequest();
          if (request.headers.authorization !== 'Bearer valid-user-token') {
            throw new UnauthorizedException();
          }
          request.user = { userId: 'authenticated-user' };
          return true;
        },
      })
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

  it('rejects unauthenticated wardrobe requests', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/avatar-frames/me')
      .expect(401);
    await request(app.getHttpServer())
      .put('/api/v1/avatar-frames/me/equipped')
      .send({ frameId })
      .expect(401);

    expect(service.getInventory).not.toHaveBeenCalled();
    expect(service.setEquipped).not.toHaveBeenCalled();
  });

  it.each([
    ['missing frameId', {}],
    ['malformed frameId', { frameId: 'not-a-uuid' }],
    ['an extra identity field', { frameId, userId: 'attacker-user' }],
  ])('rejects %s before calling the service', async (_case, body) => {
    await request(app.getHttpServer())
      .put('/api/v1/avatar-frames/me/equipped')
      .set('Authorization', 'Bearer valid-user-token')
      .send(body)
      .expect(400);

    expect(service.setEquipped).not.toHaveBeenCalled();
  });

  it('accepts null and clears the authenticated user selection', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/avatar-frames/me/equipped')
      .set('Authorization', 'Bearer valid-user-token')
      .send({ frameId: null })
      .expect(200);

    expect(service.setEquipped).toHaveBeenCalledWith(
      'authenticated-user',
      null,
    );
  });

  it('uses only the guard-provided identity for valid requests', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/avatar-frames/me/equipped')
      .set('Authorization', 'Bearer valid-user-token')
      .send({ frameId })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/avatar-frames/me')
      .set('Authorization', 'Bearer valid-user-token')
      .expect(200);

    expect(service.setEquipped).toHaveBeenCalledWith(
      'authenticated-user',
      frameId,
    );
    expect(service.getInventory).toHaveBeenCalledWith('authenticated-user');
  });
});

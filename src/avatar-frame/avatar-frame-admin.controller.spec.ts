import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AvatarFrameAdminController } from './avatar-frame-admin.controller';
import { AvatarFrameAdminService } from './avatar-frame-admin.service';

describe('AvatarFrameAdminController', () => {
  const operatorId = '10000000-0000-4000-8000-000000000001';
  const targetId = '20000000-0000-4000-8000-000000000001';
  const frameId = '30000000-0000-4000-8000-000000000001';
  const grantId = '40000000-0000-4000-8000-000000000001';
  const idempotencyKey = '50000000-0000-4000-8000-000000000001';
  const service = {
    listAssets: jest.fn().mockResolvedValue([{ id: frameId }]),
    getUserInventory: jest
      .fn()
      .mockResolvedValue({ userId: targetId, items: [], grants: [] }),
    grant: jest.fn().mockResolvedValue({
      replayed: false,
      grant: { id: grantId },
    }),
    revoke: jest.fn().mockResolvedValue({
      replayed: false,
      grant: { id: grantId },
    }),
  };
  let app: INestApplication;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      controllers: [AvatarFrameAdminController],
      providers: [{ provide: AvatarFrameAdminService, useValue: service }],
    })
      .overrideGuard(JwtGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { userId: operatorId };
          return true;
        },
      })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => app.close());

  it('requires JWT plus ADMIN-audience authorization on every route', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AvatarFrameAdminController),
    ).toEqual([JwtGuard, AdminGuard]);
  });

  it('lists the active grant-selector catalog', async () => {
    await request(app.getHttpServer())
      .get('/admin/avatar-frames/assets')
      .expect(200, [{ id: frameId }]);
    expect(service.listAssets).toHaveBeenCalledWith();
  });

  it('gets a target inventory using only the validated route ID', async () => {
    await request(app.getHttpServer())
      .get(`/admin/avatar-frames/users/${targetId}`)
      .expect(200);
    expect(service.getUserInventory).toHaveBeenCalledWith(targetId, {
      limit: 50,
    });
  });

  it('forwards an opaque cursor and bounded limit for grant history', async () => {
    await request(app.getHttpServer())
      .get(`/admin/avatar-frames/users/${targetId}`)
      .query({ cursor: 'opaque-cursor', limit: 25 })
      .expect(200);
    expect(service.getUserInventory).toHaveBeenCalledWith(targetId, {
      cursor: 'opaque-cursor',
      limit: 25,
    });
  });

  it.each([0, 101, 1.5, 'not-a-number'])(
    'rejects an invalid grant-history limit: %s',
    async (limit) => {
      await request(app.getHttpServer())
        .get(`/admin/avatar-frames/users/${targetId}`)
        .query({ limit })
        .expect(400);
      expect(service.getUserInventory).not.toHaveBeenCalled();
    },
  );

  it('rejects an overlong grant-history cursor', async () => {
    await request(app.getHttpServer())
      .get(`/admin/avatar-frames/users/${targetId}`)
      .query({ cursor: 'x'.repeat(201) })
      .expect(400);
    expect(service.getUserInventory).not.toHaveBeenCalled();
  });

  it('takes grant operator identity from req.user and passes sanitized audit context', async () => {
    const expiresAt = '2026-08-29T12:00:00.000Z';
    await request(app.getHttpServer())
      .post(`/admin/avatar-frames/users/${targetId}/grants`)
      .set('User-Agent', 'u'.repeat(300))
      .set('X-Forwarded-For', '203.0.113.10')
      .send({
        frameId,
        expiresAt,
        reason: ' support case approved ',
        idempotencyKey,
      })
      .expect(201);

    expect(service.grant).toHaveBeenCalledWith(
      operatorId,
      targetId,
      {
        frameId,
        expiresAt,
        reason: 'support case approved',
        idempotencyKey,
      },
      {
        ip: expect.any(String),
        userAgent: 'u'.repeat(256),
      },
    );
    expect(service.grant.mock.calls[0][3].ip).not.toBe('203.0.113.10');
  });

  it('takes revoke operator identity from req.user and passes sanitized audit context', async () => {
    await request(app.getHttpServer())
      .post(`/admin/avatar-frames/grants/${grantId}/revoke`)
      .set('User-Agent', 'admin-console')
      .send({ reason: ' issued in error ' })
      .expect(201);

    expect(service.revoke).toHaveBeenCalledWith(
      operatorId,
      grantId,
      {
        reason: 'issued in error',
      },
      {
        ip: expect.any(String),
        userAgent: 'admin-console',
      },
    );
  });

  it.each([
    [{ frameId: 'not-a-uuid', reason: 'valid', idempotencyKey }],
    [{ frameId, reason: '', idempotencyKey }],
    [{ frameId, reason: '   ', idempotencyKey }],
    [{ frameId, reason: 'x'.repeat(501), idempotencyKey }],
    [{ frameId, reason: 'valid', idempotencyKey: 'not-a-uuid' }],
    [{ frameId, reason: 'valid', idempotencyKey, expiresAt: 'not-a-date' }],
    [{ frameId, reason: 'valid', idempotencyKey, operatorId }],
  ])('rejects an invalid grant body: %j', async (body) => {
    await request(app.getHttpServer())
      .post(`/admin/avatar-frames/users/${targetId}/grants`)
      .send(body)
      .expect(400);
    expect(service.grant).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { reason: '' },
    { reason: ' '.repeat(3) },
    { reason: 'x'.repeat(501) },
  ])('rejects an invalid revoke body: %j', async (body) => {
    await request(app.getHttpServer())
      .post(`/admin/avatar-frames/grants/${grantId}/revoke`)
      .send(body)
      .expect(400);
    expect(service.revoke).not.toHaveBeenCalled();
  });

  it.each([
    ['/admin/avatar-frames/users/not-a-uuid'],
    ['/admin/avatar-frames/users/not-a-uuid/grants'],
    ['/admin/avatar-frames/grants/not-a-uuid/revoke'],
  ])('rejects an invalid UUID route parameter: %s', async (path) => {
    const response =
      path.endsWith('/grants') || path.endsWith('/revoke')
        ? request(app.getHttpServer()).post(path).send({
            frameId,
            reason: 'valid reason',
            idempotencyKey,
          })
        : request(app.getHttpServer()).get(path);
    await response.expect(400);
  });

  it.each([
    ['missing token', undefined, 401],
    ['USER role', 'Bearer user', 403],
    ['ADMIN role with APP audience', 'Bearer app-admin', 403],
  ])(
    'denies %s at the route boundary',
    async (_label, authorization, expectedStatus) => {
      const moduleRef = await Test.createTestingModule({
        controllers: [AvatarFrameAdminController],
        providers: [{ provide: AvatarFrameAdminService, useValue: service }],
      })
        .overrideGuard(JwtGuard)
        .useValue({
          canActivate: (context: any) => {
            const req = context.switchToHttp().getRequest();
            if (!req.headers.authorization) {
              throw new UnauthorizedException();
            }
            req.user =
              req.headers.authorization === 'Bearer user'
                ? {
                    userId: 'user-1',
                    role: 'USER',
                    audience: 'ADMIN',
                  }
                : {
                    userId: operatorId,
                    role: 'ADMIN',
                    audience: 'APP',
                  };
            return true;
          },
        })
        .compile();
      const guardedApp = moduleRef.createNestApplication();
      await guardedApp.init();
      const httpRequest = request(guardedApp.getHttpServer()).get(
        '/admin/avatar-frames/assets',
      );
      if (authorization) {
        httpRequest.set('Authorization', authorization);
      }

      await httpRequest.expect(expectedStatus);
      expect(service.listAssets).not.toHaveBeenCalled();
      await guardedApp.close();
    },
  );
});

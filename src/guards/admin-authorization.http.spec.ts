import { INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import { AdminAccessController } from 'src/admin-access/admin-access.controller';
import { AdminAccessService } from 'src/admin-access/admin-access.service';
import { AdminPermissionGuard } from 'src/admin-access/admin-permission.guard';
import { PrismaService } from 'src/prisma/prisma.service';
import { DefaultAuthGuard } from './default-auth.guard';

const actorID = '11111111-1111-4111-8111-111111111111';
const targetID = '22222222-2222-4222-8222-222222222222';
const secret = 'admin-authorization-tests-only';
@Injectable()
class AdminMatrixStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
  }
  validate(payload: any) {
    return {
      userId: payload.sub,
      role: payload.role,
      audience: payload.audience,
      mustChangePassword: payload.mustChangePassword,
    };
  }
}

describe('administrator HTTP authorization boundaries', () => {
  let app: INestApplication;
  let actor: any;
  let target: any;
  const jwt = new JwtService({ secret });
  const token = (claims: object = {}) =>
    jwt.sign({ sub: actorID, role: 'ADMIN', audience: 'ADMIN', ...claims });
  const mutation = jest.fn(() => ({ role: 'MODERATOR', version: 5 }));
  const audit = jest.fn();
  const prisma: any = {
    user: {
      update: jest.fn(),
      findUnique: jest.fn(({ where }) =>
        where.id === actorID ? actor : target,
      ),
    },
    refreshToken: { updateMany: jest.fn() },
    adminAccess: { upsert: mutation, count: jest.fn(() => 2) },
    adminAuditLog: { create: audit },
    $executeRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn((fn) => fn(prisma));
  const change = (bearer = token(), id = targetID, version = 4) =>
    request(app.getHttpServer())
      .patch(`/admin/access/accounts/${id}`)
      .auth(bearer, { type: 'bearer' })
      .send({ role: 'MODERATOR', version, reason: 'authorized role change' });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AdminAccessController],
      providers: [
        AdminMatrixStrategy,
        AdminAccessService,
        AdminPermissionGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: APP_GUARD, useClass: DefaultAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    actor = {
      id: actorID,
      role: 'ADMIN',
      status: 'ACTIVE',
      adminAccess: { role: 'SUPER_ADMIN', version: 1 },
    };
    target = {
      id: targetID,
      role: 'ADMIN',
      status: 'ACTIVE',
      adminAccess: { role: 'SUPPORT', version: 4 },
    };
  });
  it.each([
    { role: 'USER', audience: 'APP' },
    { role: 'ADMIN', audience: 'APP' },
    { role: 'ADMIN', audience: undefined },
  ])('rejects a valid JWT with insufficient claims %j', async (claims) => {
    await change(token(claims)).expect(403);
    expect(mutation).not.toHaveBeenCalled();
  });
  it.each(['SUPPORT', 'OPERATIONS', 'MODERATOR'])(
    'role %s cannot grant permissions',
    async (role) => {
      actor.adminAccess.role = role;
      await change().expect(403);
      expect(mutation).not.toHaveBeenCalled();
    },
  );
  it.each(['SUSPENDED', 'BANNED'])(
    'rejects stale admin JWT after database account becomes %s',
    async (status) => {
      actor.status = status;
      await change().expect(403);
      expect(mutation).not.toHaveBeenCalled();
    },
  );
  it('rejects deleted admin access despite an unexpired JWT', async () => {
    actor.adminAccess = null;
    await change().expect(403);
    expect(mutation).not.toHaveBeenCalled();
  });
  it('rechecks the actor inside the transaction after the guard passed', async () => {
    prisma.$executeRaw.mockImplementationOnce(() => {
      actor.adminAccess.role = 'SUPPORT';
    });
    await change().expect(403);
    expect(mutation).not.toHaveBeenCalled();
  });
  it('prevents self role modification and stale target version', async () => {
    await change(token(), actorID).expect(400);
    await change(token(), targetID, 3).expect(409);
    expect(mutation).not.toHaveBeenCalled();
  });
  it.each(['SUPPORT', 'OPERATIONS', 'MODERATOR'])(
    'role %s cannot reset administrator passwords through HTTP',
    async (role) => {
      actor.adminAccess.role = role;
      await request(app.getHttpServer())
        .patch(`/admin/access/accounts/${actorID}/password`)
        .auth(token(), { type: 'bearer' })
        .send({ newPassword: 'NewPassword5678', reason: '重置密码' })
        .expect(403);
    },
  );
  it('removes the old self-service initial-password route', async () => {
    await request(app.getHttpServer())
      .patch('/admin/access/me/initial-password')
      .auth(token(), { type: 'bearer' })
      .send({ oldPassword: 'InitialPass1234', newPassword: 'NewPassword5678' })
      .expect(404);
  });
  it.each(['SUPPORT', 'OPERATIONS', 'MODERATOR'])(
    'role %s cannot delete an administrator through HTTP',
    async (role) => {
      actor.adminAccess.role = role;
      await request(app.getHttpServer())
        .delete(`/admin/access/accounts/${targetID}`)
        .auth(token(), { type: 'bearer' })
        .send({ version: 4, reason: '删除账号' })
        .expect(403);
    },
  );
  it('requires a deletion reason and prevents deletion of the current account', async () => {
    await request(app.getHttpServer())
      .delete(`/admin/access/accounts/${targetID}`)
      .auth(token(), { type: 'bearer' })
      .send({ version: 4 })
      .expect(400);
    await request(app.getHttpServer())
      .delete(`/admin/access/accounts/${actorID}`)
      .auth(token(), { type: 'bearer' })
      .send({ version: 1, reason: '删除自己' })
      .expect(400);
  });
  it.each(['SUPPORT', 'OPERATIONS', 'MODERATOR'])(
    'role %s cannot enumerate account availability',
    async (role) => {
      actor.adminAccess.role = role;
      await request(app.getHttpServer())
        .get('/admin/access/accounts/availability?accountId=admin')
        .auth(token(), { type: 'bearer' })
        .expect(403);
    },
  );
  it('validates availability queries and rejects unauthenticated checks', async () => {
    await request(app.getHttpServer())
      .get('/admin/access/accounts/availability?accountId=admin')
      .expect(401);
    await request(app.getHttpServer())
      .get('/admin/access/accounts/availability?accountId=bad%20account')
      .auth(token(), { type: 'bearer' })
      .expect(400);
  });
  it('keeps an authorized change and its audit record working', async () => {
    await change().expect(200, { role: 'MODERATOR', version: 5 });
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorID,
          entityID: targetID,
          action: 'admin_access.update',
        }),
      }),
    );
  });
});

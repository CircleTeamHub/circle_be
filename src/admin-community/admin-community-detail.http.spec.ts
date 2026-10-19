import { INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import { AdminPermissionGuard } from 'src/admin-access/admin-permission.guard';
import { DefaultAuthGuard } from 'src/guards/default-auth.guard';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminCommunityController } from './admin-community.controller';
import { AdminCommunityService } from './admin-community.service';
const actorID = '11111111-1111-4111-8111-111111111111';
const circleID = '22222222-2222-4222-8222-222222222222';
const secret = 'circle-details-test-only';
@Injectable()
class CircleDetailsStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
  }
  validate(payload: { sub: string; role: string; audience: string }) {
    return {
      userId: payload.sub,
      role: payload.role,
      audience: payload.audience,
    };
  }
}
describe('circle detail HTTP authorization and pagination', () => {
  let app: INestApplication;
  let actor: { role: string; status: string; adminAccess: { role: string } };
  const jwt = new JwtService({ secret });
  const token = (claims: object = {}) =>
    jwt.sign({ sub: actorID, role: 'ADMIN', audience: 'ADMIN', ...claims });
  const service = {
    circleDetail: jest.fn(),
    circleMembers: jest.fn(),
    circlePosts: jest.fn(),
    groupDetail: jest.fn(),
    groupMembers: jest.fn(),
    groupEvents: jest.fn(),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AdminCommunityController],
      providers: [
        CircleDetailsStrategy,
        AdminPermissionGuard,
        {
          provide: PrismaService,
          useValue: { user: { findUnique: () => actor } },
        },
        { provide: AdminCommunityService, useValue: service },
        { provide: APP_GUARD, useClass: DefaultAuthGuard },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.useLogger(false);
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
      role: 'ADMIN',
      status: 'ACTIVE',
      adminAccess: { role: 'SUPER_ADMIN' },
    };
    service.circleDetail.mockResolvedValue({ name: '摄影圈' });
    service.circleMembers.mockResolvedValue({ items: [] });
    service.circlePosts.mockResolvedValue({ items: [] });
  });
  it.each(['', '/members', '/posts', 'group', 'group/members', 'group/events'])(
    'requires console admin permission for %s',
    async (suffix) => {
      const path = suffix.startsWith('group')
        ? `/admin/community/groups/${circleID}${suffix.slice(5)}`
        : `/admin/community/circles/${circleID}${suffix}`;
      await request(app.getHttpServer()).get(path).expect(401);
      await request(app.getHttpServer())
        .get(path)
        .auth(token({ role: 'USER', audience: 'APP' }), { type: 'bearer' })
        .expect(403);
      await request(app.getHttpServer())
        .get(path)
        .auth(token({ audience: 'APP' }), { type: 'bearer' })
        .expect(403);
      actor.adminAccess.role = 'SUPPORT';
      await request(app.getHttpServer())
        .get(path)
        .auth(token(), { type: 'bearer' })
        .expect(403);
      expect(service.circleDetail).not.toHaveBeenCalled();
      expect(service.circleMembers).not.toHaveBeenCalled();
      expect(service.circlePosts).not.toHaveBeenCalled();
      expect(service.groupDetail).not.toHaveBeenCalled();
      expect(service.groupMembers).not.toHaveBeenCalled();
      expect(service.groupEvents).not.toHaveBeenCalled();
    },
  );
  it.each(['/members', '/posts'])(
    'validates pagination on %s',
    async (suffix) => {
      await request(app.getHttpServer())
        .get(`/admin/community/circles/${circleID}${suffix}?page=0&limit=500`)
        .auth(token(), { type: 'bearer' })
        .expect(400);
      await request(app.getHttpServer())
        .get(`/admin/community/circles/${circleID}${suffix}?page=2&limit=20`)
        .auth(token(), { type: 'bearer' })
        .expect(200);
      const method =
        suffix === '/members' ? service.circleMembers : service.circlePosts;
      expect(method).toHaveBeenCalledWith(
        circleID,
        expect.objectContaining({ page: 2, limit: 20 }),
      );
    },
  );
  it('validates the identifier and allows authorized detail access', async () => {
    await request(app.getHttpServer())
      .get('/admin/community/circles/invalid')
      .auth(token(), { type: 'bearer' })
      .expect(400);
    await request(app.getHttpServer())
      .get(`/admin/community/circles/${circleID}`)
      .auth(token(), { type: 'bearer' })
      .expect(200);
    expect(service.circleDetail).toHaveBeenCalledWith(circleID);
  });
});

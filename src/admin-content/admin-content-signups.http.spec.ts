import { INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import { AdminPermissionGuard } from 'src/admin-access/admin-permission.guard';
import { DefaultAuthGuard } from 'src/guards/default-auth.guard';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminContentController } from './admin-content.controller';
import { AdminContentService } from './admin-content.service';
const actorID = '11111111-1111-4111-8111-111111111111',
  postID = '22222222-2222-4222-8222-222222222222',
  secret = 'signup-roster-tests-only';
@Injectable()
class SignupStrategy extends PassportStrategy(Strategy) {
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
describe('admin signup roster HTTP boundaries', () => {
  let app: INestApplication;
  let role = 'SUPER_ADMIN',
    status = 'ACTIVE';
  const service = { signups: jest.fn() };
  const jwt = new JwtService({ secret });
  const token = (claims: object = {}) =>
    jwt.sign({ sub: actorID, role: 'ADMIN', audience: 'ADMIN', ...claims });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AdminContentController],
      providers: [
        SignupStrategy,
        AdminPermissionGuard,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: () => ({
                role: 'ADMIN',
                status,
                adminAccess: { role },
              }),
            },
          },
        },
        { provide: AdminContentService, useValue: service },
        { provide: APP_GUARD, useClass: DefaultAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    role = 'SUPER_ADMIN';
    status = 'ACTIVE';
    service.signups.mockResolvedValue({ items: [], total: 0 });
  });
  const get = (
    path = `/admin/content/posts/${postID}/signups`,
    bearer = token(),
  ) => request(app.getHttpServer()).get(path).auth(bearer, { type: 'bearer' });
  it('rejects anonymous and App credentials', async () => {
    await request(app.getHttpServer())
      .get(`/admin/content/posts/${postID}/signups`)
      .expect(401);
    await get(undefined, token({ audience: 'APP' })).expect(403);
    expect(service.signups).not.toHaveBeenCalled();
  });
  it('rejects support roles and revoked active status', async () => {
    role = 'SUPPORT';
    await get().expect(403);
    role = 'SUPER_ADMIN';
    status = 'BANNED';
    await get().expect(403);
    expect(service.signups).not.toHaveBeenCalled();
  });
  it.each(['SUPER_ADMIN', 'MODERATOR', 'OPERATIONS'])(
    'permits %s circle managers and prevents response caching',
    async (adminRole) => {
      role = adminRole;
      await get().expect('Cache-Control', 'no-store').expect(200);
      expect(service.signups).toHaveBeenCalledWith(
        postID,
        expect.objectContaining({ page: 1, limit: 20 }),
      );
    },
  );
  it('validates IDs and limits and passes numeric page offsets', async () => {
    await get('/admin/content/posts/invalid/signups').expect(400);
    await get(
      `/admin/content/posts/${postID}/signups?page=0&limit=1000`,
    ).expect(400);
    await get(`/admin/content/posts/${postID}/signups?page=2&limit=20`).expect(
      200,
    );
    expect(service.signups).toHaveBeenCalledWith(
      postID,
      expect.objectContaining({ page: 2, limit: 20 }),
    );
  });
});

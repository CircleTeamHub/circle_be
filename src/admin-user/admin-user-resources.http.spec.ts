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
import { AdminUserResourcesController } from './admin-user-resources.controller';
import { AdminUserResourcesService } from './admin-user-resources.service';
const actorID = '11111111-1111-4111-8111-111111111111',
  userID = '22222222-2222-4222-8222-222222222222',
  id = '33333333-3333-4333-8333-333333333333';
const secret = 'user-resource-tests-only';
@Injectable()
class UserResourcesStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
  }
  validate(payload: { sub: string; role: string; audience: string }) {
    return {
      userId: payload.sub,
      accountId: 'admin',
      role: payload.role,
      audience: payload.audience,
    };
  }
}
describe('user resources HTTP access', () => {
  let app: INestApplication;
  let role = 'SUPER_ADMIN';
  const jwt = new JwtService({ secret });
  const token = (claims: object = {}) =>
    jwt.sign({ sub: actorID, role: 'ADMIN', audience: 'ADMIN', ...claims });
  const service = {
    circles: jest.fn(),
    groups: jest.fn(),
    posts: jest.fn(),
    noteList: jest.fn(),
    post: jest.fn(),
    note: jest.fn(),
  };
  const paths = [
    'circles',
    'groups',
    'posts',
    'notes',
    `posts/${id}`,
    `notes/${id}`,
  ];
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AdminUserResourcesController],
      providers: [
        UserResourcesStrategy,
        AdminPermissionGuard,
        {
          provide: PrismaService,
          useValue: {
            user: {
              findUnique: () => ({
                role: 'ADMIN',
                status: 'ACTIVE',
                adminAccess: { role },
              }),
            },
          },
        },
        { provide: AdminUserResourcesService, useValue: service },
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
    for (const method of Object.values(service))
      method.mockResolvedValue({ items: [], total: 0 });
  });
  it.each(paths)(
    'rejects anonymous, App and unprivileged access to %s',
    async (path) => {
      const url = `/admin/users/${userID}/${path}`;
      await request(app.getHttpServer()).get(url).expect(401);
      await request(app.getHttpServer())
        .get(url)
        .auth(token({ audience: 'APP' }), { type: 'bearer' })
        .expect(403);
      role = 'SUPPORT';
      await request(app.getHttpServer())
        .get(url)
        .auth(token(), { type: 'bearer' })
        .expect(403);
      for (const method of Object.values(service))
        expect(method).not.toHaveBeenCalled();
    },
  );
  it.each(['posts', 'notes', `posts/${id}`, `notes/${id}`])(
    'does not grant content inspection to operations through %s',
    async (path) => {
      role = 'OPERATIONS';
      await request(app.getHttpServer())
        .get(`/admin/users/${userID}/${path}`)
        .auth(token(), { type: 'bearer' })
        .expect(403);
    },
  );
  it.each(['circles', 'groups', 'posts', 'notes'])(
    'validates user and bounded pagination for %s',
    async (path) => {
      const get = (url: string) =>
        request(app.getHttpServer()).get(url).auth(token(), { type: 'bearer' });
      await get(`/admin/users/invalid/${path}`).expect(400);
      await get(`/admin/users/${userID}/${path}?page=0&limit=999`).expect(400);
      await get(`/admin/users/${userID}/${path}?page=2&limit=20`).expect(200);
      const method =
        path === 'notes'
          ? service.noteList
          : service[path as 'circles' | 'groups' | 'posts'];
      expect(method).toHaveBeenCalledWith(
        userID,
        expect.objectContaining({ page: 2, limit: 20 }),
      );
    },
  );
  it.each(['posts', 'notes'])(
    'validates detail IDs and disables browser caching for %s',
    async (path) => {
      await request(app.getHttpServer())
        .get(`/admin/users/${userID}/${path}/invalid`)
        .auth(token(), { type: 'bearer' })
        .expect(400);
      await request(app.getHttpServer())
        .get(`/admin/users/${userID}/${path}/${id}`)
        .auth(token(), { type: 'bearer' })
        .expect('Cache-Control', 'no-store')
        .expect(200);
      const method = path === 'notes' ? service.note : service.post;
      expect(method).toHaveBeenCalledWith(
        userID,
        id,
        expect.objectContaining({ userId: actorID }),
      );
    },
  );
});

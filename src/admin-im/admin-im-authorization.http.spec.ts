import { INestApplication, Injectable, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import request from 'supertest';
import { AdminPermissionGuard } from 'src/admin-access/admin-permission.guard';
import { ChatGroupAdminService } from 'src/chat/chat-group-admin.service';
import { GroupService } from 'src/group/group.service';
import { DefaultAuthGuard } from 'src/guards/default-auth.guard';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/upload/upload.service';
import { AdminImController } from './admin-im.controller';
import { AdminImService } from './admin-im.service';

const actorID = '11111111-1111-4111-8111-111111111111';
const conversationID = '22222222-2222-4222-8222-222222222222';
const secret = 'admin-chat-read-tests-only';

@Injectable()
class AdminChatStrategy extends PassportStrategy(Strategy) {
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
    };
  }
}

describe('admin chat content HTTP access', () => {
  let app: INestApplication;
  let actor: any;
  const jwt = new JwtService({ secret });
  const token = (claims: object = {}) =>
    jwt.sign({ sub: actorID, role: 'ADMIN', audience: 'ADMIN', ...claims });
  const content = 'private test body must not appear in audit logs';
  const messages = jest.fn();
  const audit = jest.fn();
  const prisma: any = {
    user: { findUnique: jest.fn(() => actor) },
    chatConversation: { findUnique: jest.fn() },
    chatMessage: { findMany: messages },
    chatBurnArchive: { findMany: jest.fn() },
    adminAuditLog: { create: audit },
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn((callback) => callback(prisma));
  const query = (
    bearer = token(),
    body: object = { reason: 'review reported conversation' },
  ) =>
    request(app.getHttpServer())
      .post(`/admin/im/conversations/${conversationID}/messages/query`)
      .auth(bearer, { type: 'bearer' })
      .send(body);

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AdminImController],
      providers: [
        AdminChatStrategy,
        AdminImService,
        AdminPermissionGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: ChatGroupAdminService, useValue: {} },
        { provide: GroupService, useValue: {} },
        { provide: UploadService, useValue: {} },
        { provide: APP_GUARD, useClass: DefaultAuthGuard },
      ],
    }).compile();
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
    jest.resetAllMocks();
    actor = {
      role: 'ADMIN',
      status: 'ACTIVE',
      adminAccess: { role: 'SUPPORT' },
    };
    prisma.user.findUnique.mockImplementation(() => actor);
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    prisma.chatConversation.findUnique.mockResolvedValue({
      id: conversationID,
      type: 'DIRECT',
      clearedBeforeHeight: 0,
      burnDurationSec: null,
      burnStartedAt: null,
    });
    messages.mockResolvedValue([
      {
        id: 'message-1',
        height: 1,
        senderID: 'sender',
        type: 'text',
        content: { text: content },
        createdAt: new Date(),
      },
    ]);
    audit.mockResolvedValue({});
    prisma.chatBurnArchive.findMany.mockResolvedValue([]);
  });

  it('requires authentication before querying content', async () => {
    await request(app.getHttpServer())
      .post(`/admin/im/conversations/${conversationID}/messages/query`)
      .send({ reason: 'review reported conversation' })
      .expect(401);
    expect(messages).not.toHaveBeenCalled();
  });
  it.each([
    { role: 'USER', audience: 'APP' },
    { role: 'ADMIN', audience: 'APP' },
    { role: 'ADMIN', audience: undefined },
  ])('rejects non-console credentials %j', async (claims) => {
    await query(token(claims)).expect(403);
    expect(messages).not.toHaveBeenCalled();
  });
  it('does not treat every admin role as permission to read chat', async () => {
    actor.adminAccess.role = 'OPERATIONS';
    await query().expect(403);
    expect(messages).not.toHaveBeenCalled();
  });
  it.each(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT'])(
    'allows %s with IM_READ and writes a body-free audit record',
    async (role) => {
      actor.adminAccess.role = role;
      const response = await query(token(), {
        reason: 'review reported conversation',
        text: 'private search terms',
      }).expect(201);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.items[0].content.text).toBe(content);
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actorID,
            action: 'IM_MESSAGES_READ',
            entityID: conversationID,
            reason: 'review reported conversation',
            after: expect.objectContaining({
              textFilterUsed: true,
              returned: 1,
            }),
          }),
        }),
      );
      const logged = JSON.stringify(audit.mock.calls);
      expect(logged).not.toContain(content);
      expect(logged).not.toContain('private search terms');
    },
  );
  it.each([
    [
      'grant removed',
      () => {
        actor.adminAccess = null;
      },
    ],
    [
      'role downgraded',
      () => {
        actor.adminAccess.role = 'OPERATIONS';
      },
    ],
    [
      'account banned',
      () => {
        actor.status = 'BANNED';
      },
    ],
    [
      'admin role removed',
      () => {
        actor.role = 'USER';
      },
    ],
  ])(
    'rejects a permission change after the HTTP guard: %s',
    async (_, revoke) => {
      prisma.$queryRaw.mockImplementationOnce(revoke as () => void);
      await query().expect(403);
      expect(messages).not.toHaveBeenCalled();
      expect(audit).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { reason: ' ' },
    { reason: 'ok', limit: 101 },
    { reason: 'ok', includeDeleted: true },
  ])(
    'rejects invalid or privilege-extending request fields %j',
    async (body) => {
      await query(token(), body).expect(400);
      expect(messages).not.toHaveBeenCalled();
    },
  );
  it('does not release content when its audit record cannot be written', async () => {
    audit.mockRejectedValueOnce(new Error('test audit storage failure'));
    const response = await query().expect(500);
    expect(JSON.stringify(response.body)).not.toContain(content);
  });
  it('retains global clear, recall, deletion and expiry predicates for admins', async () => {
    prisma.chatConversation.findUnique.mockResolvedValueOnce({
      id: conversationID,
      type: 'DIRECT',
      clearedBeforeHeight: 12,
      burnDurationSec: null,
      burnStartedAt: null,
    });
    await query().expect(201);
    expect(messages).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          conversationID,
          deleted: false,
          deletedAt: null,
          revokedAt: null,
          height: { gt: 12 },
          AND: expect.any(Array),
        }),
      }),
    );
    expect(JSON.stringify(messages.mock.calls[0][0].where.AND)).toContain(
      'burnExpiresAt',
    );
  });
  it('denies archive history to ordinary IM readers at the HTTP guard', async () => {
    await request(app.getHttpServer())
      .post(`/admin/im/conversations/${conversationID}/archives/query`)
      .auth(token(), { type: 'bearer' })
      .send({ reason: 'review' })
      .expect(403);
    expect(prisma.chatBurnArchive.findMany).not.toHaveBeenCalled();
  });
  it('uses the separate audited archive route for super administrators', async () => {
    actor.adminAccess.role = 'SUPER_ADMIN';
    const response = await request(app.getHttpServer())
      .post(`/admin/im/conversations/${conversationID}/archives/query`)
      .auth(token(), { type: 'bearer' })
      .send({ reason: 'review' })
      .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(prisma.chatBurnArchive.findMany).toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'IM_BURN_ARCHIVE_READ' }),
      }),
    );
  });
});

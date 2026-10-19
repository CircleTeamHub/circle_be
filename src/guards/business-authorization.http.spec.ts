import { Injectable, INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { PassportModule, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { DefaultAuthGuard } from './default-auth.guard';
import { NoteController } from 'src/note/note.controller';
import { NoteService } from 'src/note/note.service';
import { CoinController } from 'src/coin/coin.controller';
import { CoinService } from 'src/coin/coin.service';
import { CollectionController } from 'src/collection/collection.controller';
import { CollectionService } from 'src/collection/collection.service';
import { ConversationGroupController } from 'src/conversation-group/conversation-group.controller';
import { ConversationGroupService } from 'src/conversation-group/conversation-group.service';
import { NotificationController } from 'src/notification/notification.controller';
import { NotificationService } from 'src/notification/notification.service';
import { GroupController } from 'src/group/group.controller';
import { GroupService } from 'src/group/group.service';
import { UserThrottlerGuard } from './user-throttler.guard';

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const resource = '33333333-3333-4333-8333-333333333333';
const secret = 'authorization-matrix-test-only';
@Injectable()
class MatrixStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: secret,
    });
  }
  validate(payload: { sub: string }) {
    return { userId: payload.sub, role: 'USER' };
  }
}

// Real controllers, validation, JWT and services; only persistence/external I/O
// are fake. Unlike a controller service stub this exercises the authorization
// branch and fails if the ownership predicate is removed.
describe('cross-user HTTP authorization matrix', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret });
  const token = jwt.sign({ sub: alice });
  const mutations = jest.fn();
  let role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  const note = {
    id: resource,
    ownerID: bob,
    status: 'ACTIVE',
    available: false,
  };
  const prisma: any = {
    note: {
      findFirst: jest.fn(({ where }) => {
        if (where.ownerID && where.ownerID !== note.ownerID) return null;
        if (
          where.OR &&
          !where.OR.some(
            (x: any) =>
              x.ownerID === bob || (x.available === true && note.available),
          )
        )
          return null;
        return note;
      }),
      update: mutations,
      updateMany: mutations,
      create: mutations,
    },
    noteGroup: {
      findFirst: jest.fn(({ where }) =>
        where.ownerID === bob ? { id: resource, ownerID: bob } : null,
      ),
    },
    userCollection: {
      deleteMany: jest.fn(({ where }) => ({
        count: where.userID === bob ? (mutations(), 1) : 0,
      })),
    },
    conversationGroup: {
      findUnique: jest.fn(() => ({ id: resource, ownerID: bob })),
      update: mutations,
      delete: mutations,
    },
    conversationGroupMembership: {
      deleteMany: mutations,
      createMany: mutations,
    },
    notification: {
      findFirst: jest.fn(({ where }) =>
        where.toUserID === bob
          ? { id: resource, toUserID: bob, type: 'SYSTEM' }
          : null,
      ),
      updateMany: mutations,
    },
    wallet: {
      upsert: jest.fn(({ where }) => ({
        userID: where.userID,
        balance: where.userID === alice ? 7 : 9999,
      })),
      updateMany: mutations,
      update: mutations,
    },
    coinTransaction: {
      findMany: jest.fn(({ where }) => [
        { id: where.userID, amount: where.userID === alice ? 7 : 9999 },
      ]),
    },
    coinGift: {
      findUnique: jest.fn(() => ({
        senderID: bob,
        recipientID: alice,
        amount: 1,
      })),
    },
    user: { findUnique: jest.fn(() => ({ id: bob, status: 'ACTIVE' })) },
    friend: {
      findFirst: jest.fn(() => ({
        id: 'friend',
        userID: alice,
        friendID: bob,
        state: 'ACCEPTED',
      })),
    },
    circle: {
      findFirst: jest.fn(() => ({
        id: resource,
        ownerID: bob,
        deleted: false,
      })),
    },
    circleMember: {
      findUnique: jest.fn(() =>
        role ? { id: 'seat', role, status: 'ACTIVE' } : null,
      ),
      update: mutations,
      delete: mutations,
    },
    $queryRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn((fn) => fn(prisma));

  beforeAll(async () => {
    const config: any = { get: () => undefined };
    const module = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [
        NoteController,
        CoinController,
        CollectionController,
        ConversationGroupController,
        NotificationController,
        GroupController,
      ],
      providers: [
        MatrixStrategy,
        { provide: APP_GUARD, useClass: DefaultAuthGuard },
        {
          provide: NoteService,
          useValue: new NoteService(prisma, config, {} as any, {} as any),
        },
        {
          provide: CoinService,
          useValue: new CoinService(prisma, {} as any, {} as any),
        },
        {
          provide: CollectionService,
          useValue: new CollectionService(prisma, {} as any),
        },
        {
          provide: ConversationGroupService,
          useValue: new ConversationGroupService(prisma),
        },
        {
          provide: NotificationService,
          useValue: new NotificationService(prisma, {} as any),
        },
        {
          provide: GroupService,
          useValue: new GroupService(
            prisma,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
            config,
            {} as any,
          ),
        },
      ],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(UserThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
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
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    role = 'MEMBER';
  });

  it.each([
    ['get', `/note/${resource}`, undefined, 404],
    ['patch', `/note/${resource}/pin`, { pinned: true }, 404],
    ['patch', `/note/${resource}/available`, { available: true }, 404],
    ['patch', `/note/${resource}/remark`, { remark: 'stolen' }, 404],
    ['delete', `/note/${resource}`, undefined, 404],
    ['delete', `/collections/${resource}`, undefined, 404],
    ['patch', `/conversation-groups/${resource}`, { name: 'stolen' }, 404],
    ['delete', `/conversation-groups/${resource}`, undefined, 404],
    [
      'put',
      `/conversation-groups/${resource}/members`,
      { conversationIDs: [] },
      404,
    ],
    ['put', `/notification/${resource}/read`, undefined, 200],
    ['delete', `/notification/${resource}`, undefined, 200],
  ])(
    '%s %s refuses another user resource without a write',
    async (method, path, body, status) => {
      const req = (request(app.getHttpServer()) as any)
        [method as string](path)
        .auth(token, { type: 'bearer' });
      if (body) req.send(body);
      const res = await req.expect(status);
      if (status === 404) expect(res.body.message).not.toMatch(/^Cannot /);
      expect(mutations).not.toHaveBeenCalled();
    },
  );

  it('authenticates before evaluating object ownership', async () => {
    await request(app.getHttpServer())
      .patch(`/note/${resource}/pin`)
      .send({ pinned: true })
      .expect(401);
    expect(prisma.note.findFirst).not.toHaveBeenCalled();
  });
  it('keeps the owner path usable', async () => {
    await request(app.getHttpServer())
      .patch(`/note/${resource}/pin`)
      .auth(jwt.sign({ sub: bob }), { type: 'bearer' })
      .send({ pinned: true })
      .expect(200);
    expect(mutations).toHaveBeenCalledTimes(1);
  });
  it.each(['wallet', 'transactions'])(
    'ignores a forged wallet owner in the %s query',
    async (route) => {
      const res = await request(app.getHttpServer())
        .get(`/coin/${route}?userId=${bob}`)
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(JSON.stringify(res.body)).not.toContain('9999');
      expect(JSON.stringify(res.body)).toContain(alice);
    },
  );
  it('rejects a forged gift sender before debiting any wallet', async () => {
    await request(app.getHttpServer())
      .post('/coin/gift')
      .auth(token, { type: 'bearer' })
      .set('idempotency-key', 'attack')
      .send({ senderId: bob, recipientId: alice, amount: 1 })
      .expect(400);
    expect(prisma.wallet.updateMany).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5])('rejects invalid gift amount %s', async (amount) => {
    await request(app.getHttpServer())
      .post('/coin/gift')
      .auth(token, { type: 'bearer' })
      .set('idempotency-key', 'attack')
      .send({ recipientId: bob, amount })
      .expect(400);
    expect(mutations).not.toHaveBeenCalled();
  });
  it('does not replay another sender gift key as success', async () => {
    await request(app.getHttpServer())
      .post('/coin/gift')
      .auth(token, { type: 'bearer' })
      .set('idempotency-key', 'bob-key')
      .send({ recipientId: bob, amount: 1 })
      .expect(409);
    expect(mutations).not.toHaveBeenCalled();
  });
  it.each([null, 'MEMBER', 'ADMIN'] as const)(
    'role %s cannot grant group administrator',
    async (candidate) => {
      role = candidate;
      await request(app.getHttpServer())
        .patch(`/group/${resource}/members/${bob}/role`)
        .auth(token, { type: 'bearer' })
        .send({ role: 'ADMIN' })
        .expect(403);
      expect(mutations).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );
});

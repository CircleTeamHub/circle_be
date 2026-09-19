import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { ChatService } from 'src/chat/chat.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { getE2eApp } from './e2e-context';

function canRunPostgresE2e(): boolean {
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.NODE_ENV !== 'test' || !databaseUrl || !process.env.SECRET) {
    return false;
  }
  try {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      /(^|[_-])test($|[_-])/i.test(databaseName)
    );
  } catch {
    return false;
  }
}

const describePostgres = canRunPostgresE2e() ? describe : describe.skip;

/**
 * 增量同步接口的端到端:真实的 Prisma 调用 + 迁移里的触发器 + HTTP 层。
 * 单测里 Prisma 是桩,「create/updateManyAndReturn 的 RETURNING 能不能带回触发器
 * 分配的 revision」只有在这里才验得到。
 */
describePostgres('Chat sync endpoint e2e', () => {
  let prisma: PrismaService;
  let chat: ChatService;
  let jwt: JwtService;
  let jwtSecret: string;

  const createUser = async (label: string) => {
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 10);
    return prisma.user.create({
      data: {
        id,
        accountId: `${label}-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'not-used',
        nickname: `${label} ${suffix}`,
      },
    });
  };

  const accessToken = (user: { id: string; accountId: string }) =>
    jwt.sign(
      { sub: user.id, accountId: user.accountId, role: 'USER', aud: 'APP' },
      { secret: jwtSecret, expiresIn: '5m' },
    );

  const sync = (token: string, conversationId: string, afterRevision: number) =>
    request(getE2eApp().getHttpServer())
      .get(`/api/v1/chat/conversations/${conversationId}/sync`)
      .query({ afterRevision })
      .set('Authorization', `Bearer ${token}`);

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    chat = app.get(ChatService);
    jwt = app.get(JwtService);
    jwtSecret = app.get(ConfigService).get<string>('SECRET') ?? '';
  });

  it('replays creations, recalls, reactions and tombstones in revision order', async () => {
    const [alice, bob] = await Promise.all([
      createUser('sync-alice'),
      createUser('sync-bob'),
    ]);
    const conversation = await prisma.chatConversation.create({
      data: {
        type: 'GROUP',
        name: 'sync e2e',
        ownerID: alice.id,
        members: {
          create: [
            { userID: alice.id, role: 'MEMBER' },
            { userID: bob.id, role: 'MEMBER' },
          ],
        },
      },
    });

    const first = await chat.sendMessage(alice.id, {
      conversationId: conversation.id,
      type: 'text',
      content: { text: 'first' },
      d: 'sync-e2e-1',
    });
    const second = await chat.sendMessage(alice.id, {
      conversationId: conversation.id,
      type: 'text',
      content: { text: 'second' },
      d: 'sync-e2e-2',
    });
    // create 的 RETURNING 带回触发器分配的号。
    expect(first.message.revision).toBe(1);
    expect(second.message.revision).toBe(2);

    const bobToken = accessToken(bob);
    const initial = await sync(bobToken, conversation.id, 0);
    expect(initial.status).toBe(200);
    expect(initial.body.data ?? initial.body).toMatchObject({
      nextRevision: 2,
      throughRevision: 2,
      hasMore: false,
      resetRequired: false,
    });
    const cursor = (initial.body.data ?? initial.body).nextRevision as number;

    // 撤回、回应、焚毁都不改 height —— 按 height 补拉永远看不到它们。
    await chat.revokeMessage(alice.id, conversation.id, first.message.id);
    const reaction = await chat.toggleReaction(
      bob.id,
      conversation.id,
      second.message.id,
      '👍',
      'add',
    );
    expect(reaction).toEqual({ changed: true, revision: 4 });
    const tombstones = await prisma.chatMessage.updateManyAndReturn({
      where: { id: second.message.id },
      data: { deleted: true, deletedAt: new Date(), content: {} },
      select: { id: true, revision: true },
    });
    expect(tombstones).toEqual([{ id: second.message.id, revision: 5 }]);

    const delta = await sync(bobToken, conversation.id, cursor);
    expect(delta.status).toBe(200);
    const page = delta.body.data ?? delta.body;
    expect(page).toMatchObject({ nextRevision: 5, throughRevision: 5 });
    // 同一条消息中间变过几次,只回最后一版。
    expect(
      (page.messages as Array<{ id: string; revision: number }>).map(
        (message) => [message.id, message.revision],
      ),
    ).toEqual([
      [first.message.id, 3],
      [second.message.id, 5],
    ]);
    expect(page.messages[0]).toMatchObject({
      revokedAt: expect.any(String),
      content: {},
    });
    expect(page.messages[1]).toMatchObject({ deleted: true, content: {} });

    const caughtUp = await sync(bobToken, conversation.id, 5);
    expect(caughtUp.body.data ?? caughtUp.body).toMatchObject({
      messages: [],
      nextRevision: 5,
      hasMore: false,
    });
  });

  it('refuses someone who is not seated in the conversation', async () => {
    const [owner, stranger] = await Promise.all([
      createUser('sync-owner'),
      createUser('sync-stranger'),
    ]);
    const conversation = await prisma.chatConversation.create({
      data: {
        type: 'GROUP',
        name: 'private',
        ownerID: owner.id,
        members: { create: [{ userID: owner.id, role: 'MEMBER' }] },
      },
    });

    const res = await sync(accessToken(stranger), conversation.id, 0);

    expect(res.status).toBe(403);
  });
});

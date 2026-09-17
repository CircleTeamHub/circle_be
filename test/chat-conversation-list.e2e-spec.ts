import { randomUUID } from 'crypto';
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
 * 会话列表的两条手写 SQL(每会话最后一条消息、封顶的未读数)只能在真库上验:
 * 单测里 $queryRaw 是桩,SQL 写错一个字照样全绿。
 */
describePostgres('Chat conversation list queries e2e', () => {
  let prisma: PrismaService;
  let chat: ChatService;

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

  const createGroup = (
    ownerId: string,
    memberIds: string[],
    extra: { burnDurationSec?: number; burnStartedAt?: Date } = {},
  ) =>
    prisma.chatConversation.create({
      data: {
        type: 'GROUP',
        name: 'list e2e',
        ownerID: ownerId,
        ...extra,
        members: {
          create: memberIds.map((userID) => ({ userID, role: 'MEMBER' })),
        },
      },
    });

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    chat = app.get(ChatService);
  });

  it('takes the newest visible message per conversation and caps unread at 100', async () => {
    const [alice, bob] = await Promise.all([
      createUser('list-alice'),
      createUser('list-bob'),
    ]);
    const busy = await createGroup(alice.id, [alice.id, bob.id]);
    const empty = await createGroup(alice.id, [alice.id]);
    const base = Date.now() - 60 * 60_000;
    await prisma.chatMessage.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({
        conversationID: busy.id,
        height: i + 1,
        senderID: bob.id,
        type: 'text',
        content: { text: `m${i + 1}` },
        createdAt: new Date(base + i * 1000),
      })),
    });
    await prisma.chatMessage.create({
      data: {
        conversationID: busy.id,
        height: 151,
        senderID: alice.id,
        type: 'text',
        content: { text: 'mine' },
        createdAt: new Date(base + 151_000),
      },
    });
    // 最高的那条已经焚毁:列表末条要越过墓碑取下一条。
    await prisma.chatMessage.create({
      data: {
        conversationID: busy.id,
        height: 152,
        senderID: bob.id,
        type: 'text',
        content: {},
        deleted: true,
        deletedAt: new Date(),
        createdAt: new Date(base + 152_000),
      },
    });

    const aliceList = await chat.listConversations(alice.id);
    const busyForAlice = aliceList.find((row) => row.id === busy.id);
    expect(busyForAlice?.lastMessage).toMatchObject({
      height: 151,
      content: { text: 'mine' },
    });
    expect(typeof busyForAlice?.lastMessage?.revision).toBe('number');
    // bob 发了 150 条她都没读:界面只显示 99+,数到 100 就停。
    expect(busyForAlice?.unreadCount).toBe(100);
    const emptyForAlice = aliceList.find((row) => row.id === empty.id);
    expect(emptyForAlice?.lastMessage).toBeNull();
    expect(emptyForAlice?.unreadCount).toBe(0);

    await prisma.chatMember.updateMany({
      where: { conversationID: busy.id, userID: bob.id },
      data: { lastReadHeight: 150 },
    });
    const bobList = await chat.listConversations(bob.id);
    // 自己发的、已焚毁的都不算:只剩 alice 那一条。
    expect(bobList.find((row) => row.id === busy.id)?.unreadCount).toBe(1);
  });

  it('skips messages hidden by the burn window when choosing the last message', async () => {
    const [alice, bob] = await Promise.all([
      createUser('burn-alice'),
      createUser('burn-bob'),
    ]);
    const now = Date.now();
    const burning = await createGroup(alice.id, [alice.id, bob.id], {
      burnDurationSec: 60,
      burnStartedAt: new Date(now - 30 * 60_000),
    });
    await prisma.chatMessage.createMany({
      data: [
        // 开启焚毁之前发的:不受焚毁窗口约束,照常可见。
        {
          conversationID: burning.id,
          height: 1,
          senderID: bob.id,
          type: 'text',
          content: { text: 'before activation' },
          createdAt: new Date(now - 2 * 60 * 60_000),
        },
        // 开启之后发的、已经超过 60 秒:到期未扫,读路径必须当它不存在。
        {
          conversationID: burning.id,
          height: 2,
          senderID: bob.id,
          type: 'text',
          content: { text: 'expired' },
          createdAt: new Date(now - 10 * 60_000),
        },
      ],
    });

    const row = (await chat.listConversations(alice.id)).find(
      (candidate) => candidate.id === burning.id,
    );
    expect(row?.lastMessage).toMatchObject({
      height: 1,
      content: { text: 'before activation' },
    });
    expect(row?.unreadCount).toBe(1);
  });
});

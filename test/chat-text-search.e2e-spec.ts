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
 * 消息关键词搜索改成「二元组索引取候选 + 可见性过滤」之后,结果必须和原来的
 * jsonb LIKE 完全一致:一个字、两个字的中文,英文,通配符字面匹配,清空水位,
 * 阅后即焚窗口,以及候选被过滤掉一大批时的续翻。这些只有真库验得到。
 */
describePostgres('Chat text search e2e', () => {
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
    memberIds: string[],
    extra: { burnDurationSec?: number; burnStartedAt?: Date } = {},
  ) =>
    prisma.chatConversation.create({
      data: {
        type: 'GROUP',
        name: 'search e2e',
        ownerID: memberIds[0],
        ...extra,
        members: {
          create: memberIds.map((userID) => ({ userID, role: 'MEMBER' })),
        },
      },
    });

  const texts = (
    conversationId: string,
    senderId: string,
    entries: Array<{ height: number; text: string; createdAt?: Date }>,
  ) =>
    prisma.chatMessage.createMany({
      data: entries.map(({ height, text, createdAt }) => ({
        conversationID: conversationId,
        height,
        senderID: senderId,
        type: 'text',
        content: { text },
        ...(createdAt ? { createdAt } : {}),
      })),
    });

  const heightsOf = (messages: Array<{ height: number }>) =>
    messages.map((message) => message.height);

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    chat = app.get(ChatService);
  });

  it('matches one- and two-character Chinese, English, and wildcards literally', async () => {
    const [alice, bob] = await Promise.all([
      createUser('search-alice'),
      createUser('search-bob'),
    ]);
    const group = await createGroup([alice.id, bob.id]);
    const base = Date.now() - 60 * 60_000;
    await texts(group.id, bob.id, [
      { height: 1, text: '今晚吃火锅吗', createdAt: new Date(base + 1_000) },
      { height: 2, text: '晚饭吃什么', createdAt: new Date(base + 2_000) },
      { height: 3, text: '明天开会', createdAt: new Date(base + 3_000) },
      { height: 4, text: 'Hello World', createdAt: new Date(base + 4_000) },
      { height: 5, text: '完成度 100%', createdAt: new Date(base + 5_000) },
      { height: 6, text: '完成度 1000', createdAt: new Date(base + 6_000) },
      // 两个字都在、但不相邻:二元组集合碰不上,LIKE 也不该匹配。
      { height: 7, text: '晚上再吃饭', createdAt: new Date(base + 7_000) },
    ]);

    const search = async (keyword: string) =>
      heightsOf(
        (await chat.getHistory(alice.id, group.id, undefined, 50, { keyword }))
          .messages,
      );

    expect(await search('晚饭')).toEqual([2]);
    expect(await search('吃')).toEqual([1, 2, 7]);
    expect(await search('Hello')).toEqual([4]);
    // 大小写与原来一致:区分大小写。
    expect(await search('hello')).toEqual([]);
    expect(await search('100%')).toEqual([5]);
    expect(await search('度_1')).toEqual([]);

    const global = await chat.searchAllMessages(alice.id, '吃');
    expect(heightsOf(global)).toEqual([7, 2, 1]);
  });

  it('keeps cleared history and expired disappearing messages out of both searches', async () => {
    const [alice, bob] = await Promise.all([
      createUser('scope-alice'),
      createUser('scope-bob'),
    ]);
    const now = Date.now();
    const cleared = await createGroup([alice.id, bob.id]);
    await texts(cleared.id, bob.id, [
      { height: 1, text: '暗号 旧的', createdAt: new Date(now - 90_000) },
      { height: 2, text: '暗号 新的', createdAt: new Date(now - 80_000) },
    ]);
    await prisma.chatMember.updateMany({
      where: { conversationID: cleared.id, userID: alice.id },
      data: { clearedBeforeHeight: 1 },
    });
    const burning = await createGroup([alice.id, bob.id], {
      burnDurationSec: 60,
      burnStartedAt: new Date(now - 30 * 60_000),
    });
    await texts(burning.id, bob.id, [
      {
        height: 1,
        text: '暗号 开启前',
        createdAt: new Date(now - 60 * 60_000),
      },
      {
        height: 2,
        text: '暗号 已过期',
        createdAt: new Date(now - 10 * 60_000),
      },
    ]);
    // 不在座的会话一律搜不到。
    const stranger = await createUser('scope-stranger');
    const elsewhere = await createGroup([bob.id, stranger.id]);
    await texts(elsewhere.id, bob.id, [{ height: 1, text: '暗号 别人的' }]);

    const history = await chat.getHistory(alice.id, cleared.id, undefined, 50, {
      keyword: '暗号',
    });
    expect(heightsOf(history.messages)).toEqual([2]);

    const global = await chat.searchAllMessages(alice.id, '暗号');
    expect(
      global.map((message) => `${message.conversationId}:${message.height}`),
    ).toEqual([`${cleared.id}:2`, `${burning.id}:1`]);
  });

  it('keeps paging candidates when a whole batch is filtered out', async () => {
    const [alice, bob] = await Promise.all([
      createUser('page-alice'),
      createUser('page-bob'),
    ]);
    const now = Date.now();
    const burning = await createGroup([alice.id, bob.id], {
      burnDurationSec: 60,
      burnStartedAt: new Date(now - 60 * 60_000),
    });
    // 最旧一条在开启焚毁之前,可见;其后 250 条全部已到期、还没被扫掉 ——
    // 按时间倒序的第一批候选(200 条)一条都留不下,必须接着翻才找得到它。
    await texts(burning.id, bob.id, [
      {
        height: 1,
        text: '关键词 最早的那条',
        createdAt: new Date(now - 2 * 60 * 60_000),
      },
      ...Array.from({ length: 250 }, (_, i) => ({
        height: i + 2,
        text: `关键词 过期 ${i}`,
        createdAt: new Date(now - 50 * 60_000 + i * 1000),
      })),
    ]);

    const global = await chat.searchAllMessages(alice.id, '关键词');
    expect(heightsOf(global)).toEqual([1]);

    const history = await chat.getHistory(alice.id, burning.id, undefined, 20, {
      keyword: '关键词',
    });
    expect(heightsOf(history.messages)).toEqual([1]);
    expect(history.nextBeforeHeight).toBeNull();
  });

  it('pages a long result list without gaps or repeats', async () => {
    const [alice, bob] = await Promise.all([
      createUser('long-alice'),
      createUser('long-bob'),
    ]);
    const group = await createGroup([alice.id, bob.id]);
    const base = Date.now() - 60 * 60_000;
    await texts(
      group.id,
      bob.id,
      Array.from({ length: 450 }, (_, i) => ({
        height: i + 1,
        text: i % 3 === 0 ? `周报 第${i}份` : `闲聊 ${i}`,
        createdAt: new Date(base + i * 1000),
      })),
    );

    const seen: number[] = [];
    let before: number | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await chat.getHistory(alice.id, group.id, before, 50, {
        keyword: '周报',
      });
      seen.push(...heightsOf(result.messages).reverse());
      if (result.nextBeforeHeight === null) break;
      before = result.nextBeforeHeight;
    }
    const expected = Array.from({ length: 450 }, (_, i) => i + 1)
      .filter((height) => (height - 1) % 3 === 0)
      .reverse();
    expect(seen).toEqual(expected);
  });
});

import type { Client } from 'pg';
import { ChatMediaService } from 'src/chat/chat-media.service';
import type { ChatMessageDto } from 'src/chat/chat.types';
import { describePostgres } from './pg-test-db';
import {
  type LiveSchema,
  openLiveSchema,
  seedUsers,
  settleWithin,
} from './live-prisma';

/**
 * 读路径上焚毁媒体签名(burnMediaGrants)的锁形状。
 *
 * 原来只要页面里有焚毁媒体,就开事务对涉及的会话行 FOR SHARE —— 与发送的
 * FOR UPDATE 互相阻塞,多个读者同时持有还会产生 multixact。这把锁当初(889a6b9)
 * 只为一件事:**尚未开始计时**(待读)的消息,签名有效期按「现在 + 焚毁时长」给,
 * 首次已读若与签名并发、先一步启动计时,签名会比真实截止时间活得久;会话锁让
 * 启动计时(先取会话 FOR UPDATE)排在签名之后。
 *
 * 已经开始计时的消息截止时间写下就不再变,删除/撤回只会让它更早失效,签名的
 * 有效期本来就封顶在截止时间之前 —— 不需要锁。现在只对待读消息取锁。
 */
// 建整套表(prisma migrate diff 生成的 DDL)在共享测试库上可能要好几秒。
jest.setTimeout(60_000);

const dto = (overrides: Partial<ChatMessageDto>): ChatMessageDto => ({
  id: 'm1',
  conversationId: 'dm',
  height: 1,
  revision: 1,
  type: 'image',
  content: { key: 'chat/a/1.jpg' },
  sender: null,
  replyToId: null,
  d: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describePostgres('burn media grants on the read path', () => {
  let live: LiveSchema;
  let media: ChatMediaService;
  let other: Client;
  const upload = {
    createPresignedGetUrl: jest.fn(),
    copyObjectToKey: jest.fn(),
    deleteObjectByKey: jest.fn(),
  };

  beforeAll(async () => {
    live = await openLiveSchema('chat_burn_grants');
    media = new ChatMediaService(upload as never, live.prisma as never);
    other = await live.connect();
  });

  afterAll(async () => {
    media?.onModuleDestroy();
    await live?.close();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    upload.createPresignedGetUrl.mockImplementation((key: string) =>
      Promise.resolve({ url: `https://signed/${key}`, expiresAt: new Date() }),
    );
    await live.db.query(`
      TRUNCATE "User", "ChatConversation", "ChatMember", "ChatMessage", "AccountIdentifier" CASCADE;
    `);
    await seedUsers(live.db, ['a', 'b']);
    await live.db.query(`
      INSERT INTO "ChatConversation" (id, type, "directKey", "nextHeight", "updatedAt")
      VALUES ('dm', 'DIRECT', 'a:b', 2, now());
      INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content, "burnDurationSec", "burnExpiresAt")
      VALUES
        ('started', 'dm', 1, 'a', 'image', '{"key":"chat/a/1.jpg"}', 60, now() + interval '30 seconds'),
        ('pending', 'dm', 2, 'a', 'image', '{"key":"chat/a/2.jpg"}', 60, NULL);
    `);
    live.statements.length = 0;
  });

  afterEach(async () => {
    await other.query('ROLLBACK').catch(() => undefined);
  });

  const holdSendLock = async () => {
    await other.query('BEGIN');
    await other.query(
      `SELECT id FROM "ChatConversation" WHERE id = 'dm' FOR UPDATE`,
    );
  };

  const startedDto = async () => {
    const { rows } = await live.db.query<{ at: Date }>(
      `SELECT "burnExpiresAt" AS at FROM "ChatMessage" WHERE id = 'started'`,
    );
    return dto({
      id: 'started',
      content: { key: 'chat/a/1.jpg' },
      burnDurationSec: 60,
      burnExpiresAt: rows[0].at.toISOString(),
    });
  };

  it('signs started-timer media without a lock while a send holds the conversation', async () => {
    const message = await startedDto();
    await holdSendLock();

    const signing = media.attachMediaUrls([message]);
    const outcome = await settleWithin(signing, 1500);
    await other.query('COMMIT');
    await signing;

    expect(outcome).not.toBe('pending');
    expect(message.content.url).toBe('https://signed/chat/a/1.jpg');
    const [, ttl] = upload.createPresignedGetUrl.mock.calls[0];
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
    // 没有事务、没有 FOR SHARE:一条只读查询。
    expect(live.statements.map((s) => s.tx)).toEqual([null]);
    expect(live.statements.some((s) => /FOR SHARE/.test(s.sql))).toBe(false);
  });

  it('still orders a pending-read grant behind an in-flight timer start', async () => {
    const message = dto({
      id: 'pending',
      content: { key: 'chat/a/2.jpg' },
      burnDurationSec: 60,
    });
    await holdSendLock();

    const signing = media.attachMediaUrls([message]);
    expect(await settleWithin(signing, 500)).toBe('pending');
    await other.query('COMMIT');
    await signing;

    expect(message.content.url).toBe('https://signed/chat/a/2.jpg');
    const [, ttl] = upload.createPresignedGetUrl.mock.calls[0];
    expect(ttl).toBe(60);
    expect(live.statements.some((s) => /FOR SHARE/.test(s.sql))).toBe(true);
  });

  it('locks only the conversations that hold pending-read media', async () => {
    await live.db.query(`
      INSERT INTO "ChatConversation" (id, type, "nextHeight", "updatedAt")
      VALUES ('grp', 'GROUP', 1, now());
      INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content, "burnDurationSec", "burnExpiresAt")
      VALUES ('group-burn', 'grp', 1, 'a', 'image', '{"key":"chat/a/3.jpg"}', 60, now() + interval '1 minute');
    `);
    const groupMessage = dto({
      id: 'group-burn',
      conversationId: 'grp',
      content: { key: 'chat/a/3.jpg' },
      burnDurationSec: 60,
      burnExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const pendingMessage = dto({
      id: 'pending',
      content: { key: 'chat/a/2.jpg' },
      burnDurationSec: 60,
    });

    await media.attachMediaUrls([groupMessage, pendingMessage]);

    const share = live.statements.filter((s) => /FOR SHARE/.test(s.sql));
    expect(share).toHaveLength(1);
    expect(share[0].args).toEqual([['dm']]);
    expect(groupMessage.content.url).toBe('https://signed/chat/a/3.jpg');
    expect(pendingMessage.content.url).toBe('https://signed/chat/a/2.jpg');
  });

  it('never signs media whose message already burned or was revoked', async () => {
    await live.db.query(
      `UPDATE "ChatMessage" SET deleted = true WHERE id = 'started';
       UPDATE "ChatMessage" SET "revokedAt" = now() WHERE id = 'pending'`,
    );
    const started = await startedDto();
    const pending = dto({
      id: 'pending',
      content: { key: 'chat/a/2.jpg', url: 'stale' },
      burnDurationSec: 60,
    });

    await media.attachMediaUrls([started, pending]);

    expect(started.content.url).toBeUndefined();
    expect(pending.content.url).toBeUndefined();
    expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
  });
});

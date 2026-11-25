import { ForbiddenException } from '@nestjs/common';
import type { Client } from 'pg';
import { ChatService } from 'src/chat/chat.service';
import { pendingReadBurnTimersQuery } from 'src/chat/chat-send-lock.query';
import { startReadBurnTimers } from 'src/chat/read-burn-timers';
import { describePostgres, explainPlan } from './pg-test-db';
import {
  type LiveSchema,
  openLiveSchema,
  readMigration,
  seedUsers,
  settleWithin,
  statementsAfter,
  transactionOf,
  waitUntilBlocked,
} from './live-prisma';

const membershipNoticesMock = {
  deliverMembershipNotices: jest.fn().mockResolvedValue(undefined),
};

/**
 * 发送临界区与单聊已读的锁形状(真 PrismaClient + 真 PostgreSQL)。
 *
 * - 发送:会话行 FOR UPDATE 之后只留鉴权/一致性复查(在座、拉黑、禁言、幂等)和写入;
 *   只决定「要不要入队自动回复/充值任务」的两次读挪到锁前,座位只读一次,
 *   会话计数器推进与隐藏会话复现合成一条语句。结果(height、计数器、hiddenAt、
 *   入队的任务、幂等复用)与原来一致,并发两条发送仍严格串行。
 * - 单聊已读:只有真有待启动的阅后即焚计时才取会话行锁;否则不再和发送互相串行。
 */
const isLock = (sql: string) =>
  /FROM "ChatConversation"/.test(sql) && /FOR UPDATE/.test(sql);

function makeService(live: LiveSchema): ChatService {
  const resolved = () => jest.fn().mockResolvedValue(undefined);
  return new ChatService(
    live.prisma as never,
    { check: jest.fn().mockReturnValue({ blocked: false }) } as never,
    { ensureCircleConversation: resolved() } as never,
    {
      lockOwnedKeysForSend: resolved(),
      attachMediaUrls: resolved(),
      attachNoteImportReferences: resolved(),
      deleteObjects: resolved(),
      copyForForward: jest.fn(),
    } as never,
    {
      getSelfDestructPolicy: jest
        .fn()
        .mockResolvedValue({ sec: 0, startedAt: null }),
      getSettingsForUsers: jest.fn().mockResolvedValue(new Map()),
      canReceiveStrangerMessage: jest.fn().mockResolvedValue(true),
    } as never,
    {
      emitBurnStarted: resolved(),
      joinUserToConversation: resolved(),
    } as never,
    { emit: resolved() } as never,
    { isSupportAgent: jest.fn().mockResolvedValue(false) } as never,
    { lock: resolved() } as never,
    { record: resolved(), recordInTx: resolved() } as never,
    membershipNoticesMock as never,
  );
}

// 建整套表(prisma migrate diff 生成的 DDL)在共享测试库上可能要好几秒。
jest.setTimeout(60_000);

describePostgres('chat send critical section and direct read lock', () => {
  let live: LiveSchema;
  let service: ChatService;

  beforeAll(async () => {
    live = await openLiveSchema('chat_send_lock');
    // 生产上发消息的 INSERT 会触发取号触发器(顺带更新会话行),按迁移原文装上。
    await live.db.query(
      readMigration('20261019000000_read_started_burn_revision'),
    );
    await live.db.query(
      `CREATE TRIGGER chat_message_assign_revision BEFORE INSERT OR UPDATE ON "ChatMessage"
       FOR EACH ROW EXECUTE FUNCTION chat_message_assign_revision()`,
    );
    await live.db.query(
      readMigration('20261019000100_pending_read_burn_index'),
    );
    service = makeService(live);
  });

  afterAll(async () => {
    await live?.close();
  });

  beforeEach(async () => {
    await live.db.query(`
      TRUNCATE "User", "ChatConversation", "ChatMember", "ChatMessage", "Block",
        "UserPrivacySetting", "SupportAgent", "ChatDirectAutoReplyJob",
        "SupportRechargeJob", "CircleMember", "AccountIdentifier", "TempChat",
        "TempChatGuest" CASCADE;
    `);
    await seedUsers(live.db, ['a', 'b', 'c']);
    await live.db.query(`
      INSERT INTO "ChatConversation" (id, type, "directKey", "nextHeight", "updatedAt")
      VALUES ('dm', 'DIRECT', 'a:b', 0, now());
      INSERT INTO "ChatConversation" (id, type, "ownerID", "nextHeight", "updatedAt")
      VALUES ('grp', 'GROUP', 'a', 0, now());
      INSERT INTO "ChatMember" (id, "conversationID", "userID") VALUES
        ('dm-a', 'dm', 'a'), ('dm-b', 'dm', 'b'),
        ('grp-a', 'grp', 'a'), ('grp-b', 'grp', 'b'), ('grp-c', 'grp', 'c');
    `);
    live.statements.length = 0;
  });

  const send = (
    sender: string,
    conversationId: string,
    d: string,
    text = 'hello',
  ) =>
    service.sendMessage(sender, {
      conversationId,
      type: 'text',
      content: { text },
      d,
    });

  const messages = async (conversationId: string) =>
    (
      await live.db.query<{ height: number; senderID: string; text: string }>(
        `SELECT height, "senderID", content->>'text' AS text FROM "ChatMessage"
         WHERE "conversationID" = $1 ORDER BY height`,
        [conversationId],
      )
    ).rows;

  describe('send', () => {
    it('keeps only one recheck statement and the writes inside the DIRECT lock', async () => {
      const result = await send('a', 'dm', 'd1');
      expect(result.reused).toBe(false);
      expect(result.message.height).toBe(1);

      const inside = statementsAfter(live.statements, isLock).map(
        (statement) => statement.sql,
      );
      // 最早是 10 条;上一轮收到 5 条(座位、拉黑、幂等、INSERT、会话 UPDATE)。
      // 现在座位 + 拉黑 + 幂等合成一条复查,剩 3 条。
      expect(inside).toHaveLength(3);
      expect(inside[0]).toMatch(/FROM "ChatMember"/);
      expect(inside[0]).toMatch(/"Block"/);
      expect(inside[0]).toMatch(/"clientMessageId"/);
      expect(inside[1]).toMatch(/INSERT INTO "[^"]+"\."ChatMessage"/);
      expect(
        inside.some((sql) => /UserPrivacySetting|SupportAgent/.test(sql)),
      ).toBe(false);
    });

    it('keeps the GROUP lock to one recheck statement and the writes', async () => {
      await send('a', 'grp', 'g1');
      const inside = statementsAfter(live.statements, isLock);
      expect(inside).toHaveLength(3);
    });

    // 往返次数预算:每多一次往返,后端单核就多花一份「发起查询」的开销(压测里
    // 这部分占忙碌 CPU 的一半以上)。往发送路径加查询之前先看这个数。
    // 7 = 锁外预检 | BEGIN、锁行、锁内复查、INSERT、推进、COMMIT。
    // 原来私聊 16(另有焚毁档位那次读被本文件的桩吃掉)、群 12。
    it.each([
      ['DIRECT', 'dm'],
      ['GROUP', 'grp'],
    ])('spends 7 database round trips on a %s send', async (_type, id) => {
      await send('a', id, 'budget');
      // 记录器把 COMMIT 记两次(引擎发出的那条语句 + 适配器的 commit 钩子),只算一次。
      const roundTrips = live.statements
        .map((statement) => statement.sql)
        .filter(
          (sql, index, all) => sql !== 'COMMIT' || all[index - 1] !== sql,
        );
      expect(roundTrips).toHaveLength(7);
    });

    it('carries the sender nickname and group alias without a query after commit', async () => {
      await live.db.query(
        `UPDATE "ChatMember" SET alias = '阿甲' WHERE id = 'grp-a'`,
      );
      const result = await send('a', 'grp', 'g1');
      expect(result.message.sender).toEqual({
        id: 'a',
        nickname: 'a',
        avatarUrl: null,
        alias: '阿甲',
      });
      expect(live.statements[live.statements.length - 1].sql).toBe('COMMIT');
    });

    it("stamps the sender's own self-destruct window on the message", async () => {
      await live.db.query(`
        INSERT INTO "UserPrivacySetting" (id, "userID", "messageSelfDestructSec", "updatedAt")
        VALUES ('ps-a', 'a', 3600, now());
      `);
      await send('a', 'dm', 'd1');
      await send('b', 'dm', 'd2');
      expect(
        (
          await live.db.query(
            `SELECT "senderID", "burnDurationSec" FROM "ChatMessage"
             WHERE "conversationID" = 'dm' ORDER BY height`,
          )
        ).rows,
      ).toEqual([
        { senderID: 'a', burnDurationSec: 3600 },
        { senderID: 'b', burnDurationSec: null },
      ]);
    });

    it('advances the counter, clears hidden seats and leaves the row exactly as before', async () => {
      await live.db.query(
        `UPDATE "ChatMember" SET "hiddenAt" = now() WHERE id IN ('grp-b', 'grp-c')`,
      );
      await send('a', 'grp', 'g1', 'one');
      await send('b', 'grp', 'g2', 'two');

      expect(await messages('grp')).toEqual([
        { height: 1, senderID: 'a', text: 'one' },
        { height: 2, senderID: 'b', text: 'two' },
      ]);
      const conversation = (
        await live.db.query(
          `SELECT "nextHeight", "lastMessageAt", "updatedAt" > "createdAt" AS touched
           FROM "ChatConversation" WHERE id = 'grp'`,
        )
      ).rows[0];
      const last = (
        await live.db.query(
          `SELECT "createdAt" FROM "ChatMessage" WHERE "conversationID" = 'grp' AND height = 2`,
        )
      ).rows[0];
      expect(conversation.nextHeight).toBe(2);
      expect(conversation.lastMessageAt).toEqual(last.createdAt);
      expect(conversation.touched).toBe(true);
      expect(
        (
          await live.db.query(
            `SELECT count(*)::int AS n FROM "ChatMember" WHERE "hiddenAt" IS NOT NULL`,
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it('still rejects a blocked DIRECT peer inside the lock and leaves the counter alone', async () => {
      await send('a', 'dm', 'd1');
      // 锁外预检之后、锁内复查之前被拉黑:锁内那一道必须拦住。
      await live.db.query(
        `INSERT INTO "Block" (id, "blockerID", "blockedID") VALUES ('blk', 'b', 'a')`,
      );
      await expect(send('a', 'dm', 'd2')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(await messages('dm')).toHaveLength(1);
    });

    // 禁言到期时间从合并语句里读回来之后仍要是能比较的时间:到期的放行,没到期的拦。
    it('lets an expired silence through and rejects one that is still running', async () => {
      await live.db.query(`
        UPDATE "ChatMember" SET "silencedAt" = now() - interval '2 hours',
          "silencedUntil" = now() - interval '1 hour' WHERE id = 'grp-b';
        UPDATE "ChatMember" SET "silencedAt" = now(),
          "silencedUntil" = now() + interval '1 hour' WHERE id = 'grp-c';
      `);
      expect((await send('b', 'grp', 'g1')).message.height).toBe(1);
      await expect(send('c', 'grp', 'g2')).rejects.toMatchObject({
        response: { errorCode: 'CHAT_MEMBER_SILENCED' },
      });
      expect(await messages('grp')).toHaveLength(1);
    });

    it('rejects a sender with no seat, or a seat that has left, before taking the lock', async () => {
      await live.db.query(
        `UPDATE "ChatMember" SET "leftAt" = now() WHERE id = 'grp-b'`,
      );
      for (const [sender, conversationId] of [
        ['c', 'dm'],
        ['b', 'grp'],
      ]) {
        await expect(
          send(sender, conversationId, `x-${sender}`),
        ).rejects.toMatchObject({ response: { errorCode: 'CHAT_NOT_MEMBER' } });
      }
      expect(live.statements.some((statement) => isLock(statement.sql))).toBe(
        false,
      );
    });

    // 自己和自己的单聊没有对端:不查拉黑、不入队,哪怕本人开着自动回复。
    it('treats a DIRECT conversation with oneself as having no peer', async () => {
      await live.db.query(`
        INSERT INTO "ChatConversation" (id, type, "directKey", "nextHeight", "updatedAt")
        VALUES ('self', 'DIRECT', 'a:a', 0, now());
        INSERT INTO "ChatMember" (id, "conversationID", "userID") VALUES ('self-a', 'self', 'a');
        INSERT INTO "UserPrivacySetting" (id, "userID", "directMessageAutoReplyEnabled", "directMessageAutoReplyText", "updatedAt")
        VALUES ('ps-a', 'a', true, '稍后回复', now());
        INSERT INTO "SupportAgent" (id, category, "userID") VALUES ('sa-a', 'recharge', 'a');
      `);
      const result = await send('a', 'self', 's1');
      expect(result.message.height).toBe(1);
      expect(result.enqueuedJobs).toEqual({
        directAutoReplyJobId: null,
        supportRechargeJobId: null,
      });
    });

    // 临时房访客没有 User 行:昵称来自 TempChatGuest,房间结束后拒发。
    it('sends for a temp-room guest and rejects once the room has ended', async () => {
      await live.db.query(`
        INSERT INTO "TempChat" (id, "groupId", "hostUserId", "expiresAt", "updatedAt")
        VALUES ('room', 'room-group', 'a', now() + interval '1 hour', now());
        INSERT INTO "TempChatGuest" (id, "tempChatId", "imUserId", "displayName")
        VALUES ('guest-row', 'room', 'guest-1', '访客小王');
        INSERT INTO "ChatConversation" (id, type, "tempChatID", "nextHeight", "updatedAt")
        VALUES ('tmp', 'TEMP', 'room', 0, now());
        INSERT INTO "ChatMember" (id, "conversationID", "userID") VALUES
          ('tmp-a', 'tmp', 'a'), ('tmp-g', 'tmp', 'guest-1');
      `);
      const result = await send('guest-1', 'tmp', 't1');
      expect(result.message.sender).toEqual({
        id: 'guest-1',
        nickname: '访客小王',
        avatarUrl: null,
        alias: null,
      });

      await live.db.query(`UPDATE "TempChat" SET status = 'ENDED'`);
      await expect(send('guest-1', 'tmp', 't2')).rejects.toMatchObject({
        response: { errorCode: 'CHAT_CONVERSATION_NOT_FOUND' },
      });
      expect(await messages('tmp')).toHaveLength(1);
    });

    it('enqueues jobs only when eligible, inside the send transaction', async () => {
      await live.db.query(`
        INSERT INTO "UserPrivacySetting" (id, "userID", "directMessageAutoReplyEnabled", "directMessageAutoReplyText", "updatedAt")
        VALUES ('ps-b', 'b', true, '稍后回复', now());
        INSERT INTO "SupportAgent" (id, category, "userID") VALUES ('sa-b', 'recharge', 'b');
      `);
      const first = await send('a', 'dm', 'd1');
      const jobs = async () =>
        (
          await live.db.query(
            `SELECT 'auto' AS kind, "sourceMessageID" FROM "ChatDirectAutoReplyJob"
             UNION ALL SELECT 'recharge', "sourceMessageID" FROM "SupportRechargeJob"
             ORDER BY 1`,
          )
        ).rows;
      expect(await jobs()).toEqual([
        { kind: 'auto', sourceMessageID: first.message.id },
        { kind: 'recharge', sourceMessageID: first.message.id },
      ]);
      // 任务与消息同一事务写入。
      const tx = transactionOf(live.statements, isLock).map((s) => s.sql);
      expect(
        tx.some((sql) =>
          /INSERT INTO "[^"]+"\."ChatDirectAutoReplyJob"/.test(sql),
        ),
      ).toBe(true);
      expect(
        tx.some((sql) => /INSERT INTO "[^"]+"\."SupportRechargeJob"/.test(sql)),
      ).toBe(true);
      expect(first.enqueuedJobs).toEqual({
        directAutoReplyJobId: expect.any(String),
        supportRechargeJobId: expect.any(String),
      });

      // 关掉之后不再入队;群消息永远不入队。
      await live.db.query(
        `UPDATE "UserPrivacySetting" SET "directMessageAutoReplyEnabled" = false;
         UPDATE "SupportAgent" SET enabled = false`,
      );
      const second = await send('a', 'dm', 'd2');
      const group = await send('a', 'grp', 'g1');
      expect(second.enqueuedJobs).toEqual({
        directAutoReplyJobId: null,
        supportRechargeJobId: null,
      });
      expect(group.enqueuedJobs).toEqual({
        directAutoReplyJobId: null,
        supportRechargeJobId: null,
      });
      expect(await jobs()).toHaveLength(2);
    });

    it('does not enqueue for a whitespace-only auto reply or a recharge agent whose account is not active', async () => {
      await live.db.query(`
        INSERT INTO "UserPrivacySetting" (id, "userID", "directMessageAutoReplyEnabled", "directMessageAutoReplyText", "updatedAt")
        VALUES ('ps-b', 'b', true, E' \n\u3000', now());
        INSERT INTO "SupportAgent" (id, category, "userID") VALUES ('sa-b', 'recharge', 'b');
        UPDATE "User" SET status = 'BANNED' WHERE id = 'b';
      `);
      const result = await send('a', 'dm', 'd1');
      expect(result.enqueuedJobs).toEqual({
        directAutoReplyJobId: null,
        supportRechargeJobId: null,
      });
    });

    it('returns the stored row on an idempotent retry without enqueuing again', async () => {
      await live.db.query(`
        INSERT INTO "UserPrivacySetting" (id, "userID", "directMessageAutoReplyEnabled", "directMessageAutoReplyText", "updatedAt")
        VALUES ('ps-b', 'b', true, '稍后回复', now());
      `);
      const first = await send('a', 'dm', 'd1');
      const retry = await send('a', 'dm', 'd1');
      expect(retry.reused).toBe(true);
      expect(retry.message.id).toBe(first.message.id);
      expect(retry.enqueuedJobs).toBeNull();
      expect(
        (
          await live.db.query(
            'SELECT count(*)::int AS n FROM "ChatDirectAutoReplyJob"',
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it('refuses a retry of the same delivery id that carries different content', async () => {
      await send('a', 'dm', 'd1', 'first');
      await expect(send('a', 'dm', 'd1', 'second')).rejects.toMatchObject({
        response: { errorCode: 'CHAT_DELIVERY_ID_CONFLICT' },
      });
      expect(await messages('dm')).toEqual([
        { height: 1, senderID: 'a', text: 'first' },
      ]);
    });

    describe('concurrently', () => {
      let other: Client;
      beforeEach(async () => {
        other = await live.connect();
      });

      it('serializes two senders on the conversation row with gapless heights', async () => {
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            send(i % 2 ? 'b' : 'a', 'dm', `c${i}`, `m${i}`),
          ),
        );
        expect(
          results.map((r) => r.message.height).sort((a, b) => a - b),
        ).toEqual([1, 2, 3, 4, 5, 6]);
        expect(
          (
            await live.db.query(
              `SELECT "nextHeight" FROM "ChatConversation" WHERE id = 'dm'`,
            )
          ).rows[0].nextHeight,
        ).toBe(6);
      });

      // 另一个事务先占住会话行锁:发送已经过了锁外预检、卡在取锁上。这时把发送者
      // 拉黑 / 移出 / 禁言再放锁,落库前的锁内复查必须拦住,且不推进计数器。
      it.each([
        [
          'blocked by the peer',
          'dm',
          `INSERT INTO "Block" (id, "blockerID", "blockedID") VALUES ('blk', 'b', 'a')`,
        ],
        [
          'removed from the group',
          'grp',
          `UPDATE "ChatMember" SET "leftAt" = now() WHERE id = 'grp-a'`,
        ],
        [
          'silenced in the group',
          'grp',
          `UPDATE "ChatMember" SET "silencedAt" = now() WHERE id = 'grp-b'`,
        ],
      ])(
        'rejects a sender %s between the pre-check and the lock',
        async (_what, conversationId, change) => {
          const sender = /grp-b/.test(change) ? 'b' : 'a';
          await other.query('BEGIN');
          await other.query(
            `SELECT id FROM "ChatConversation" WHERE id = $1 FOR UPDATE`,
            [conversationId],
          );
          const sending = send(sender, conversationId, 'late');
          const outcome =
            expect(sending).rejects.toBeInstanceOf(ForbiddenException);
          await waitUntilBlocked(live.db, (query) => /FOR UPDATE/.test(query));
          await other.query(change);
          await other.query('COMMIT');
          await outcome;
          expect(await messages(conversationId)).toHaveLength(0);
          expect(
            (
              await live.db.query(
                `SELECT "nextHeight" FROM "ChatConversation" WHERE id = $1`,
                [conversationId],
              )
            ).rows[0].nextHeight,
          ).toBe(0);
        },
      );

      it('turns a racing duplicate into an idempotent reuse rather than a unique violation', async () => {
        // 另一个事务先占住会话行锁,两次同 d 的发送都排在它后面。
        await other.query('BEGIN');
        await other.query(
          `SELECT id FROM "ChatConversation" WHERE id = 'dm' FOR UPDATE`,
        );
        const racing = Promise.all([
          send('a', 'dm', 'dup'),
          send('a', 'dm', 'dup'),
        ]);
        await waitUntilBlocked(live.db, (query) => /FOR UPDATE/.test(query));
        await other.query('COMMIT');
        const [x, y] = await racing;
        expect([x.reused, y.reused].filter(Boolean)).toEqual([true]);
        expect(x.message.id).toBe(y.message.id);
        expect(await messages('dm')).toHaveLength(1);
      });
    });
  });

  describe('direct markRead', () => {
    let other: Client;
    beforeEach(async () => {
      other = await live.connect();
    });

    const holdConversationLock = async () => {
      await other.query('BEGIN');
      await other.query(
        `SELECT id FROM "ChatConversation" WHERE id = 'dm' FOR UPDATE`,
      );
    };

    it('no longer waits for an in-flight send when no burn timer can start', async () => {
      await send('a', 'dm', 'd1');
      await send('a', 'dm', 'd2');
      await holdConversationLock();
      live.statements.length = 0;

      const outcome = await settleWithin(service.markRead('b', 'dm', 2), 1500);
      await other.query('COMMIT');
      expect(outcome).toEqual({
        value: { advanced: true, height: 2, conversationType: 'DIRECT' },
      });
      expect(live.statements.some((s) => isLock(s.sql))).toBe(false);
      const seat = (
        await live.db.query(
          `SELECT "lastReadHeight" FROM "ChatMember" WHERE id = 'dm-b'`,
        )
      ).rows[0];
      expect(seat.lastReadHeight).toBe(2);
      // 重复回执:不推进。
      await expect(service.markRead('b', 'dm', 2)).resolves.toEqual({
        advanced: false,
        height: 2,
        conversationType: 'DIRECT',
      });
    });

    it('still takes the conversation lock and starts timers when a burn message is pending', async () => {
      await send('a', 'dm', 'd1');
      await live.db.query(
        `UPDATE "ChatMessage" SET "burnDurationSec" = 30 WHERE "conversationID" = 'dm'`,
      );
      await holdConversationLock();

      const pending = service.markRead('b', 'dm', 1);
      const early = await settleWithin(pending, 500);
      expect(early).toBe('pending');
      await other.query('COMMIT');
      await expect(pending).resolves.toEqual({
        advanced: true,
        height: 1,
        conversationType: 'DIRECT',
      });
      const row = (
        await live.db.query(
          `SELECT "burnExpiresAt" IS NOT NULL AS started FROM "ChatMessage" WHERE "conversationID" = 'dm'`,
        )
      ).rows[0];
      expect(row.started).toBe(true);
    });

    it('rejects a reader whose seat is gone, as the locked path did', async () => {
      await send('a', 'dm', 'd1');
      await send('a', 'dm', 'd2');
      // requireMembership 之后、写水位之前离座:要和原来一样报 NotMember。
      const original = live.prisma.chatMember.findUnique.bind(
        live.prisma.chatMember,
      );
      const spy = jest
        .spyOn(live.prisma.chatMember, 'findUnique')
        .mockImplementationOnce((async (args: never) => {
          const seat = await original(args);
          await live.db.query(
            `UPDATE "ChatMember" SET "leftAt" = now() WHERE id = 'dm-b'`,
          );
          return seat as never;
        }) as never);
      try {
        await expect(service.markRead('b', 'dm', 2)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      } finally {
        spy.mockRestore();
      }
      const seat = (
        await live.db.query(
          `SELECT "lastReadHeight" FROM "ChatMember" WHERE id = 'dm-b'`,
        )
      ).rows[0];
      expect(seat.lastReadHeight).toBe(0);
    });
  });

  describe('pending read-burn pre-check', () => {
    /** 同一份夹具上,无锁预检的答案必须等于 startReadBurnTimers 是否真的启动了计时。 */
    const cases: Array<[string, string]> = [
      ['pending peer message', ''],
      ['own message', `UPDATE "ChatMessage" SET "senderID" = 'b'`],
      ['no burn duration', `UPDATE "ChatMessage" SET "burnDurationSec" = NULL`],
      ['zero burn duration', `UPDATE "ChatMessage" SET "burnDurationSec" = 0`],
      [
        'timer already started',
        `UPDATE "ChatMessage" SET "burnExpiresAt" = now() + interval '1 minute'`,
      ],
      ['burned', `UPDATE "ChatMessage" SET deleted = true`],
      ['revoked', `UPDATE "ChatMessage" SET "revokedAt" = now()`],
      [
        'above the read height',
        // height 不可变(取号触发器拦),换一条高度在水位之上的消息。
        `DELETE FROM "ChatMessage";
         INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content, "burnDurationSec", "createdAt")
         VALUES ('m9', 'dm', 9, 'a', 'text', '{}', 30, now())`,
      ],
      [
        'below the reader clear floor',
        `UPDATE "ChatMember" SET "clearedBeforeHeight" = 1 WHERE id = 'dm-b'`,
      ],
      [
        'below the conversation clear floor',
        `UPDATE "ChatConversation" SET "clearedBeforeHeight" = 1 WHERE id = 'dm'`,
      ],
      [
        'before the reader joined',
        `UPDATE "ChatMember" SET "joinedAt" = now() + interval '1 day' WHERE id = 'dm-b'`,
      ],
      [
        'reader left',
        `UPDATE "ChatMember" SET "leftAt" = now() WHERE id = 'dm-b'`,
      ],
      [
        'group conversation',
        `UPDATE "ChatConversation" SET type = 'GROUP' WHERE id = 'dm'`,
      ],
    ];

    it.each(cases)(
      'agrees with startReadBurnTimers: %s',
      async (_name, mutate) => {
        await live.db.query(`
        UPDATE "ChatConversation" SET "nextHeight" = 9 WHERE id = 'dm';
        INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content, "burnDurationSec", "createdAt")
        VALUES ('m1', 'dm', 1, 'a', 'text', '{}', 30, now());
      `);
        if (mutate) await live.db.query(mutate);
        const q = pendingReadBurnTimersQuery('dm', 'b', 5);
        const pending = (
          await live.db.query<{ pending: boolean }>(q.text, q.values)
        ).rows[0].pending;
        const revision = await live.prisma.$transaction((tx) =>
          startReadBurnTimers(tx, 'dm', 'b', 5),
        );
        expect(pending).toBe(revision > 0);
        expect(pending).toBe(_name === 'pending peer message');
      },
    );

    it('answers from the pending-read partial index', async () => {
      await live.db.query(`
        INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content, "createdAt")
        SELECT 'bulk-' || g, 'dm', g, 'a', 'text', '{}', now() FROM generate_series(1, 5000) g;
        UPDATE "ChatConversation" SET "nextHeight" = 5000 WHERE id = 'dm';
        ANALYZE "ChatMessage"; ANALYZE "ChatMember"; ANALYZE "ChatConversation";
      `);
      const q = pendingReadBurnTimersQuery('dm', 'b', 5000);
      const plan = await explainPlan(live.db, q.text, q.values);
      expect(plan).toContain('ChatMessage_pending_read_burn_idx');
    });
  });
});

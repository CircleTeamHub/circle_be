import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { AdminImService } from 'src/admin-im/admin-im.service';
import { describePostgres, explainPlan } from './pg-test-db';
import {
  openPrismaSchema,
  type PrismaHandle,
  type PrismaSchemaDb,
} from './prisma-schema-db';

/**
 * 管理台读聊天记录(AdminImService.messages)与发送路径的锁冲突,真库回归。
 *
 * 以前:事务里先对 ChatConversation 拿 FOR SHARE,再做没有索引的文本扫描,最后写审计。
 * 发送路径对同一行 FOR UPDATE —— 管理员在大群里搜一个罕见词,扫描期间整个会话的发送
 * 全被卡住。现在:扫描放在拿会话锁之前(只取候选 id),拿锁后按主键复核候选再读正文、写审计。
 *
 * 「扫描进行中」不靠计时去碰运气:另开一个会话对 ChatMessage 持 ACCESS EXCLUSIVE,
 * 管理员的扫描就停在半路(pg_stat_activity 里看得到它在等 relation 锁),这时再看
 * 发送路径的 FOR UPDATE 能不能拿到。
 */
const ADMIN_ROLES_WITH_READ = 'SUPPORT';
const NEEDLE = 'needle';
const BIG = 50_000;

describePostgres('AdminImService.messages vs. the send path lock', () => {
  let env: PrismaSchemaDb;
  let db: Client;
  let admin: PrismaHandle;
  let service: AdminImService;
  let adminId: string;
  let conversationId: string;
  const extraClients: Client[] = [];

  const connect = async () => {
    const client = new Client({
      connectionString: process.env.POSTGRES_TEST_DATABASE_URL,
    });
    await client.connect();
    await client.query(`SET search_path TO "${env.schema}", public`);
    extraClients.push(client);
    return client;
  };

  beforeAll(async () => {
    env = await openPrismaSchema('admin_im_read');
    db = env.db;
    admin = env.client(4);
    service = new AdminImService(
      admin.prisma as never,
      {} as never,
      {} as never,
      { createPresignedGetUrl: jest.fn() } as never,
    );
  }, 60_000);

  afterEach(async () => {
    // 断开即释放这些会话持有的锁,失败的用例不会把管理员的查询永远挂住。
    for (const client of extraClients.splice(0)) {
      await client.end().catch(() => undefined);
    }
  });

  afterAll(async () => {
    await env?.close();
  });

  beforeEach(async () => {
    await db.query(
      `TRUNCATE "AdminAuditLog", "ChatBurnArchive", "ChatMessage", "ChatConversation",
                "AdminAccess", "User", "AccountIdentifier" CASCADE`,
    );
    adminId = randomUUID();
    conversationId = randomUUID();
    await db.query(
      `INSERT INTO "AccountIdentifier" (value, "updatedAt") VALUES ($1, now())`,
      [`adm_${adminId.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO "User" (id, "accountId", "inviteCode", "passwordHash", nickname, "updatedAt", role, status)
       VALUES ($1, $2, $3, 'x', 'admin', now(), 'ADMIN', 'ACTIVE')`,
      [adminId, `adm_${adminId.slice(0, 8)}`, `ADM${adminId.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO "AdminAccess" ("userID", role, "updatedAt") VALUES ($1, $2, now())`,
      [adminId, ADMIN_ROLES_WITH_READ],
    );
    // 大群:BIG 条普通消息,罕见词只在 10/20/30/40/50 这五条里 —— 带关键词的查询
    // 要从最新一条一路扫到最底下。
    await db.query(
      `INSERT INTO "ChatConversation" (id, type, "updatedAt", "nextHeight") VALUES ($1, 'GROUP', now(), $2)`,
      [conversationId, BIG + 1],
    );
    await db.query(
      `INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content, "createdAt")
       SELECT 'm' || g, $1, g, 'sender', 'text',
              jsonb_build_object('text', CASE WHEN g % 10 = 0 AND g <= 50
                                              THEN 'the ${NEEDLE} #' || g
                                              ELSE 'ordinary chatter line ' || g END),
              now() - make_interval(secs => $2 - g)
       FROM generate_series(1, $2::int) g`,
      [conversationId, BIG],
    );
    await db.query('ANALYZE "ChatMessage"');
  });

  const query = (overrides: Record<string, unknown> = {}) => ({
    reason: 'abuse report review',
    limit: 3,
    text: NEEDLE,
    ...overrides,
  });

  const waitFor = async (check: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  /** 管理员那边(按 application_name 认)有连接卡在某类锁上。 */
  const adminWaitsOn = (waitEvents: string[]) => async () =>
    (
      await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE application_name = $1 AND wait_event_type = 'Lock' AND wait_event = ANY($2)`,
        [env.schema, waitEvents],
      )
    ).rows[0].n > 0;

  /** 发送路径的第一步:对会话行 FOR UPDATE(分配 height)。lock_timeout 内拿不到就报错。 */
  const beginSend = async (client: Client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '1s'`);
    const started = Date.now();
    await client.query(
      `SELECT "nextHeight" FROM "ChatConversation" WHERE id = $1 FOR UPDATE`,
      [conversationId],
    );
    return Date.now() - started;
  };

  const finishSend = async (client: Client, height: number, text: string) => {
    await client.query(
      `INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content)
       VALUES ($1, $2, $3, 'sender', 'text', $4)`,
      [`sent-${height}`, conversationId, height, { text }],
    );
    await client.query(
      `UPDATE "ChatConversation" SET "nextHeight" = $2, "lastMessageAt" = now() WHERE id = $1`,
      [conversationId, height + 1],
    );
    await client.query('COMMIT');
  };

  const audits = async () =>
    (
      await db.query<{
        actorID: string;
        action: string;
        entityType: string;
        entityID: string;
        reason: string;
        after: Record<string, unknown>;
      }>(
        `SELECT "actorID", action, "entityType", "entityID", reason, after FROM "AdminAuditLog" ORDER BY "createdAt"`,
      )
    ).rows;

  const heights = (result: { items: Array<{ height: number }> }) =>
    result.items.map((item) => item.height);

  it('lets a send take the conversation lock while the keyword scan is still running', async () => {
    const staller = await connect();
    const sender = await connect();
    await staller.query('BEGIN');
    await staller.query('LOCK TABLE "ChatMessage" IN ACCESS EXCLUSIVE MODE');

    const read = service.messages(adminId, conversationId, query());
    const settled = read.then(
      () => 'done',
      () => 'failed',
    );
    // 扫描停在半路:管理员在等 ChatMessage 的表锁。
    await waitFor(adminWaitsOn(['relation']), 'the admin scan to start');

    // 以前这里会等到 lock_timeout(管理员持有会话行 FOR SHARE,直到扫描 + 审计提交)。
    const waited = await beginSend(sender);
    expect(waited).toBeLessThan(500);

    // 扫描放行:管理员接着要拿会话锁复核,这回轮到它等发送提交(锁序与原来一致)。
    await staller.query('COMMIT');
    await waitFor(
      adminWaitsOn(['transactionid', 'tuple']),
      'the admin to queue behind the send',
    );
    await finishSend(sender, BIG + 1, `a fresh ${NEEDLE}`);

    expect(await settled).toBe('done');
    const result = await read;
    // 候选在发送前就扫完了:这一页是扫描开始那一刻的结果(新消息下一次查询可见)。
    expect(heights(result)).toEqual([50, 40, 30]);
    expect(result.nextCursor).toBe(30);
    expect(result.items[0].content).toEqual({ text: `the ${NEEDLE} #50` });
    expect(await audits()).toEqual([
      expect.objectContaining({
        actorID: adminId,
        action: 'IM_MESSAGES_READ',
        entityID: conversationId,
        after: expect.objectContaining({ textFilterUsed: true, returned: 3 }),
      }),
    ]);
  });

  it('does the same for the burn-archive search', async () => {
    await db.query(`UPDATE "AdminAccess" SET role = 'SUPER_ADMIN'`);
    await db.query(
      `INSERT INTO "ChatBurnArchive" (id, "conversationID", height, type, content, "createdAt", "burnExpiresAt", "retainUntil")
       SELECT 'a' || g, $1, g, 'text',
              jsonb_build_object('text', CASE WHEN g IN (7, 9) THEN 'archived ${NEEDLE} ' || g ELSE 'archived ' || g END),
              now(), now(), now() + interval '180 days'
       FROM generate_series(1, 2000) g`,
      [conversationId],
    );
    const staller = await connect();
    const sender = await connect();
    await staller.query('BEGIN');
    await staller.query(
      'LOCK TABLE "ChatBurnArchive" IN ACCESS EXCLUSIVE MODE',
    );

    const read = service.messages(adminId, conversationId, query(), true);
    await waitFor(adminWaitsOn(['relation']), 'the archive scan to start');
    expect(await beginSend(sender)).toBeLessThan(500);
    await sender.query('ROLLBACK');
    await staller.query('COMMIT');

    const result = await read;
    expect(heights(result)).toEqual([9, 7]);
    expect(result.source).toBe('BURN_ARCHIVE');
    expect(result.nextCursor).toBeNull();
    expect((await audits())[0]).toMatchObject({
      action: 'IM_BURN_ARCHIVE_READ',
      after: expect.objectContaining({ returned: 2 }),
    });
  });

  it('still orders the read against a concurrent clear/recall: the committed state wins', async () => {
    const writer = await connect();
    await writer.query('BEGIN');
    await writer.query(
      `SELECT id FROM "ChatConversation" WHERE id = $1 FOR UPDATE`,
      [conversationId],
    );
    // 清空到 25(10、20 消失)并撤回 50,都还没提交。
    await writer.query(
      `UPDATE "ChatConversation" SET "clearedBeforeHeight" = 25 WHERE id = $1`,
      [conversationId],
    );
    await writer.query(
      `UPDATE "ChatMessage" SET "revokedAt" = now(), content = '{}' WHERE id = 'm50'`,
    );

    const read = service.messages(adminId, conversationId, query());
    await waitFor(
      adminWaitsOn(['transactionid', 'tuple']),
      'the admin to wait for the clear',
    );
    await writer.query('COMMIT');
    const first = await read;

    // 读到的只能是提交后的状态:被撤回、被清空的一条都不能露出来。
    const seen = heights(first);
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await service.messages(
        adminId,
        conversationId,
        query({ cursor }),
      );
      seen.push(...heights(page));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([40, 30]);
    expect(
      JSON.stringify(first.items.map((item) => item.content)),
    ).not.toContain('#50');
  });

  it('keeps the response, paging and the audit record unchanged for an ordinary keyword search', async () => {
    const first = await service.messages(adminId, conversationId, query());
    expect(heights(first)).toEqual([50, 40, 30]);
    expect(first.nextCursor).toBe(30);
    expect(first.source).toBe('SELF_HOSTED');
    expect(first.items[1]).toMatchObject({
      id: 'm40',
      conversationId,
      senderId: 'sender',
      type: 'text',
      content: { text: `the ${NEEDLE} #40` },
      visibleUntil: null,
    });

    const second = await service.messages(
      adminId,
      conversationId,
      query({ cursor: 30 }),
    );
    expect(heights(second)).toEqual([20, 10]);
    expect(second.nextCursor).toBeNull();

    const unfiltered = await service.messages(
      adminId,
      conversationId,
      query({ text: undefined, limit: 2 }),
    );
    expect(heights(unfiltered)).toEqual([BIG, BIG - 1]);
    expect(unfiltered.nextCursor).toBe(BIG - 1);

    const rows = await audits();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      actorID: adminId,
      action: 'IM_MESSAGES_READ',
      entityType: 'ChatConversation',
      entityID: conversationId,
      reason: 'abuse report review',
      after: {
        senderId: null,
        from: null,
        to: null,
        textFilterUsed: true,
        cursor: null,
        limit: 3,
        returned: 3,
      },
    });
    expect(rows[1].after).toMatchObject({ cursor: 30, returned: 2 });
    expect(rows[2].after).toMatchObject({
      textFilterUsed: false,
      returned: 2,
    });
  });

  it('holds the conversation lock only for primary-key lookups of the candidates', async () => {
    const observation = admin.observe();
    await service.messages(adminId, conversationId, query());
    observation.stop();

    const lockAt = observation.statements.findIndex((sql) =>
      /FROM "ChatConversation" WHERE "id" = \$1 FOR SHARE/.test(sql),
    );
    const messageReads = observation.calls
      .map((call, index) => ({ ...call, index }))
      .filter((call) => /FROM "[^"]+"\."ChatMessage"/.test(call.text));
    expect(messageReads).toHaveLength(2);
    const [scan, recheck] = messageReads;
    // 文本扫描在拿会话锁之前,锁之后只剩按 id 复核。
    expect(scan.index).toBeLessThan(lockAt);
    expect(recheck.index).toBeGreaterThan(lockAt);
    const plan = await explainPlan(db, recheck.text, recheck.values);
    expect(plan).toContain('ChatMessage_pkey');
    expect(plan).not.toContain('ChatMessage_conversationID_height_key');
    expect(plan).not.toContain('Seq Scan');
  });

  it('refuses before touching messages when the grant was removed, and audits nothing', async () => {
    await db.query(`UPDATE "AdminAccess" SET role = 'OPERATIONS'`);
    const error = await service
      .messages(adminId, conversationId, query())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(403);
    expect(await audits()).toEqual([]);
  });

  it('answers 404 for an unknown conversation after the permission check', async () => {
    const error = await service
      .messages(adminId, randomUUID(), query())
      .catch((e: unknown) => e);
    expect((error as HttpException).getStatus()).toBe(404);
    expect(await audits()).toEqual([]);
  });
});

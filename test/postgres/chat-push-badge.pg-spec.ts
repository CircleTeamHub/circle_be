import { unreadBadgeQuery } from 'src/chat/chat-push-badge.query';
import { UNREAD_COUNT_CAP } from 'src/chat/chat.constants';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 推送角标查询在真 PostgreSQL 上的口径与成本:每个会话数到 UNREAD_COUNT_CAP
 * 就停,免打扰/隐藏/已退出的会话、自己发的、已删/已撤回/已焚毁的都不计。
 */
describePostgres('push badge unread query (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const badges = async (userIds: string[]) => {
    const q = unreadBadgeQuery(userIds);
    const { rows } = await s.db.query<{ userID: string; count: string }>(
      q.text,
      q.values,
    );
    return Object.fromEntries(rows.map((r) => [r.userID, Number(r.count)]));
  };

  /** 往会话里追加 n 条消息,height 接着现有最大值往上排。 */
  const addMessages = async (
    conversationID: string,
    n: number,
    extra: { senderID?: string; deleted?: boolean; revoked?: boolean } = {},
  ) => {
    await s.db.query(
      `INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", deleted, "revokedAt")
       SELECT $1 || '-' || (base.h + g), $1, base.h + g, $3, $4,
              CASE WHEN $5 THEN now() END
       FROM (SELECT COALESCE(MAX(height), 0) AS h FROM "ChatMessage" WHERE "conversationID" = $1) base,
            generate_series(1, $2::int) g`,
      [
        conversationID,
        n,
        extra.senderID ?? 'peer',
        extra.deleted ?? false,
        extra.revoked ?? false,
      ],
    );
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('push_badge');
    await s.db.query(`
      CREATE TABLE "ChatMember" (
        "conversationID" text NOT NULL, "userID" text NOT NULL,
        "lastReadHeight" integer NOT NULL DEFAULT 0,
        "clearedBeforeHeight" integer NOT NULL DEFAULT 0,
        "leftAt" timestamp, "hiddenAt" timestamp,
        muted boolean NOT NULL DEFAULT false
      );
      CREATE UNIQUE INDEX "ChatMember_conversationID_userID_key" ON "ChatMember"("conversationID", "userID");
      CREATE INDEX "ChatMember_userID_idx" ON "ChatMember"("userID");
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY, "conversationID" text NOT NULL, height integer NOT NULL,
        "senderID" text, deleted boolean NOT NULL DEFAULT false,
        "revokedAt" timestamp, "burnExpiresAt" timestamp
      );
      CREATE UNIQUE INDEX "ChatMessage_conversationID_height_key" ON "ChatMessage"("conversationID", height);
    `);
  });

  afterAll(async () => {
    await s?.close();
  });

  beforeEach(async () => {
    await s.db.query('TRUNCATE "ChatMember", "ChatMessage"');
  });

  it('stops each conversation at the cap and sums the capped values', async () => {
    await s.db
      .query(`INSERT INTO "ChatMember" ("conversationID", "userID") VALUES
      ('big', 'me'), ('small', 'me')`);
    await addMessages('big', UNREAD_COUNT_CAP + 50);
    await addMessages('small', 3);

    expect(await badges(['me'])).toEqual({ me: UNREAD_COUNT_CAP + 3 });
  });

  it('counts only what the app counts', async () => {
    await s.db.query(`INSERT INTO "ChatMember"
      ("conversationID", "userID", muted, "hiddenAt", "leftAt", "lastReadHeight", "clearedBeforeHeight") VALUES
      ('plain', 'me', false, NULL, NULL, 0, 0),
      ('muted', 'me', true, NULL, NULL, 0, 0),
      ('hidden', 'me', false, now(), NULL, 0, 0),
      ('left', 'me', false, NULL, now(), 0, 0),
      ('read', 'me', false, NULL, NULL, 4, 0),
      ('cleared', 'me', false, NULL, NULL, 0, 4)`);
    for (const c of ['plain', 'muted', 'hidden', 'left', 'read', 'cleared']) {
      await addMessages(c, 5);
    }
    await addMessages('plain', 2, { senderID: 'me' });
    await addMessages('plain', 1, { deleted: true });
    await addMessages('plain', 1, { revoked: true });
    await s.db
      .query(`INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", "burnExpiresAt")
      VALUES ('burned', 'plain', 100, 'peer', now() - interval '1 minute'),
             ('burning', 'plain', 101, 'peer', now() + interval '1 hour')`);

    // plain:5 + 未焚毁的 1;read / cleared 各剩水位之上的 1 条。
    expect(await badges(['me'])).toEqual({ me: 6 + 1 + 1 });
  });

  it('returns no row for a recipient with nothing unread and never mixes recipients', async () => {
    await s.db
      .query(`INSERT INTO "ChatMember" ("conversationID", "userID", "lastReadHeight") VALUES
      ('c', 'caught-up', 3), ('c', 'behind', 1), ('c', 'stranger', 0)`);
    await addMessages('c', 3);

    expect(await badges(['caught-up', 'behind'])).toEqual({ behind: 2 });
  });

  it('reads unread messages through the (conversationID, height) index', async () => {
    await s.db.query('SET enable_seqscan = off');
    try {
      const q = unreadBadgeQuery(['me']);
      const plan = await explainPlan(s.db, q.text, q.values);
      expect(plan).toContain('ChatMessage_conversationID_height_key');
      expect(plan).toContain('ChatMember_userID_idx');
    } finally {
      await s.db.query('RESET enable_seqscan');
    }
  });
});

import { unreadCountsQuery } from 'src/chat/chat-conversation-summary.query';
import {
  describePostgres,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

const NO_WINDOW = {
  viewerCutoff: null,
  viewerStartedAt: null,
  burnStartedAt: null,
  burnCutoff: null,
};

/**
 * 会话列表未读数:系统通知没有 senderID,操作人在 content.actorId。自己改群名、
 * 设管理员、禁言产生的通知以前照样算成自己的未读(群主刚改完设置就挂着一串红点)。
 */
describePostgres(
  'conversation unread excludes my own action notices (PostgreSQL)',
  () => {
    let s: IsolatedSchema;

    beforeAll(async () => {
      s = await openIsolatedSchema('unread_own_actions');
      await s.db.query(`
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY, "conversationID" text NOT NULL, height integer NOT NULL,
        "senderID" text, type text NOT NULL DEFAULT 'text', content jsonb NOT NULL DEFAULT '{}',
        deleted boolean NOT NULL DEFAULT false, "revokedAt" timestamp(3),
        "createdAt" timestamp(3) NOT NULL DEFAULT now(), "burnExpiresAt" timestamp(3)
      );
      CREATE UNIQUE INDEX "ChatMessage_conversationID_height_key" ON "ChatMessage"("conversationID", height);
    `);
    });

    afterAll(async () => {
      await s?.close();
    });

    it('counts other people and actor-less notices, not my own actions', async () => {
      await s.db
        .query(`INSERT INTO "ChatMessage" (id, "conversationID", height, "senderID", type, content) VALUES
      ('renamed', 'g', 1, NULL, 'system', '{"kind":"group-renamed","actorId":"me"}'),
      ('admin', 'g', 2, NULL, 'system', '{"kind":"member-role-changed","actorId":"me"}'),
      ('mine', 'g', 3, 'me', 'text', '{"text":"hi"}'),
      ('peer-text', 'g', 4, 'peer', 'text', '{"text":"yo"}'),
      ('peer-action', 'g', 5, NULL, 'system', '{"kind":"member-silenced","actorId":"peer"}'),
      ('created', 'g', 6, NULL, 'system', '{"kind":"group-created"}')`);
      const q = unreadCountsQuery(
        'me',
        [{ conversationID: 'g', lastReadHeight: 0 }],
        [NO_WINDOW],
      );
      const { rows } = await s.db.query<{
        conversationID: string;
        count: string;
      }>(q.text, q.values);
      expect(rows.map((r) => [r.conversationID, Number(r.count)])).toEqual([
        ['g', 3],
      ]);
    });
  },
);

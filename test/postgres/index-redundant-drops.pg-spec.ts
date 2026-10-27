import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 20261026000400 ~ 0414:删 15 个冗余索引。每个都是另一个非部分 btree 索引的严格前缀
 * (或与唯一键完全相同),只增加写入成本。
 *
 * 最小表按线上定义建出「被删的」和「覆盖它的」两组索引,再逐条执行迁移,断言:
 * - 被删的都不在了,覆盖索引都还在;
 * - 按原来那几列等值查询(含外键级联删除走的那一列),规划器改走覆盖索引。
 */
type Redundant = {
  migration: string;
  table: string;
  dropped: string;
  covering: string[];
  probe: string[];
};

const REDUNDANT: Redundant[] = [
  {
    migration: '20261026000400_drop_block_blocker_idx',
    table: 'Block',
    dropped: 'Block_blockerID_idx',
    covering: ['Block_blockerID_blockedID_key'],
    probe: ['blockerID'],
  },
  {
    migration: '20261026000401_drop_chat_message_reaction_message_idx',
    table: 'ChatMessageReaction',
    dropped: 'ChatMessageReaction_messageID_idx',
    covering: ['ChatMessageReaction_messageID_userID_emoji_key'],
    probe: ['messageID'],
  },
  {
    migration: '20261026000402_drop_circle_member_circle_idx',
    table: 'CircleMember',
    dropped: 'CircleMember_circleID_idx',
    covering: ['CircleMember_circleID_status_userID_idx'],
    probe: ['circleID'],
  },
  {
    migration: '20261026000403_drop_circle_post_report_post_idx',
    table: 'CirclePostReport',
    dropped: 'CirclePostReport_postID_idx',
    covering: ['CirclePostReport_postID_reporterID_idx'],
    probe: ['postID'],
  },
  {
    migration: '20261026000404_drop_circle_post_signup_post_idx',
    table: 'CirclePostSignup',
    dropped: 'CirclePostSignup_postID_idx',
    covering: [
      'CirclePostSignup_postID_userID_key',
      'CirclePostSignup_postID_seenByAuthor_idx',
    ],
    probe: ['postID'],
  },
  {
    migration: '20261026000405_drop_collaboration_recognition_post_idx',
    table: 'CollaborationRecognition',
    dropped: 'CollaborationRecognition_circlePostID_idx',
    covering: ['CollaborationRecognition_circlePostID_recipientID_key'],
    probe: ['circlePostID'],
  },
  {
    migration: '20261026000406_drop_conversation_group_owner_idx',
    table: 'ConversationGroup',
    dropped: 'ConversationGroup_ownerID_idx',
    covering: ['ConversationGroup_ownerID_name_key'],
    probe: ['ownerID'],
  },
  {
    migration: '20261026000407_drop_device_push_token_user_idx',
    table: 'DevicePushToken',
    dropped: 'DevicePushToken_userID_idx',
    covering: ['DevicePushToken_userID_deviceKey_idx'],
    probe: ['userID'],
  },
  {
    migration: '20261026000408_drop_friend_activity_request_idx',
    table: 'FriendActivity',
    dropped: 'FriendActivity_requestId_idx',
    covering: ['FriendActivity_requestId_viewerId_type_key'],
    probe: ['requestId'],
  },
  {
    migration: '20261026000409_drop_friend_tag_owner_idx',
    table: 'FriendTag',
    dropped: 'FriendTag_ownerID_idx',
    covering: ['FriendTag_ownerID_name_key'],
    probe: ['ownerID'],
  },
  {
    migration: '20261026000410_drop_pending_friend_tag_owner_request_idx',
    table: 'PendingFriendTagOnRequest',
    dropped: 'PendingFriendTagOnRequest_ownerID_requestID_idx',
    covering: ['PendingFriendTagOnRequest_ownerID_requestID_tagID_key'],
    probe: ['ownerID', 'requestID'],
  },
  {
    migration: '20261026000411_drop_refresh_token_user_idx',
    table: 'RefreshToken',
    dropped: 'RefreshToken_userId_idx',
    covering: [
      'RefreshToken_userId_familyId_idx',
      'RefreshToken_userId_audience_createdAt_idx',
      'RefreshToken_userId_deviceKey_idx',
    ],
    probe: ['userId'],
  },
  {
    migration: '20261026000412_drop_user_privacy_setting_user_idx',
    table: 'UserPrivacySetting',
    dropped: 'UserPrivacySetting_userID_idx',
    covering: ['UserPrivacySetting_userID_key'],
    probe: ['userID'],
  },
  {
    migration: '20261026000413_drop_user_trace_preference_user_idx',
    table: 'UserTracePreference',
    dropped: 'UserTracePreference_userID_idx',
    covering: ['UserTracePreference_userID_traceID_key'],
    probe: ['userID'],
  },
  {
    migration: '20261026000414_drop_session_scope_generation_user_idx',
    table: 'SessionScopeGeneration',
    dropped: 'SessionScopeGeneration_userId_idx',
    covering: ['SessionScopeGeneration_userId_scope_scopeKey_key'],
    probe: ['userId'],
  },
];

// 线上的索引定义(0_init 与各自的迁移),只保留索引涉及的列。
const SETUP = `
  CREATE TABLE "Block" (id text PRIMARY KEY, "blockerID" text NOT NULL, "blockedID" text NOT NULL);
  CREATE INDEX "Block_blockerID_idx" ON "Block"("blockerID");
  CREATE INDEX "Block_blockedID_idx" ON "Block"("blockedID");
  CREATE UNIQUE INDEX "Block_blockerID_blockedID_key" ON "Block"("blockerID", "blockedID");

  CREATE TABLE "ChatMessageReaction" (id text PRIMARY KEY, "messageID" text NOT NULL, "userID" text NOT NULL, emoji varchar(16) NOT NULL);
  CREATE UNIQUE INDEX "ChatMessageReaction_messageID_userID_emoji_key" ON "ChatMessageReaction"("messageID", "userID", emoji);
  CREATE INDEX "ChatMessageReaction_messageID_idx" ON "ChatMessageReaction"("messageID");

  CREATE TABLE "CircleMember" (id text PRIMARY KEY, "circleID" text NOT NULL, status text NOT NULL, "userID" text NOT NULL);
  CREATE INDEX "CircleMember_circleID_idx" ON "CircleMember"("circleID");
  CREATE INDEX "CircleMember_circleID_status_userID_idx" ON "CircleMember"("circleID", status, "userID");

  CREATE TABLE "CirclePostReport" (id text PRIMARY KEY, "postID" text NOT NULL, "reporterID" text NOT NULL, status text NOT NULL);
  CREATE INDEX "CirclePostReport_postID_reporterID_idx" ON "CirclePostReport"("postID", "reporterID");
  CREATE UNIQUE INDEX "CirclePostReport_pending_unique" ON "CirclePostReport"("postID", "reporterID") WHERE status = 'PENDING';
  CREATE INDEX "CirclePostReport_postID_idx" ON "CirclePostReport"("postID");

  CREATE TABLE "CirclePostSignup" (id text PRIMARY KEY, "postID" text NOT NULL, "userID" text NOT NULL, "seenByAuthor" boolean NOT NULL DEFAULT false);
  CREATE INDEX "CirclePostSignup_postID_idx" ON "CirclePostSignup"("postID");
  CREATE INDEX "CirclePostSignup_postID_seenByAuthor_idx" ON "CirclePostSignup"("postID", "seenByAuthor");
  CREATE UNIQUE INDEX "CirclePostSignup_postID_userID_key" ON "CirclePostSignup"("postID", "userID");

  CREATE TABLE "CollaborationRecognition" (id text PRIMARY KEY, "circlePostID" text, "recipientID" text NOT NULL);
  CREATE INDEX "CollaborationRecognition_circlePostID_idx" ON "CollaborationRecognition"("circlePostID");
  CREATE UNIQUE INDEX "CollaborationRecognition_circlePostID_recipientID_key" ON "CollaborationRecognition"("circlePostID", "recipientID");

  CREATE TABLE "ConversationGroup" (id text PRIMARY KEY, "ownerID" text NOT NULL, name text NOT NULL);
  CREATE INDEX "ConversationGroup_ownerID_idx" ON "ConversationGroup"("ownerID");
  CREATE UNIQUE INDEX "ConversationGroup_ownerID_name_key" ON "ConversationGroup"("ownerID", name);

  CREATE TABLE "DevicePushToken" (id text PRIMARY KEY, "userID" text NOT NULL, "deviceKey" text);
  CREATE INDEX "DevicePushToken_userID_idx" ON "DevicePushToken"("userID");
  CREATE INDEX "DevicePushToken_userID_deviceKey_idx" ON "DevicePushToken"("userID", "deviceKey");

  CREATE TABLE "FriendActivity" (id text PRIMARY KEY, "requestId" text NOT NULL, "viewerId" text NOT NULL, type text NOT NULL);
  CREATE INDEX "FriendActivity_requestId_idx" ON "FriendActivity"("requestId");
  CREATE UNIQUE INDEX "FriendActivity_requestId_viewerId_type_key" ON "FriendActivity"("requestId", "viewerId", type);

  CREATE TABLE "FriendTag" (id text PRIMARY KEY, "ownerID" text NOT NULL, name text NOT NULL);
  CREATE INDEX "FriendTag_ownerID_idx" ON "FriendTag"("ownerID");
  CREATE UNIQUE INDEX "FriendTag_ownerID_name_key" ON "FriendTag"("ownerID", name);

  CREATE TABLE "PendingFriendTagOnRequest" (id text PRIMARY KEY, "ownerID" text NOT NULL, "requestID" text NOT NULL, "tagID" text NOT NULL);
  CREATE INDEX "PendingFriendTagOnRequest_ownerID_requestID_idx" ON "PendingFriendTagOnRequest"("ownerID", "requestID");
  CREATE UNIQUE INDEX "PendingFriendTagOnRequest_ownerID_requestID_tagID_key" ON "PendingFriendTagOnRequest"("ownerID", "requestID", "tagID");

  CREATE TABLE "RefreshToken" (id text PRIMARY KEY, "userId" text NOT NULL, "familyId" text NOT NULL, audience text NOT NULL, "createdAt" timestamp NOT NULL DEFAULT now(), "deviceKey" text);
  CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");
  CREATE INDEX "RefreshToken_userId_familyId_idx" ON "RefreshToken"("userId", "familyId");
  CREATE INDEX "RefreshToken_userId_audience_createdAt_idx" ON "RefreshToken"("userId", audience, "createdAt");
  CREATE INDEX "RefreshToken_userId_deviceKey_idx" ON "RefreshToken"("userId", "deviceKey");

  CREATE TABLE "UserPrivacySetting" (id text PRIMARY KEY, "userID" text NOT NULL);
  CREATE UNIQUE INDEX "UserPrivacySetting_userID_key" ON "UserPrivacySetting"("userID");
  CREATE INDEX "UserPrivacySetting_userID_idx" ON "UserPrivacySetting"("userID");

  CREATE TABLE "UserTracePreference" (id text PRIMARY KEY, "userID" text NOT NULL, "traceID" text NOT NULL);
  CREATE INDEX "UserTracePreference_userID_idx" ON "UserTracePreference"("userID");
  CREATE UNIQUE INDEX "UserTracePreference_userID_traceID_key" ON "UserTracePreference"("userID", "traceID");

  CREATE TABLE "SessionScopeGeneration" (id text PRIMARY KEY, "userId" text NOT NULL, scope text NOT NULL, "scopeKey" text NOT NULL);
  CREATE UNIQUE INDEX "SessionScopeGeneration_userId_scope_scopeKey_key" ON "SessionScopeGeneration"("userId", scope, "scopeKey");
  CREATE INDEX "SessionScopeGeneration_userId_idx" ON "SessionScopeGeneration"("userId");
`;

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describePostgres('redundant index drops (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const indexNames = async (table: string) => {
    const { rows } = await s.db.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
      [s.schema, table],
    );
    return rows.map((row) => row.indexname);
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('redundant_idx');
    await s.db.query(SETUP);
    // CONCURRENTLY 不能进多语句的隐式事务:逐条执行,和 Prisma 部署时一样。
    for (const { migration } of REDUNDANT) {
      const sql = readFileSync(
        join(process.cwd(), 'prisma/migrations', migration, 'migration.sql'),
        'utf8',
      );
      for (const statement of statements(sql)) {
        await s.db.query(statement);
      }
    }
  });

  afterAll(async () => {
    await s?.close();
  });

  it('puts exactly one DROP INDEX CONCURRENTLY per migration', () => {
    for (const { migration, dropped } of REDUNDANT) {
      const sql = readFileSync(
        join(process.cwd(), 'prisma/migrations', migration, 'migration.sql'),
        'utf8',
      );
      expect(statements(sql)).toEqual([
        `DROP INDEX CONCURRENTLY IF EXISTS "${dropped}"`,
      ]);
    }
  });

  it.each(REDUNDANT)(
    'drops $dropped and keeps its covering index',
    async ({ table, dropped, covering }) => {
      const names = await indexNames(table);
      expect(names).not.toContain(dropped);
      for (const name of covering) expect(names).toContain(name);
    },
  );

  it.each(REDUNDANT)(
    'serves equality on the old columns of $dropped from a covering index',
    async ({ table, covering, probe }) => {
      const where = probe
        .map((column, index) => `"${column}" = $${index + 1}`)
        .join(' AND ');
      await s.db.query('BEGIN');
      try {
        await s.db.query('SET LOCAL enable_seqscan = off');
        const plan = await explainPlan(
          s.db,
          `SELECT id FROM "${table}" WHERE ${where}`,
          probe.map((_, index) => `v${index}`),
        );
        expect(covering.some((name) => plan.includes(name))).toBe(true);
      } finally {
        await s.db.query('ROLLBACK');
      }
    },
  );
});

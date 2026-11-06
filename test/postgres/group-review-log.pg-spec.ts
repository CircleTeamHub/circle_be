import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GroupReviewService } from 'src/circle-invitation/group-review.service';
import { ChatGroupEventService } from 'src/chat/chat-group-event.service';
import {
  describePostgres,
  openIsolatedSchema,
  type IsolatedSchema,
} from './pg-test-db';

describePostgres('manager review and important group log queries', () => {
  let s: IsolatedSchema;
  let reviews: GroupReviewService;
  let logs: ChatGroupEventService;
  beforeAll(async () => {
    s = await openIsolatedSchema('group_review_log');
    await s.db.query(`
      CREATE TABLE "User" (id text PRIMARY KEY, nickname text, "accountId" text, "avatarUrl" text);
      CREATE TABLE "ChatConversation" (id text PRIMARY KEY);
      CREATE TABLE "ChatMember" ("conversationID" text, "userID" text, "leftAt" timestamp, alias text);
      CREATE TABLE "CircleMember" ("circleID" text, "userID" text, status text);
      CREATE TABLE "GroupAdmission" (
        id text PRIMARY KEY, "conversationID" text, "applicantID" text, "inviterID" text,
        kind text, status text, reason text, "expiresAt" timestamp,
        "createdAt" timestamp, "updatedAt" timestamp
      );
      CREATE TABLE "CircleInvitation" (
        id text PRIMARY KEY, "circleID" text, "applicantID" text, "inviterID" text,
        status text, "createdAt" timestamp, "updatedAt" timestamp
      );
      CREATE TABLE "ChatGroupEvent" (
        id text PRIMARY KEY, "conversationID" text, kind text, "actorID" text,
        "targetIDs" text[], payload jsonb, "createdAt" timestamp
      );
      INSERT INTO "ChatConversation" VALUES ('group'), ('other'), ('circle-group');
      INSERT INTO "User" VALUES
        ('alice', 'Alice', '123456', null), ('bob', 'Bob', '678901', null),
        ('owner', 'Owner', '111111', null), ('manager', 'Manager', '999999', null);
      INSERT INTO "ChatMember" VALUES ('group', 'bob', null, 'B'), ('group', 'alice', null, 'A');
      INSERT INTO "GroupAdmission" VALUES
        ('r1', 'group', 'alice', 'owner', 'INVITE', 'PENDING', '', '2099-01-01', '2026-11-03', '2026-11-03'),
        ('r2', 'group', 'bob', null, 'APPLICATION', 'JOINED', '', '2099-01-01', '2026-11-02', '2026-11-02'),
        ('foreign', 'other', 'alice', null, 'APPLICATION', 'PENDING', '', '2099-01-01', '2026-11-04', '2026-11-04');
      INSERT INTO "CircleMember" VALUES ('circle', 'alice', 'ACTIVE');
      INSERT INTO "CircleInvitation" VALUES ('circle-request', 'circle', 'alice', 'alice', 'APPROVED', '2026-11-01', '2026-11-02');
      INSERT INTO "ChatGroupEvent" VALUES
        ('log-review', 'group', 'member-joined', 'owner', ARRAY['alice'],
          '{"status":"JOINED","source":"INVITE","inviterId":"owner","operatorId":"manager"}', '2026-11-03'),
        ('log-routine', 'group', 'group-renamed', 'owner', ARRAY['alice'], '{}', '2026-11-04');
    `);
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261105233000_group_join_blacklist/migration.sql',
      ),
      'utf8',
    );
    for (const statement of migration
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean))
      await s.db.query(statement);
    const prisma: any = {
      chatConversation: {
        findUnique: async ({ where }: any) => ({
          id: where.id,
          type: 'GROUP',
          circleID: where.id === 'circle-group' ? 'circle' : null,
          ownerID: 'owner',
          name: 'Group',
        }),
      },
      circle: { findUnique: async () => ({ name: 'Circle', deleted: false }) },
      chatMember: {
        findUnique: async () => ({
          leftAt: null,
          role: 'ADMIN',
          conversation: { type: 'GROUP', circleID: null, ownerID: 'owner' },
        }),
        findMany: async () => [],
      },
      circleMember: {
        findUnique: async () => ({ status: 'ACTIVE', role: 'ADMIN' }),
      },
      groupAdmission: {
        findFirst: async ({ where }: any) =>
          (
            await s.db.query(
              'SELECT "createdAt" FROM "GroupAdmission" WHERE id=$1 AND "conversationID"=$2',
              [where.id, where.conversationID],
            )
          ).rows[0] ?? null,
      },
      user: {
        findMany: async ({ where }: any) =>
          (
            await s.db.query(
              'SELECT id, nickname, "avatarUrl" FROM "User" WHERE id=ANY($1::text[])',
              [where.id.in],
            )
          ).rows,
      },
      chatGroupEvent: {
        findMany: async ({ where }: any) =>
          (
            await s.db.query(
              'SELECT * FROM "ChatGroupEvent" WHERE id=ANY($1::text[]) ORDER BY "createdAt" DESC,id DESC',
              [where.id.in],
            )
          ).rows,
      },
      $queryRaw: async (query: { text: string; values: unknown[] }) =>
        (await s.db.query(query.text, query.values)).rows,
    };
    reviews = new GroupReviewService(prisma, {} as never, {} as never);
    logs = new ChatGroupEventService(prisma);
  });
  afterAll(async () => {
    await s?.close();
  });

  it('searches the full group history before applying a cursor page', async () => {
    const first = await reviews.list('owner', 'group', { limit: 1 });
    expect(first.items.map((row) => row.id)).toEqual(['r1']);
    const second = await reviews.list('owner', 'group', {
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((row) => row.id)).toEqual(['r2']);
    const search = await reviews.list('owner', 'group', {
      keyword: '678901',
      limit: 1,
    });
    expect(search.items.map((row) => row.id)).toEqual(['r2']);
    expect(
      (await reviews.list('owner', 'group', { keyword: '%' })).items,
    ).toEqual([]);
    expect(
      (await reviews.list('owner', 'group', { keyword: 'aLiCe' })).items.map(
        (row) => row.id,
      ),
    ).toEqual(['r1']);
  });

  it('reflects the persistent group ban without leaking another group request', async () => {
    await s.db.query(
      'INSERT INTO "ChatGroupJoinBan" ("conversationID","userID","actorID") VALUES ($1,$2,$3)',
      ['group', 'alice', 'owner'],
    );
    const page = await reviews.list('owner', 'group', { keyword: '123456' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ id: 'r1', status: 'BLACKLISTED' });
  });

  it('preserves the source of historical self-applications and maps circle membership', async () => {
    const page = await reviews.list('owner', 'circle-group', {});
    expect(page.items[0]).toMatchObject({
      id: 'circle-request',
      source: 'APPLICATION',
      status: 'JOINED',
      inviter: null,
    });
  });

  it('searches actual target or operator identities and suppresses routine edits', async () => {
    const target = await logs.listEvents('owner', 'group', {
      keyword: '123456',
      person: 'target',
    });
    expect(target.events.map((row) => row.id)).toEqual(['log-review']);
    const operator = await logs.listEvents('owner', 'group', {
      keyword: '999999',
      person: 'actor',
    });
    expect(operator.events.map((row) => row.id)).toEqual(['log-review']);
    expect(operator.events[0].review?.operator?.id).toBe('manager');
    expect(
      (
        await logs.listEvents('owner', 'group', {
          keyword: '123456',
          person: 'actor',
        })
      ).events,
    ).toEqual([]);
  });
});

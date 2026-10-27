import { ChatService } from 'src/chat/chat.service';
import { GroupAdmissionService } from 'src/chat/group-admission.service';
import { describePostgres } from './pg-test-db';
import {
  type LiveSchema,
  openLiveSchema,
  seedUsers,
  transactionOf,
} from './live-prisma';

/**
 * 群邀请(GroupAdmissionService.invite)与建群(ChatService.createGroupConversation)
 * 的逐人循环改成批量(真 PrismaClient + 真 PostgreSQL)。
 *
 * 原来:邀请最多 100 人,每人座位读、过期清理、现有邀请读、建邀请、建投递 5-6 次
 * 往返,全程持有会话行 FOR UPDATE(事务默认 5 秒超时);建群最多 199 人,每人两次
 * INSERT,全程持有关系锁。现在先用 IN 批量预读,再 createMany。每个被邀请人的结果
 * (跳过 / 过期后重邀 / 新邀请,以及投递行)与原来逐人处理完全一致。
 */
// 建整套表(prisma migrate diff 生成的 DDL)在共享测试库上可能要好几秒。
jest.setTimeout(60_000);

const isAdvisory = (sql: string) => /pg_advisory_xact_lock/.test(sql);
const touches = (table: string) => (sql: string) => sql.includes(`"${table}"`);

describePostgres('group invite and create-group batching', () => {
  let live: LiveSchema;
  let admissions: GroupAdmissionService;
  let chat: ChatService;
  const invitees = Array.from(
    { length: 100 },
    (_, i) => `u${String(i).padStart(3, '0')}`,
  );

  beforeAll(async () => {
    live = await openLiveSchema('chat_group_invite');
    const resolved = () => jest.fn().mockResolvedValue(undefined);
    chat = new ChatService(
      live.prisma as never,
      { check: jest.fn().mockReturnValue({ blocked: false }) } as never,
      { ensureCircleConversation: resolved() } as never,
      { attachMediaUrls: resolved() } as never,
      { getSettingsForUsers: jest.fn().mockResolvedValue(new Map()) } as never,
      {
        joinUserToConversation: resolved(),
        emitConversationChange: resolved(),
      } as never,
      { emit: resolved() } as never,
      { isSupportAgent: jest.fn().mockResolvedValue(false) } as never,
      { lock: resolved() } as never,
      { record: resolved(), recordInTx: resolved() } as never,
    );
    // 建群返回值要拼会话 DTO(另一套读路径),这里只关心事务里的写。
    jest
      .spyOn(chat as never, 'buildConversationDto' as never)
      .mockResolvedValue({} as never);
    admissions = new GroupAdmissionService(
      live.prisma as never,
      {
        getGroupConversationForMember: jest.fn().mockResolvedValue({}),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(admissions, 'flush').mockResolvedValue(undefined as never);
  });

  afterAll(async () => {
    await live?.close();
  });

  beforeEach(async () => {
    await live.db.query(`
      TRUNCATE "User", "ChatConversation", "ChatMember", "GroupAdmission",
        "GroupAdmissionDelivery", "Friend", "AccountIdentifier" CASCADE;
    `);
    await seedUsers(live.db, ['owner', ...invitees]);
    await live.db.query(
      `INSERT INTO "Friend" (id, "userID", "friendID", state, "updatedAt")
       SELECT 'f-' || u, 'owner', u, 'ACCEPTED', now() FROM unnest($1::text[]) u`,
      [invitees],
    );
    live.statements.length = 0;
  });

  const admissionRows = async () =>
    (
      await live.db.query<{
        applicantID: string;
        status: string;
        inviterID: string;
        kind: string;
        deliveries: number;
      }>(
        `SELECT a."applicantID", a.status, a."inviterID", a.kind,
                (SELECT count(*)::int FROM "GroupAdmissionDelivery" d
                 WHERE d."admissionID" = a.id AND d."recipientID" = a."applicantID"
                   AND d."actorID" = 'owner' AND d.event = 'INVITED') AS deliveries
         FROM "GroupAdmission" a WHERE a."conversationID" <> 'elsewhere'
         ORDER BY a."applicantID", a.status`,
      )
    ).rows;

  describe('invite', () => {
    beforeEach(async () => {
      await live.db.query(`
        INSERT INTO "ChatConversation" (id, type, "ownerID", "updatedAt")
        VALUES ('grp', 'GROUP', 'owner', now());
        INSERT INTO "ChatMember" (id, "conversationID", "userID", role) VALUES
          ('seat-owner', 'grp', 'owner', 'MEMBER'),
          -- 在座:跳过
          ('seat-u000', 'grp', 'u000', 'MEMBER'),
          ('seat-u001', 'grp', 'u001', 'MEMBER');
        -- 离座:当作新人邀请
        INSERT INTO "ChatMember" (id, "conversationID", "userID", "leftAt") VALUES
          ('seat-u002', 'grp', 'u002', now());
        -- 有效邀请:跳过,原样保留
        INSERT INTO "GroupAdmission" (id, "conversationID", "applicantID", "inviterID", kind, status, "expiresAt", "updatedAt") VALUES
          ('live-u003', 'grp', 'u003', 'owner', 'INVITE', 'INVITED', now() + interval '1 day', now()),
          ('live-u004', 'grp', 'u004', 'owner', 'APPLICATION', 'PENDING', now() + interval '1 day', now()),
          -- 已过期但状态还是有效:先标 EXPIRED,再重新邀请
          ('stale-u005', 'grp', 'u005', 'owner', 'INVITE', 'INVITED', now() - interval '1 minute', now()),
          -- 别的群的邀请不受影响
          ('other-u006', 'elsewhere', 'u006', 'owner', 'INVITE', 'INVITED', now() - interval '1 minute', now());
      `);
      live.statements.length = 0;
    });

    it('produces the same per-invitee outcome as the one-by-one loop', async () => {
      await admissions.invite('owner', 'grp', invitees);

      const rows = await admissionRows();
      const byUser = new Map<string, typeof rows>();
      for (const row of rows) {
        byUser.set(row.applicantID, [
          ...(byUser.get(row.applicantID) ?? []),
          row,
        ]);
      }
      // 在座的两位:没有任何邀请。
      expect(byUser.has('u000')).toBe(false);
      expect(byUser.has('u001')).toBe(false);
      // 有效邀请原样保留,不新建、不补投递。
      expect(byUser.get('u003')).toEqual([
        expect.objectContaining({
          status: 'INVITED',
          kind: 'INVITE',
          deliveries: 0,
        }),
      ]);
      expect(byUser.get('u004')).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          kind: 'APPLICATION',
          deliveries: 0,
        }),
      ]);
      // 过期的先标 EXPIRED,再建一条新的 INVITED + 一条投递。
      expect(byUser.get('u005')).toEqual([
        expect.objectContaining({ status: 'EXPIRED', deliveries: 0 }),
        expect.objectContaining({
          status: 'INVITED',
          kind: 'INVITE',
          deliveries: 1,
        }),
      ]);
      // 别的群那条不动(仍是过期但 INVITED)。
      expect(
        (
          await live.db.query(
            `SELECT status FROM "GroupAdmission" WHERE id = 'other-u006'`,
          )
        ).rows[0].status,
      ).toBe('INVITED');
      // 其余(含离座的 u002 和 u006 在本群)各一条新邀请、一条投递。
      const fresh = invitees.filter(
        (u) => !['u000', 'u001', 'u003', 'u004', 'u005'].includes(u),
      );
      for (const u of fresh) {
        expect(byUser.get(u)).toEqual([
          expect.objectContaining({
            status: 'INVITED',
            kind: 'INVITE',
            inviterID: 'owner',
            deliveries: 1,
          }),
        ]);
      }
      const expiry = await live.db.query<{ ok: boolean }>(
        `SELECT bool_and("expiresAt" BETWEEN now() + interval '7 days' - interval '1 minute'
                                         AND now() + interval '7 days' + interval '1 minute') AS ok
         FROM "GroupAdmission" WHERE status = 'INVITED' AND id NOT IN ('live-u003', 'other-u006')`,
      );
      expect(expiry.rows[0].ok).toBe(true);
    });

    it('holds the group lock for a constant number of statements', async () => {
      await admissions.invite('owner', 'grp', invitees);

      const tx = transactionOf(live.statements, (sql) =>
        /FROM "ChatConversation"[\s\S]*FOR UPDATE/.test(sql),
      ).filter((s) => !['BEGIN', 'COMMIT'].includes(s.sql));
      const work = tx.filter((s) => !isAdvisory(s.sql));
      // 原来每位被邀请人 5-6 条(100 人 ≈ 500 条),现在与人数无关。
      expect(work.filter((s) => touches('GroupAdmission')(s.sql))).toHaveLength(
        3,
      );
      expect(
        work.filter((s) => touches('GroupAdmissionDelivery')(s.sql)),
      ).toHaveLength(1);
      expect(work.length).toBeLessThanOrEqual(13);
    });

    it('does nothing for a list of seated or already-invited users', async () => {
      await admissions.invite('owner', 'grp', ['u000', 'u003']);
      expect(
        (await live.db.query('SELECT count(*)::int AS n FROM "GroupAdmission"'))
          .rows[0].n,
      ).toBe(4);
      expect(
        (
          await live.db.query(
            'SELECT count(*)::int AS n FROM "GroupAdmissionDelivery"',
          )
        ).rows[0].n,
      ).toBe(0);
    });
  });

  describe('createGroupConversation', () => {
    it('invites every member with one admission and one delivery each, in constant statements', async () => {
      const members = invitees.slice(0, 60);
      await chat.createGroupConversation('owner', {
        name: '新群',
        memberIds: members,
      });

      const rows = await admissionRows();
      expect(rows).toHaveLength(60);
      expect(rows.map((row) => row.applicantID)).toEqual(members);
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'INVITED',
          kind: 'INVITE',
          inviterID: 'owner',
          deliveries: 1,
        });
      }
      const seats = await live.db.query(`SELECT "userID" FROM "ChatMember"`);
      expect(seats.rows).toEqual([{ userID: 'owner' }]);

      const tx = transactionOf(live.statements, (sql) =>
        /INSERT INTO "[^"]+"\."ChatConversation"/.test(sql),
      ).filter(
        (s) => !['BEGIN', 'COMMIT'].includes(s.sql) && !isAdvisory(s.sql),
      );
      // 原来每人两次 INSERT(60 人 120 条)。
      expect(tx.filter((s) => touches('GroupAdmission')(s.sql))).toHaveLength(
        1,
      );
      expect(
        tx.filter((s) => touches('GroupAdmissionDelivery')(s.sql)),
      ).toHaveLength(1);
    });
  });
});

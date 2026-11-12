import { ChatService } from 'src/chat/chat.service';
import { GroupAdmissionService } from 'src/chat/group-admission.service';
import { ChatGroupEventService } from 'src/chat/chat-group-event.service';
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
 * Since the group direct-join rule, invitees that keep the group within 30
 * members are seated in the same batch instead of being invited.
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
    const groupEvents = new ChatGroupEventService(live.prisma as never);
    jest.spyOn(groupEvents, 'record').mockResolvedValue(undefined);
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
      groupEvents,
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

  // deliveries = the applicant's own job for the admission's status
  // (INVITED card or JOINED notice) sent on the owner's behalf.
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
                   AND d."actorID" = 'owner' AND d.event = a.status) AS deliveries
         FROM "GroupAdmission" a WHERE a."conversationID" <> 'elsewhere'
         ORDER BY a."applicantID", a.status`,
      )
    ).rows;
  const activeSeats = async () =>
    (
      await live.db.query<{ userID: string }>(
        `SELECT "userID" FROM "ChatMember" WHERE "leftAt" IS NULL ORDER BY "userID"`,
      )
    ).rows.map((row) => row.userID);

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

    it('seats fresh invitees up to 30 members and invites the rest, per invitee', async () => {
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
      // 过期的先标 EXPIRED,再建一条新记录 + 一条投递(u005 排在前 27 位,直接入群)。
      expect(byUser.get('u005')).toEqual([
        expect.objectContaining({ status: 'EXPIRED', deliveries: 0 }),
        expect.objectContaining({
          status: 'JOINED',
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
      // 其余(含离座的 u002 和 u006 在本群)各一条新记录、一条投递。The group
      // had 3 members, so the first 27 fresh invitees in request order join
      // directly (u002, u005, u006..u030) and everyone after them is invited.
      const fresh = invitees.filter(
        (u) => !['u000', 'u001', 'u003', 'u004'].includes(u),
      );
      const joined = fresh.slice(0, 27);
      expect(joined[joined.length - 1]).toBe('u030');
      for (const u of fresh.filter((id) => id !== 'u005')) {
        expect(byUser.get(u)).toEqual([
          expect.objectContaining({
            status: joined.includes(u) ? 'JOINED' : 'INVITED',
            kind: 'INVITE',
            inviterID: 'owner',
            deliveries: 1,
          }),
        ]);
      }
      // The departed u002 reuses its seat row; the group now holds exactly 30.
      expect(await activeSeats()).toEqual(
        ['owner', 'u000', 'u001', ...joined].sort((a, b) => a.localeCompare(b)),
      );
      expect(
        (
          await live.prisma.chatGroupEvent.findMany({
            select: { kind: true, actorID: true, targetIDs: true },
          })
        ).map((event) => ({ ...event, targetIDs: [...event.targetIDs] })),
      ).toEqual([
        { kind: 'member-joined', actorID: 'owner', targetIDs: joined },
      ]);
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
      // Direct joins reopen departed seats and insert the new ones in one go each.
      expect(
        work.filter((s) =>
          /(INSERT INTO|UPDATE) "[^"]+"\."ChatMember"/.test(s.sql),
        ),
      ).toHaveLength(2);
      // 13 for invitations, plus member count, inviter role, history floor,
      // the two seat writes and the join log.
      expect(work.length).toBeLessThanOrEqual(19);
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
    it('seats the first 29 picks, then only opted-in friends, with matching admission, delivery, and audit rows', async () => {
      // Owner + u000..u028 make 30. Past that, u030 opted into direct joining
      // and is seated; u029 declined it and is invited.
      const members = invitees.slice(0, 31);
      await live.prisma.userPrivacySetting.createMany({
        data: [
          { userID: 'u029', allowFriendGroupDirectJoin: false },
          { userID: 'u030', allowFriendGroupDirectJoin: true },
        ],
      });
      const direct = members.filter((id) => id !== 'u029');
      await chat.createGroupConversation('owner', {
        name: '新群',
        memberIds: members,
      });
      expect(await activeSeats()).toEqual(['owner', ...direct]);
      const admissions = await live.prisma.groupAdmission.findMany({
        orderBy: { applicantID: 'asc' },
        include: { deliveries: true },
      });
      expect(
        admissions.map((a) => ({
          applicantID: a.applicantID,
          status: a.status,
          events: a.deliveries.map((d) => d.event),
        })),
      ).toEqual(
        members.map((applicantID) => {
          const status = direct.includes(applicantID) ? 'JOINED' : 'INVITED';
          return { applicantID, status, events: [status] };
        }),
      );
      const invited = admissions.find((a) => a.applicantID === 'u029')!;
      expect(admissions[0].acceptedAt).toBeInstanceOf(Date);
      expect(admissions[0].decidedByID).toBe('owner');
      expect(invited.acceptedAt).toBeNull();
      expect(
        (
          await live.prisma.chatGroupEvent.findMany({
            select: { kind: true, actorID: true, targetIDs: true },
          })
        ).map((event) => ({ ...event, targetIDs: [...event.targetIDs] })),
      ).toEqual([
        { kind: 'member-joined', actorID: 'owner', targetIDs: direct },
      ]);
    });

    it('rolls back seats, admissions, and logs when joined delivery insertion fails', async () => {
      const members = invitees.slice(0, 2);
      await live.db.query(
        'ALTER TABLE "GroupAdmissionDelivery" ADD CONSTRAINT "deny_joined_delivery" CHECK (event <> \'JOINED\')',
      );
      try {
        await expect(
          chat.createGroupConversation('owner', {
            name: '新群',
            memberIds: members,
          }),
        ).rejects.toThrow();
        expect(await live.prisma.chatConversation.count()).toBe(0);
        expect(await live.prisma.chatMember.count()).toBe(0);
        expect(await live.prisma.groupAdmission.count()).toBe(0);
        expect(await live.prisma.groupAdmissionDelivery.count()).toBe(0);
        expect(await live.prisma.chatGroupEvent.count()).toBe(0);
      } finally {
        await live.db.query(
          'ALTER TABLE "GroupAdmissionDelivery" DROP CONSTRAINT "deny_joined_delivery"',
        );
      }
    });

    it('writes one admission and one delivery per member, in constant statements', async () => {
      const members = invitees.slice(0, 60);
      await chat.createGroupConversation('owner', {
        name: '新群',
        memberIds: members,
      });

      const rows = await admissionRows();
      expect(rows).toHaveLength(60);
      expect(rows.map((row) => row.applicantID)).toEqual(members);
      // The first 29 picks fill the group to 30; nobody here opted in past it.
      rows.forEach((row, index) => {
        expect(row).toMatchObject({
          status: index < 29 ? 'JOINED' : 'INVITED',
          kind: 'INVITE',
          inviterID: 'owner',
          deliveries: 1,
        });
      });
      expect(await activeSeats()).toEqual(['owner', ...members.slice(0, 29)]);

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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Client } from 'pg';
import { ChatCircleSyncService } from 'src/chat/chat-circle-sync.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import {
  CircleInvitationErrorCode,
  CircleErrorCode,
} from 'src/common/app-error-codes';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipProgramService } from 'src/membership/membership-program.service';
import { NotificationService } from 'src/notification/notification.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { withDatabaseWorkBudget } from 'src/utils/database-work-budget';
import { lockUserRelationshipState } from 'src/utils/user-relationship-lock';
import {
  type CircleTxDb,
  createCircle,
  createUsers,
  openCircleTxDb,
  backendPid,
  sleep,
  transactionEntriesOf,
  transactionsOf,
  waitUntilBlockedBy,
} from './circle-tx-harness';
import { describePostgres } from './pg-test-db';

const claimMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20261026000700_circle_invitation_consent_claim/migration.sql',
  ),
  'utf8',
);

/**
 * 圈子邀请两条长事务的真库回归(CircleInvitationService)。
 *
 * 1. 群邀请批量接口(inviteBatch,最多 100 人)是一个 Serializable 事务、整批原子:
 *    任一目标失败整批回滚。原子语义不变,只把事务缩短 —— 事务外的好友/隐私预检
 *    改成事务前一次 IN 查完(原来每个目标在持锁事务里另借一个池连接查),每个目标
 *    的 DTO 回读整个去掉(批量接口不返回它)。
 * 2. 同意制邀请投递(deliverConsentInvitation):事务里只校验 + 认领,站内通知、
 *    私聊会话、邀请卡片挪到提交之后;失败交给每分钟补投,重试靠既有幂等键去重。
 */
describePostgres('circle invitation transactions (PostgreSQL)', () => {
  let t: CircleTxDb;
  let observer: Client;
  let membership: MembershipPolicyService;
  let memberLock: CircleMemberLockService;
  let admission: CircleAdmissionPolicy;
  let privacy: PrivacySettingsService;
  let notifications: NotificationService;
  let chatMessages: ChatSystemMessageService;

  const realtime = {
    broadcastCircleInvitationReviewed: () => undefined,
    broadcastInteractionUnread: async () => undefined,
    broadcastNotificationCreated: () => undefined,
  };
  const chatCircleSync = {
    syncCircleSeatsCoalesced: async () => null,
    scheduleRetry: () => undefined,
  };
  /** 私聊会话:按 directKey 建/取一行真会话,给邀请卡片落库用。 */
  const chatService = {
    getOrCreateDirectConversation: async (a: string, b: string) => {
      const directKey = a < b ? `${a}:${b}` : `${b}:${a}`;
      const existing = await t.prisma.chatConversation.findUnique({
        where: { directKey },
        select: { id: true },
      });
      if (existing) return existing;
      return t.prisma.chatConversation.create({
        data: {
          type: 'DIRECT',
          directKey,
          members: { create: [{ userID: a }, { userID: b }] },
        },
        select: { id: true },
      });
    },
  };

  const build = (overrides: Partial<Record<string, unknown>> = {}) =>
    new CircleInvitationService(
      t.prisma as never,
      realtime as never,
      privacy,
      (overrides.notifications ?? notifications) as never,
      admission,
      memberLock,
      chatCircleSync as never,
      (overrides.chatService ?? chatService) as never,
      (overrides.chatMessages ?? chatMessages) as never,
    );

  const invitationsOf = (circleId: string) =>
    t.prisma.circleInvitation.findMany({
      where: { circleID: circleId },
      select: {
        applicantID: true,
        status: true,
        approvedCount: true,
        requiredCount: true,
        consentNoticeRequired: true,
        verifiers: { select: { verifierID: true, status: true } },
      },
    });

  const befriend = (a: string, b: string) =>
    t.prisma.friend.create({
      data: { userID: a, friendID: b, state: 'ACCEPTED' },
    });
  const setInvitePermission = (userID: string, value: string) =>
    t.prisma.userPrivacySetting.create({
      data: { userID, groupInvitePermission: value },
    });

  beforeAll(async () => {
    t = await openCircleTxDb('circle_tx_invitation', {
      extraSql: [claimMigration],
      poolMax: 12,
    });
    observer = await t.rawClient();
    membership = new MembershipPolicyService(
      t.prisma as never,
      new MembershipProgramService(t.prisma as never),
    );
    memberLock = new CircleMemberLockService(membership);
    admission = new CircleAdmissionPolicy(membership, memberLock);
    privacy = new PrivacySettingsService(
      t.prisma as never,
      {} as never,
      {} as never,
    );
    notifications = new NotificationService(
      t.prisma as never,
      realtime as never,
    );
    chatMessages = new ChatSystemMessageService(
      t.prisma as never,
      { emitMessage: async () => undefined } as never,
      { onMessageBroadcast: async () => undefined } as never,
      { attachMediaUrls: async () => undefined } as never,
    );
  }, 60_000);

  afterAll(async () => {
    await observer?.end();
    await t?.close();
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  describe('inviteBatch', () => {
    it('invites 100 people inside the default transaction timeout while holding one pool connection at a time', async () => {
      const [owner, ...targets] = await createUsers(t.prisma, 101);
      const circleId = await createCircle(t.prisma, owner, [], {
        requiredVerifierCount: 3,
      });
      const service = build();
      const delivered: string[] = [];
      jest
        .spyOn(service as never, 'deliverConsentInvitation')
        .mockImplementation((async (id: string) => {
          delivered.push(id);
        }) as never);

      t.resetPeak();
      t.setRecording(true);
      const started = Date.now();
      await service.inviteBatch(owner, [...targets, targets[0]], circleId);
      const elapsed = Date.now() - started;
      t.setRecording(false);

      // Prisma 交互事务默认 5s 超时,批量事务没有放宽它。
      expect(elapsed).toBeLessThan(5000);
      // 整批只占一个池连接:预检在事务之前一次查完,事务里不再另借连接。
      expect(t.peakConnections()).toBe(1);
      const [batch] = transactionsOf(t.statements).filter((tx) =>
        tx.some(
          (sql) =>
            sql.includes('INSERT INTO') && sql.includes('"CircleInvitation"'),
        ),
      );
      expect(
        batch.filter(
          (sql) =>
            sql.includes('INSERT INTO') && sql.includes('"CircleInvitation"'),
        ),
      ).toHaveLength(100);
      // 事务里不再逐个回读邀请 DTO(批量接口返回 void)。
      expect(
        batch.some((sql) =>
          /^SELECT[\s\S]*FROM "[^"]+"\."CircleInvitationVerifier"/.test(sql),
        ),
      ).toBe(false);

      const rows = await invitationsOf(circleId);
      expect(rows).toHaveLength(100);
      for (const row of rows) {
        expect(row).toEqual({
          applicantID: expect.any(String),
          status: 'INVITED',
          approvedCount: 1,
          requiredCount: 3,
          consentNoticeRequired: true,
          verifiers: [{ verifierID: owner, status: 'APPROVED' }],
        });
      }
      // 每个目标一次同意制投递,重复的 id 只算一次。
      expect(delivered).toHaveLength(100);
      expect(new Set(delivered).size).toBe(100);
    });

    it('keeps the per-target outcome: friendship decides the vouch, pending invitations are reused', async () => {
      const [owner, inviter, friend, stranger, alreadyInvited] =
        await createUsers(t.prisma, 5);
      const circleId = await createCircle(t.prisma, owner, [inviter], {
        requiredVerifierCount: 2,
      });
      await befriend(friend, inviter);
      await setInvitePermission(friend, 'FRIENDS_ONLY');
      const service = build();
      jest
        .spyOn(service as never, 'deliverConsentInvitation')
        .mockImplementation((async () => undefined) as never);
      await service.inviteBatch(owner, [alreadyInvited], circleId);
      const before = await invitationsOf(circleId);

      await service.inviteBatch(
        inviter,
        [friend, stranger, alreadyInvited],
        circleId,
      );

      const rows = new Map(
        (await invitationsOf(circleId)).map((row) => [row.applicantID, row]),
      );
      expect(rows.get(friend)).toEqual({
        applicantID: friend,
        status: 'INVITED',
        approvedCount: 1,
        requiredCount: 2,
        consentNoticeRequired: true,
        verifiers: [{ verifierID: inviter, status: 'APPROVED' }],
      });
      expect(rows.get(stranger)).toEqual({
        applicantID: stranger,
        status: 'INVITED',
        approvedCount: 0,
        requiredCount: 2,
        consentNoticeRequired: true,
        verifiers: [],
      });
      // 已有在途邀请:原样复用,不改、不加第二张。
      expect(rows.get(alreadyInvited)).toEqual(before[0]);
      expect(rows.size).toBe(3);
    });

    it.each([
      [
        'an existing member sorts first',
        'member',
        CircleErrorCode.AlreadyMember,
      ],
      [
        'a privacy refusal sorts first',
        'refuses',
        CircleInvitationErrorCode.NotAllowed,
      ],
    ])(
      'rolls the whole batch back with the error of the first failing target when %s',
      async (_label, firstKind, errorCode) => {
        const users = await createUsers(t.prisma, 6);
        const [owner, ...rest] = users;
        // 按 id 排序决定处理顺序(与 inviteBatch 一致),把两种失败放在第 2、4 位。
        // eslint-disable-next-line sonarjs/no-alphabetical-sort -- 与 inviteBatch 同为码位序
        const sorted = [...rest].sort();
        const [a, b, c, d, e] = sorted;
        const member = firstKind === 'member' ? b : d;
        const refuses = firstKind === 'member' ? d : b;
        const circleId = await createCircle(t.prisma, owner, [member]);
        await setInvitePermission(refuses, 'NONE');
        const service = build();
        jest
          .spyOn(service as never, 'deliverConsentInvitation')
          .mockImplementation((async () => undefined) as never);

        await expect(
          service.inviteBatch(owner, [e, d, c, b, a], circleId),
        ).rejects.toMatchObject({ response: { errorCode } });
        // 整批原子:排在失败者前面的 a 也没有留下邀请。
        expect(await invitationsOf(circleId)).toEqual([]);
      },
    );
  });

  describe('consent delivery', () => {
    const pendingInvitation = async () => {
      const [owner, applicant] = await createUsers(t.prisma, 2);
      const circleId = await createCircle(t.prisma, owner);
      const service = build();
      const spy = jest
        .spyOn(service as never, 'deliverConsentInvitation')
        .mockImplementation((async () => undefined) as never);
      await service.inviteBatch(owner, [applicant], circleId);
      spy.mockRestore();
      const invitation = await t.prisma.circleInvitation.findFirstOrThrow({
        where: { circleID: circleId, applicantID: applicant },
        select: { id: true },
      });
      return { owner, applicant, circleId, id: invitation.id, service };
    };
    const deliver = (service: CircleInvitationService, id: string) =>
      (
        service as unknown as {
          deliverConsentInvitation: (id: string) => Promise<void>;
        }
      ).deliverConsentInvitation(id);
    const consentState = async (id: string) =>
      (
        await observer.query<{
          delivered: boolean;
          claimed: boolean;
          attempts: number;
          status: string;
        }>(
          `SELECT "consentNoticeDeliveredAt" IS NOT NULL AS delivered,
                  "consentNoticeClaimedAt" IS NOT NULL AS claimed,
                  "consentNoticeAttempts" AS attempts, status::text AS status
           FROM "CircleInvitation" WHERE id = $1`,
          [id],
        )
      ).rows[0];
    const cards = (id: string) =>
      t.prisma.chatMessage.count({
        where: { clientMessageId: `circle_invitation_${id}` },
      });
    const notices = (id: string) =>
      t.prisma.notification.count({ where: { id } });
    const pushes = (id: string) =>
      t.prisma.notificationPushOutbox.count({ where: { notificationID: id } });

    it('does the notice/chat IO after commit with no connection, transaction or lock held', async () => {
      const { id } = await pendingInvitation();
      const duringIo: Array<{
        active: number;
        claimed: boolean;
        advisory: number;
      }> = [];
      const probe = async () => {
        const { rows } = await observer.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE l.locktype = 'advisory' AND a.pid <> pg_backend_pid()
             AND a.datname = current_database()`,
        );
        duringIo.push({
          active: t.activeConnections(),
          claimed: (await consentState(id)).claimed,
          advisory: rows[0].n,
        });
      };
      const realDeliver =
        notifications.deliverCircleConsentNotification.bind(notifications);
      const realInsert = chatMessages.insertServerMessage.bind(chatMessages);
      const traced = build({
        notifications: {
          deliverCircleConsentNotification: async (...args: never[]) => {
            await probe();
            return (realDeliver as (...a: never[]) => unknown)(...args);
          },
        },
        chatMessages: {
          insertServerMessage: async (...args: never[]) => {
            await probe();
            return (realInsert as (...a: never[]) => unknown)(...args);
          },
        },
      });

      await deliver(traced, id);

      // IO 期间:本服务不占池连接(没有开着的投递事务)、库里没有任何 advisory 锁,
      // 邀请处于「已认领」状态。
      expect(duringIo).toEqual([
        { active: 0, claimed: true, advisory: 0 },
        { active: 0, claimed: true, advisory: 0 },
      ]);
      expect(await consentState(id)).toMatchObject({
        delivered: true,
        claimed: false,
      });
      expect(await notices(id)).toBe(1);
      expect(await pushes(id)).toBe(1);
      expect(await cards(id)).toBe(1);
    });

    it('leaves a failed delivery to the cron, and the retry duplicates neither the notice, the push nor the card', async () => {
      const { id } = await pendingInvitation();
      // 补投按批次扫全表:别的用例留下的待投递邀请不能挤掉这一条。
      await t.prisma.circleInvitation.updateMany({
        where: { id: { not: id } },
        data: { consentNoticeRequired: false },
      });
      let failAfterCard = true;
      const realInsert = chatMessages.insertServerMessage.bind(chatMessages);
      const flaky = build({
        chatMessages: {
          // 第一次:卡片已经落库、广播已发,随后进程失败(最坏情况)。
          insertServerMessage: async (...args: never[]) => {
            const result = await (realInsert as (...a: never[]) => unknown)(
              ...args,
            );
            if (failAfterCard) throw new Error('crashed after the card');
            return result;
          },
        },
      });

      await flaky.deliverPendingConsentInvitations();
      expect(await consentState(id)).toMatchObject({
        delivered: false,
        claimed: false,
        attempts: 1,
        status: 'INVITED',
      });

      failAfterCard = false;
      await flaky.deliverPendingConsentInvitations();
      expect(await consentState(id)).toMatchObject({
        delivered: true,
        claimed: false,
        attempts: 1,
      });
      expect(await notices(id)).toBe(1);
      expect(await pushes(id)).toBe(1);
      expect(await cards(id)).toBe(1);

      // 投递完成后再跑补投:不会再碰它。
      await flaky.deliverPendingConsentInvitations();
      expect(await cards(id)).toBe(1);
    });

    it('lets only one of two concurrent deliverers (inline + cron) perform the IO', async () => {
      const { id } = await pendingInvitation();
      let notices = 0;
      let inserts = 0;
      const realDeliver =
        notifications.deliverCircleConsentNotification.bind(notifications);
      const realInsert = chatMessages.insertServerMessage.bind(chatMessages);
      const slow = build({
        notifications: {
          deliverCircleConsentNotification: async (...args: never[]) => {
            notices += 1;
            await sleep(150);
            return (realDeliver as (...a: never[]) => unknown)(...args);
          },
        },
        chatMessages: {
          insertServerMessage: async (...args: never[]) => {
            inserts += 1;
            return (realInsert as (...a: never[]) => unknown)(...args);
          },
        },
      });

      await Promise.all([deliver(slow, id), deliver(slow, id)]);

      expect({ notices, inserts }).toEqual({ notices: 1, inserts: 1 });
      expect(await consentState(id)).toMatchObject({
        delivered: true,
        claimed: false,
      });
      expect(await cards(id)).toBe(1);
    });

    it('cancels instead of delivering when the inviter lost the right to invite', async () => {
      const { owner, applicant, id, service } = await pendingInvitation();
      await t.prisma.block.create({
        data: { blockerID: applicant, blockedID: owner },
      });

      await deliver(service, id);

      expect(await consentState(id)).toMatchObject({
        delivered: true,
        claimed: false,
        status: 'CANCELLED',
      });
      expect(await notices(id)).toBe(0);
      expect(await cards(id)).toBe(0);
    });

    /**
     * 认领提交之后、IO 之前,关系/资格变了:两个写点(通知+outbox、邀请卡片)各在
     * 一个只锁这两个人的短事务里复核,复核不过就一条都不写、释放认领并作废。
     * 拉黑与隐私写入拿的是同一对 call-user:* 锁(FriendService / PrivacySettings),
     * 所以「拉黑返回成功之后不可能再有新投递」重新成立。
     */
    const interleaveAfterClaim = (
      service: CircleInvitationService,
      between: () => Promise<unknown>,
    ) => {
      const claim = (
        service as unknown as {
          claimConsentDelivery: (id: string) => Promise<unknown>;
        }
      ).claimConsentDelivery.bind(service);
      jest
        .spyOn(service as never, 'claimConsentDelivery')
        .mockImplementation((async (id: string) => {
          const claimed = await claim(id);
          await between();
          return claimed;
        }) as never);
    };
    /** 与 FriendService.blockUser 同一把锁、同一笔写。 */
    const blockNow = (blockerID: string, blockedID: string) =>
      t.prisma.$transaction(async (tx) => {
        await lockUserRelationshipState(tx, [blockerID, blockedID]);
        await tx.block.create({ data: { blockerID, blockedID } });
      });

    it.each([
      ['the applicant blocks the inviter', 'block'],
      ['the applicant declines (the invitation leaves INVITED)', 'decline'],
      ['the applicant turns group invites off', 'privacy'],
    ])(
      'writes no notice, push or card when %s after the claim commits',
      async (_label, change) => {
        const { owner, applicant, id, service } = await pendingInvitation();
        interleaveAfterClaim(service, async () => {
          if (change === 'block') await blockNow(applicant, owner);
          if (change === 'decline')
            await service.respondToInvitation(applicant, id, false);
          if (change === 'privacy')
            await t.prisma.$transaction(async (tx) => {
              await lockUserRelationshipState(tx, [applicant]);
              await tx.userPrivacySetting.create({
                data: { userID: applicant, groupInvitePermission: 'NONE' },
              });
            });
        });

        await expect(deliver(service, id)).resolves.toBeUndefined();

        expect(await notices(id)).toBe(0);
        expect(await pushes(id)).toBe(0);
        expect(await cards(id)).toBe(0);
        expect(await consentState(id)).toMatchObject({
          claimed: false,
          status: 'CANCELLED',
        });
      },
    );

    it('stops before the card when the block lands between the notice and the card', async () => {
      const { owner, applicant, id } = await pendingInvitation();
      const realDeliver =
        notifications.deliverCircleConsentNotification.bind(notifications);
      const traced = build({
        notifications: {
          deliverCircleConsentNotification: async (...args: never[]) => {
            const done = await (realDeliver as (...a: never[]) => unknown)(
              ...args,
            );
            await blockNow(applicant, owner);
            return done;
          },
        },
      });

      await deliver(traced, id);

      // 通知在拉黑之前提交(拉黑等过它的锁),卡片在拉黑之后:不发。
      expect(await notices(id)).toBe(1);
      expect(await cards(id)).toBe(0);
      expect(await consentState(id)).toMatchObject({
        claimed: false,
        status: 'CANCELLED',
      });
    });

    it('makes a block that arrives while the card is being written wait for that write', async () => {
      const { owner, applicant, id, service } = await pendingInvitation();
      // 把卡片事务卡在插入消息上:此时它已经过了复核、持有这一对 call-user 锁。
      const gate = await t.rawClient();
      let blockResolved = false;
      try {
        await gate.query('BEGIN');
        await gate.query('LOCK TABLE "ChatMessage" IN SHARE MODE');
        const delivering = deliver(service, id);
        const [cardPid] = await waitUntilBlockedBy(
          observer,
          await backendPid(gate),
        );
        const blocking = blockNow(applicant, owner).then(() => {
          blockResolved = true;
        });
        // 拉黑排在卡片事务后面,而不是插在复核与插入之间。
        await waitUntilBlockedBy(observer, cardPid);
        expect(blockResolved).toBe(false);

        await gate.query('COMMIT');
        await Promise.all([delivering, blocking]);
      } finally {
        await gate.query('ROLLBACK').catch(() => undefined);
        await gate.end();
      }
      expect(await cards(id)).toBe(1);
      expect(await consentState(id)).toMatchObject({
        delivered: true,
        claimed: false,
      });
    });

    it("keeps each write-point recheck short: only the two users' relationship locks", async () => {
      const { owner, applicant, id, service } = await pendingInvitation();
      t.setRecording(true);
      await deliver(service, id);
      t.setRecording(false);

      const lockKeys = (tx: Array<{ sql: string; values: unknown[] }>) =>
        tx
          .filter(({ sql }) => sql.includes('pg_advisory_xact_lock'))
          .flatMap(({ values }) => values.map(String));
      const writes = transactionEntriesOf(t.statements);
      const notice = writes.find((tx) =>
        tx.some(({ sql }) => /INSERT INTO "[^"]+"\."Notification"/.test(sql)),
      );
      const card = writes.find((tx) =>
        tx.some(({ sql }) => /INSERT INTO "[^"]+"\."ChatMessage"/.test(sql)),
      );
      const pair = [owner, applicant]
        .sort((a, b) => a.localeCompare(b))
        .map((user) => `call-user:${user}`);
      for (const tx of [notice, card]) {
        expect(tx).toBeDefined();
        expect(lockKeys(tx!)).toEqual(pair);
        // 复核 + 写入,不含成员锁/策略锁,也不含任何外部 IO。
        expect(tx!.length).toBeLessThan(20);
      }
      expect(await consentState(id)).toMatchObject({ delivered: true });
    });

    it('does not wait on the login database work budget', async () => {
      const { id, service } = await pendingInvitation();
      // 登录占满共享预算的全部名额(poolMax 10 → 3 个)。
      let release!: () => void;
      const held = new Promise<void>((done) => {
        release = done;
      });
      const occupants = Array.from({ length: 3 }, () =>
        withDatabaseWorkBudget(t.prisma, () => held),
      );
      try {
        const outcome = await Promise.race([
          deliver(service, id).then(() => 'delivered'),
          sleep(2000).then(() => 'starved'),
        ]);
        expect(outcome).toBe('delivered');
      } finally {
        release();
        await Promise.all(occupants);
      }
    });
  });

  describe('concurrent admissions into one circle', () => {
    it('admits 8 people accepting at once and folds their seat syncs into one trailing run', async () => {
      const [owner, ...applicants] = await createUsers(t.prisma, 9);
      const circleId = await createCircle(t.prisma, owner, [], {
        requiredVerifierCount: 1,
      });
      const sync = new ChatCircleSyncService(
        t.prisma as never,
        {
          joinUserToConversation: async () => undefined,
          removeUserFromConversation: async () => undefined,
          emitConversationChange: () => undefined,
        } as never,
        {} as never,
        { record: async () => undefined } as never,
        {} as never,
      );
      const ensure = jest.spyOn(sync, 'ensureCircleConversation');
      const service = new CircleInvitationService(
        t.prisma as never,
        realtime as never,
        privacy,
        notifications,
        admission,
        memberLock,
        sync,
        chatService as never,
        chatMessages,
      );
      jest
        .spyOn(service as never, 'deliverConsentInvitation')
        .mockImplementation((async () => undefined) as never);
      await service.inviteBatch(owner, applicants, circleId);
      const invitations = await t.prisma.circleInvitation.findMany({
        where: { circleID: circleId },
        select: { id: true, applicantID: true },
      });

      // 第一次座位同步卡在对账锁上,直到 8 个入圈全部提交。
      const gate = await t.rawClient();
      try {
        await gate.query('BEGIN');
        await gate.query('SELECT pg_advisory_xact_lock(7302, hashtext($1))', [
          circleId,
        ]);
        const accepted = await Promise.allSettled(
          invitations.map((row) =>
            service.respondToInvitation(row.applicantID, row.id, true),
          ),
        );
        // 同一圈子并发入圈全部成功(热点行冲突靠带退避的重试消化)。
        expect(accepted.map((r) => r.status)).toEqual(
          Array(8).fill('fulfilled'),
        );
        expect(
          accepted.map(
            (r) =>
              (r as PromiseFulfilledResult<{ status: string }>).value.status,
          ),
        ).toEqual(Array(8).fill('APPROVED'));
        const circle = await t.prisma.circle.findUniqueOrThrow({
          where: { id: circleId },
          select: { memberCount: true },
        });
        expect(circle.memberCount).toBe(9);
        expect(ensure).toHaveBeenCalledTimes(1);
      } finally {
        await gate.query('COMMIT').catch(() => undefined);
        await gate.end();
      }

      // 放行:在跑的那次做完,期间的 7 个请求并成一次补跑,8 人全部入座。
      const deadline = Date.now() + 5000;
      let seated = 0;
      while (Date.now() < deadline) {
        seated = await t.prisma.chatMember.count({
          where: { conversation: { circleID: circleId }, leftAt: null },
        });
        if (seated === 9 && ensure.mock.calls.length >= 2) break;
        await sleep(20);
      }
      await Promise.allSettled(ensure.mock.results.map((r) => r.value));
      expect(seated).toBe(9);
      expect(ensure).toHaveBeenCalledTimes(2);
    });
  });
});

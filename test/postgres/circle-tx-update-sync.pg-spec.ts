import type { Client } from 'pg';
import { ChatCircleSyncService } from 'src/chat/chat-circle-sync.service';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { CircleService } from 'src/circle/circle.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipProgramService } from 'src/membership/membership-program.service';
import {
  backendPid,
  type CircleTxDb,
  createCircle,
  createUsers,
  openCircleTxDb,
  sleep,
  waitUntilBlockedBy,
} from './circle-tx-harness';
import { describePostgres } from './pg-test-db';

/**
 * 改圈子设置(CircleService.updateCircle)与座位对账
 * (ChatCircleSyncService.ensureCircleConversation)交错时的锁环。
 *
 * updateCircle 原来先 `FOR UPDATE` 锁圈子群的会话行,最后再取对账锁
 * pg_advisory_xact_lock(7302, circle);对账先取对账锁,再给新成员建座位 ——
 * ChatMember 的外键检查要对同一会话行取 FOR KEY SHARE,与 FOR UPDATE 冲突。
 * 两边各持一把等另一把,就是死锁(PostgreSQL 1 秒后杀掉一边)。
 *
 * 两个用例分别把两边卡在环的两个位置上,再放行,断言两边都成功。
 */
describePostgres(
  'updateCircle vs circle seat reconciliation (PostgreSQL)',
  () => {
    let t: CircleTxDb;
    let observer: Client;
    let circles: CircleService;
    let sync: ChatCircleSyncService;
    let owner: string;
    let admin: string;
    let others: string[];

    const settle = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    /** 建圈 → 首次对账建出会话与座位 → 再加一个尚无座位的 ACTIVE 成员。 */
    const circleWithPendingSeat = async () => {
      const circleId = await createCircle(t.prisma, owner, [admin]);
      await t.prisma.circleMember.updateMany({
        where: { circleID: circleId, userID: admin },
        data: { role: 'ADMIN' },
      });
      const conversationId = await sync.ensureCircleConversation(circleId);
      const newcomer = others.pop() as string;
      await t.prisma.circleMember.create({
        data: { circleID: circleId, userID: newcomer, status: 'ACTIVE' },
      });
      return { circleId, conversationId: conversationId as string, newcomer };
    };

    const seatOf = (conversationId: string, userID: string) =>
      t.prisma.chatMember.findUnique({
        where: {
          conversationID_userID: { conversationID: conversationId, userID },
        },
        select: { leftAt: true },
      });

    beforeAll(async () => {
      t = await openCircleTxDb('circle_tx_update_sync');
      observer = await t.rawClient();
      [owner, admin, ...others] = await createUsers(t.prisma, 10);
      const membership = new MembershipPolicyService(
        t.prisma as never,
        new MembershipProgramService(t.prisma as never),
      );
      const memberLock = new CircleMemberLockService(membership);
      const groupEvents = {
        record: async () => undefined,
        recordInTx: async () => undefined,
      };
      sync = new ChatCircleSyncService(
        t.prisma as never,
        {
          joinUserToConversation: async () => undefined,
          removeUserFromConversation: async () => undefined,
          emitConversationChange: () => undefined,
        } as never,
        {} as never,
        groupEvents as never,
        {} as never,
      );
      circles = new CircleService(
        t.prisma as never,
        {} as never,
        { get: () => undefined } as never,
        membership,
        new CircleAdmissionPolicy(membership, memberLock),
        memberLock,
        sync,
        {} as never,
        groupEvents as never,
      );
    }, 60_000);

    afterAll(async () => {
      await observer?.end();
      await t?.close();
    });

    it('does not deadlock when updateCircle holds the conversation row and reconciliation then seats a member', async () => {
      const { circleId, conversationId, newcomer } =
        await circleWithPendingSeat();
      const gate = await t.rawClient();
      try {
        // 把 updateCircle 卡在招新策略锁上:此时它已经持有会话行的 FOR UPDATE。
        await gate.query('BEGIN');
        await gate.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`circle-policy:${circleId}`],
        );
        const update = settle(
          circles.updateCircle(admin, circleId, { tags: ['hiking'] } as never),
        );
        const [updatePid] = await waitUntilBlockedBy(
          observer,
          await backendPid(gate),
        );

        // 对账拿到对账锁,给新成员建座位时卡在会话行上(等 updateCircle)。
        const reconcile = settle(sync.ensureCircleConversation(circleId));
        await waitUntilBlockedBy(observer, updatePid);

        await gate.query('COMMIT');
        const [updated, reconciled] = await Promise.all([update, reconcile]);

        expect(updated).toMatchObject({ ok: true });
        expect(reconciled).toEqual({ ok: true, value: conversationId });
        expect(await seatOf(conversationId, newcomer)).toEqual({
          leftAt: null,
        });
        expect(
          (await t.prisma.circle.findUniqueOrThrow({ where: { id: circleId } }))
            .tags,
        ).toEqual(['hiking']);
      } finally {
        await gate.query('ROLLBACK').catch(() => undefined);
        await gate.end();
      }
    });

    it('does not deadlock when reconciliation holds the sync lock and updateCircle starts meanwhile', async () => {
      const { circleId, conversationId, newcomer } =
        await circleWithPendingSeat();
      const gate = await t.rawClient();
      try {
        // 把对账卡在取已读水位(读 ChatMessage)上:此时它已经持有对账锁,下一步建座位。
        await gate.query('BEGIN');
        await gate.query('LOCK TABLE "ChatMessage" IN ACCESS EXCLUSIVE MODE');
        const reconcile = settle(sync.ensureCircleConversation(circleId));
        const [reconcilePid] = await waitUntilBlockedBy(
          observer,
          await backendPid(gate),
        );

        // updateCircle 要么直接做完,要么(旧锁序)排到对账锁后面 —— 先等它落定在
        // 二者之一,再放行对账。
        let updateDone = false;
        const update = settle(
          circles.updateCircle(admin, circleId, { tags: ['reading'] } as never),
        ).then((result) => {
          updateDone = true;
          return result;
        });
        const deadline = Date.now() + 5000;
        while (!updateDone && Date.now() < deadline) {
          const { rows } = await observer.query(
            `SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
            [reconcilePid],
          );
          if (rows.length > 0) break;
          await sleep(10);
        }

        await gate.query('COMMIT');
        const [reconciled, updated] = await Promise.all([reconcile, update]);

        expect(updated).toMatchObject({ ok: true });
        expect(reconciled).toEqual({ ok: true, value: conversationId });
        expect(await seatOf(conversationId, newcomer)).toEqual({
          leftAt: null,
        });
      } finally {
        await gate.query('ROLLBACK').catch(() => undefined);
        await gate.end();
      }
    });
  },
);

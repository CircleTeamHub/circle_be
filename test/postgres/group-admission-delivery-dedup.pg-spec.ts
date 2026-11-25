import { randomUUID } from 'node:crypto';
import { GroupAdmissionService } from 'src/chat/group-admission.service';
import { describePostgres } from './pg-test-db';
import { openLiveSchema, type LiveSchema } from './live-prisma';

/**
 * 两个后端实例在同一轮取到同一条群准入投递。
 *
 * 进程内的 `delivering` 闸拦不住另一个进程,真正的互斥是事务里那把群会话行锁:
 * 输家排在锁后面,等赢家提交。锁后重读 `deliveredAt` 能看到赢家的提交,靠的是
 * READ COMMITTED 下每条语句取新快照 —— 这一点 mock 测不出来,只有真库能钉住。
 */
describePostgres('group admission delivery across two instances', () => {
  let live: LiveSchema;
  const owner = randomUUID();
  const guest = randomUUID();
  const group = randomUUID();
  const admission = randomUUID();
  const delivery = randomUUID();

  beforeAll(async () => {
    live = await openLiveSchema('group_admission_delivery');
    await live.prisma.accountIdentifier.createMany({
      data: [owner, guest].map((value) => ({ value })),
    });
    await live.prisma.user.createMany({
      data: [owner, guest].map((id) => ({
        id,
        accountId: id,
        inviteCode: id,
        passwordHash: 'test-only',
        nickname: id,
      })),
    });
    await live.prisma.chatConversation.create({
      data: {
        id: group,
        type: 'GROUP',
        name: 'test',
        ownerID: owner,
        members: { create: { userID: owner } },
      },
    });
    await live.prisma.groupAdmission.create({
      data: {
        id: admission,
        conversationID: group,
        applicantID: guest,
        kind: 'APPLICATION',
        status: 'REJECTED',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await live.prisma.groupAdmissionDelivery.create({
      data: {
        id: delivery,
        admissionID: admission,
        recipientID: guest,
        actorID: owner,
        event: 'REJECTED',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await live?.close();
  });

  function instance(deliver: jest.Mock) {
    return new GroupAdmissionService(
      live.prisma as any,
      {} as any,
      {} as any,
      {} as any,
      { deliverGroupAdmissionNotification: deliver } as any,
    );
  }

  it('delivers once when the second instance waits for the group lock', async () => {
    let winnerHoldsLock = () => {};
    const winnerInside = new Promise<void>((resolve) => {
      winnerHoldsLock = resolve;
    });
    let letWinnerCommit = () => {};
    const winnerMayCommit = new Promise<void>((resolve) => {
      letWinnerCommit = resolve;
    });
    const winnerDelivers = jest.fn(async () => {
      winnerHoldsLock();
      await winnerMayCommit;
    });
    const loserDelivers = jest.fn(async () => {});

    // 赢家:取到任务、拿到群会话行锁,停在投递里(事务未提交)。
    const winner = instance(winnerDelivers).flush();
    await winnerInside;

    // 输家:此刻读到的仍是 deliveredAt 为空的同一条,然后排在行锁后面。
    const loser = instance(loserDelivers).flush();
    const observer = await live.connect();
    for (let attempt = 0; ; attempt += 1) {
      const waiting = await observer.query<{ count: string }>(
        `SELECT count(*) FROM pg_locks WHERE NOT granted`,
      );
      if (Number(waiting.rows[0].count) > 0) break;
      if (attempt > 200) throw new Error('the second instance never queued');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    letWinnerCommit();
    await Promise.all([winner, loser]);

    expect(winnerDelivers).toHaveBeenCalledTimes(1);
    expect(loserDelivers).not.toHaveBeenCalled();
    const row = await live.prisma.groupAdmissionDelivery.findUniqueOrThrow({
      where: { id: delivery },
    });
    expect(row.deliveredAt).not.toBeNull();
    // 输家不是失败:不能消耗重试次数。
    expect(row.attempts).toBe(0);
  }, 30_000);
});

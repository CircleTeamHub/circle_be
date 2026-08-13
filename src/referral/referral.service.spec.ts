import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CoinService } from 'src/coin/coin.service';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import * as trackedCron from 'src/metrics/tracked-cron.decorator';
import { ReferralService } from './referral.service';
import { buildPendingReferralData } from './referral.rules';

const NOW = new Date('2026-08-12T12:00:00.000Z');

describe('ReferralService', () => {
  let service: ReferralService;

  const tx = {
    $queryRaw: jest.fn(),
    referral: {
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    friend: { findFirst: jest.fn() },
    wallet: { upsert: jest.fn(), update: jest.fn() },
    coinTransaction: { create: jest.fn() },
  };
  const prisma = {
    referral: {
      findMany: jest.fn(),
      groupBy: jest.fn(),
      aggregate: jest.fn(),
    },
    user: { findUniqueOrThrow: jest.fn() },
    $transaction: jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  const coins = { creditInTransaction: jest.fn() };
  const notifications = { createSystemNotification: jest.fn() };
  const realtime = {
    broadcastWalletBalanceChanged: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
    safeBroadcastAll: jest.fn(
      async (operations: Array<() => unknown | Promise<unknown>>) =>
        Promise.allSettled(operations.map((operation) => operation())),
    ),
  };

  const pendingReferral = (overrides: Record<string, unknown> = {}) => ({
    id: 'referral-1',
    inviterID: 'inviter-1',
    inviteeID: 'invitee-1',
    status: 'PENDING',
    inviterReward: 20,
    inviteeReward: 5,
    eligibleAt: new Date('2026-08-05T12:00:00.000Z'),
    expiresAt: new Date('2026-09-01T12:00:00.000Z'),
    inviter: { id: 'inviter-1', status: 'ACTIVE' },
    invitee: { id: 'invitee-1', status: 'ACTIVE', avatarUrl: 'avatar.jpg' },
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.referral.findMany.mockResolvedValue([{ id: 'referral-1' }]);
    tx.$queryRaw.mockResolvedValue([{ id: 'referral-1' }]);
    tx.referral.findUnique.mockResolvedValue(pendingReferral());
    tx.friend.findFirst.mockResolvedValue({ id: 'friend-1' });
    tx.referral.count.mockResolvedValue(0);
    tx.referral.update.mockResolvedValue({});
    coins.creditInTransaction.mockResolvedValue(20);
    notifications.createSystemNotification.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralService,
        { provide: PrismaService, useValue: prisma },
        { provide: CoinService, useValue: coins },
        { provide: NotificationService, useValue: notifications },
        { provide: RealtimeService, useValue: realtime },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = module.get(ReferralService);
  });

  it('snapshots reward rules when registration creates a referral', async () => {
    const data = buildPendingReferralData(
      {
        enabled: true,
        inviterReward: 20,
        inviteeReward: 5,
        qualificationDays: 7,
        expiryDays: 30,
        monthlyCap: 10,
      },
      {
        inviterId: 'inviter-1',
        inviteeId: 'invitee-1',
        createdAt: NOW,
      },
    );

    expect(data).toEqual({
      inviterID: 'inviter-1',
      inviteeID: 'invitee-1',
      status: 'PENDING',
      inviterReward: 20,
      inviteeReward: 5,
      eligibleAt: new Date('2026-08-19T12:00:00.000Z'),
      nextCheckAt: new Date('2026-08-19T12:00:00.000Z'),
      expiresAt: new Date('2026-09-11T12:00:00.000Z'),
    });
  });

  it('credits both wallets and ledger entries exactly inside the settlement transaction', async () => {
    const result = await service.processDue(NOW);

    expect(result).toEqual({ rewarded: 1, capped: 0, rejected: 0, expired: 0 });
    expect(coins.creditInTransaction).toHaveBeenNthCalledWith(
      1,
      tx,
      expect.objectContaining({
        userId: 'inviter-1',
        amount: 20,
        type: 'REFERRAL_REWARD',
        idempotencyKey: 'referral:inviter:referral-1',
      }),
    );
    expect(coins.creditInTransaction).toHaveBeenNthCalledWith(
      2,
      tx,
      expect.objectContaining({
        userId: 'invitee-1',
        amount: 5,
        type: 'REFERRAL_BONUS',
        idempotencyKey: 'referral:invitee:referral-1',
      }),
    );
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: expect.objectContaining({
        status: 'REWARDED',
        qualifiedAt: NOW,
        rewardedAt: NOW,
      }),
    });
  });

  it('keeps an incomplete invitee pending without touching either wallet', async () => {
    tx.referral.findUnique.mockResolvedValue(
      pendingReferral({
        invitee: { id: 'invitee-1', status: 'ACTIVE', avatarUrl: null },
      }),
    );

    const result = await service.processDue(NOW);

    expect(result).toEqual({ rewarded: 0, capped: 0, rejected: 0, expired: 0 });
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: { nextCheckAt: new Date('2026-08-12T18:00:00.000Z') },
    });
  });

  it('enforces the qualification delay even when a row is selected early', async () => {
    const eligibleAt = new Date('2026-08-19T12:00:00.000Z');
    tx.referral.findUnique.mockResolvedValue(pendingReferral({ eligibleAt }));

    const result = await service.processDue(NOW);

    expect(result).toEqual({
      rewarded: 0,
      capped: 0,
      rejected: 0,
      expired: 0,
    });
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: { nextCheckAt: eligibleAt },
    });
  });

  it('keeps an invite pending until the invitee accepts a non-inviter friend', async () => {
    tx.friend.findFirst.mockResolvedValue(null);

    const result = await service.processDue(NOW);

    expect(result).toEqual({
      rewarded: 0,
      capped: 0,
      rejected: 0,
      expired: 0,
    });
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.friend.findFirst).toHaveBeenCalledWith({
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: 'invitee-1', friendID: { not: 'inviter-1' } },
          { friendID: 'invitee-1', userID: { not: 'inviter-1' } },
        ],
      },
      select: { id: true },
    });
  });

  it('marks qualified referrals capped after ten rewards in the UTC month', async () => {
    tx.referral.count.mockResolvedValue(10);

    const result = await service.processDue(NOW);

    expect(result.capped).toBe(1);
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: {
        status: 'CAPPED',
        qualifiedAt: NOW,
        failureReason: 'MONTHLY_CAP_REACHED',
      },
    });
  });

  it('expires an unqualified referral without issuing rewards', async () => {
    tx.referral.findUnique.mockResolvedValue(
      // 名字说的是「没达成条件」,那 fixture 就不能是个合格的人:窗口到点
      // 但头像还没传,才是这条断言想覆盖的形状。
      pendingReferral({
        expiresAt: NOW,
        invitee: { id: 'invitee-1', status: 'ACTIVE', avatarUrl: null },
      }),
    );

    const result = await service.processDue(NOW);

    expect(result.expired).toBe(1);
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: {
        status: 'EXPIRED',
        failureReason: 'QUALIFICATION_WINDOW_EXPIRED',
      },
    });
  });

  // 定时器整点跑,而 deferPending 把终检夹到 expiresAt —— 那一检必然落在
  // expiresAt 之后一点点。先判过期的话,窗口最后一段时间里补上条件的人会
  // 被判 EXPIRED,而那是我们自己晚到了。
  it('still rewards someone who qualified before the deadline the sweep arrived late for', async () => {
    tx.referral.findUnique.mockResolvedValue(
      pendingReferral({ expiresAt: new Date('2026-08-12T11:30:00.000Z') }),
    );

    const result = await service.processDue(NOW);

    expect(result.rewarded).toBe(1);
    expect(coins.creditInTransaction).toHaveBeenCalledTimes(2);
  });

  it('expires a qualified referral once the grace after the deadline is spent', async () => {
    tx.referral.findUnique.mockResolvedValue(
      // expiresAt + 2h 宽限之外:再合格也不补发了。
      pendingReferral({ expiresAt: new Date('2026-08-12T09:00:00.000Z') }),
    );

    const result = await service.processDue(NOW);

    expect(result.expired).toBe(1);
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
  });

  it('expires an incomplete invitee at the deadline instead of deferring past it', async () => {
    tx.referral.findUnique.mockResolvedValue(
      pendingReferral({
        expiresAt: NOW,
        invitee: { id: 'invitee-1', status: 'ACTIVE', avatarUrl: 'a.jpg' },
      }),
    );
    tx.friend.findFirst.mockResolvedValue(null);

    const result = await service.processDue(NOW);

    expect(result.expired).toBe(1);
    // 不能再往后排一个永远等不到的 nextCheckAt。
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: {
        status: 'EXPIRED',
        failureReason: 'QUALIFICATION_WINDOW_EXPIRED',
      },
    });
  });

  // 重叠的那一轮当成功返回的话,心跳会被这些空转调用一直保鲜 —— 一个卡死在
  // 数据库/通知上的扫描就永远触发不了 CronJobStalled,看起来每小时都健康。
  it('reports an overlapping sweep as skipped instead of a success', async () => {
    const skipped = jest.spyOn(trackedCron, 'reportJobSkipped');

    let releaseFirst!: () => void;
    prisma.referral.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([]);
        }),
    );

    const first = service.processDue(NOW);
    await Promise.resolve();
    // 第一轮还挂着的时候第二轮触发。
    await service.processDue(NOW);

    expect(skipped).toHaveBeenCalledTimes(1);

    releaseFirst();
    await first;
    skipped.mockRestore();
  });

  // 活动关掉是合法空跑:照常记成功,否则 CronJobStalled 会对一个本来就没事干
  // 的任务一直叫。
  it('does not mark a disabled campaign as skipped', async () => {
    const skipped = jest.spyOn(trackedCron, 'reportJobSkipped');
    (service as unknown as { rules: { enabled: boolean } }).rules.enabled =
      false;

    await service.processDue(NOW);

    expect(skipped).not.toHaveBeenCalled();
    expect(prisma.referral.findMany).not.toHaveBeenCalled();
    skipped.mockRestore();
    (service as unknown as { rules: { enabled: boolean } }).rules.enabled =
      true;
  });

  describe('sweep drains the whole due queue', () => {
    // 一批抽完就停 = 吞吐钉死在 100/小时,而每条不达标的行每 6 小时回队一次,
    // 几百条长期不达标的就能把额度吃光,达标的排在后面等到过期。
    it('keeps claiming batches until a short batch comes back', async () => {
      const fullBatch = Array.from({ length: 100 }, (_, index) => ({
        id: `referral-${index}`,
      }));
      prisma.referral.findMany
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([{ id: 'referral-tail' }]);

      const result = await service.processDue(NOW);

      expect(prisma.referral.findMany).toHaveBeenCalledTimes(3);
      expect(result.rewarded).toBe(201);
    });

    it('stops after one pass when the first batch is already short', async () => {
      prisma.referral.findMany.mockResolvedValue([{ id: 'referral-1' }]);

      await service.processDue(NOW);

      expect(prisma.referral.findMany).toHaveBeenCalledTimes(1);
    });

    // 抛错的行不推进 nextCheckAt —— 不排掉的话下一批把它原样再抽一遍,
    // 排空循环会退化成对同一批坏行的重试风暴。
    it('excludes rows that threw from the batches that follow', async () => {
      const fullBatch = Array.from({ length: 100 }, (_, index) => ({
        id: `referral-${index}`,
      }));
      prisma.referral.findMany
        .mockResolvedValueOnce(fullBatch)
        .mockResolvedValueOnce([]);
      coins.creditInTransaction.mockRejectedValueOnce(new Error('boom'));

      await expect(service.processDue(NOW)).rejects.toThrow('boom');

      expect(prisma.referral.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: { notIn: ['referral-0'] } }),
        }),
      );
    });
  });
});

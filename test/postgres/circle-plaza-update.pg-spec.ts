import {
  loadCirclePlazaHasUpdate,
  loadCirclePlazaUpdate,
} from 'src/circle-plaza/circle-plaza-update.query';
import { CirclePlazaService } from 'src/circle-plaza/circle-plaza.service';
import {
  type CircleTxDb,
  createCircle,
  createUsers,
  openCircleTxDb,
} from './circle-tx-harness';
import { describePostgres } from './pg-test-db';

/** 飞机红点的真值：真实 SQL 下，它和圈子帖子列表的可见性口径一致。 */
describePostgres('circle plaza update dot (PostgreSQL)', () => {
  let t: CircleTxDb;
  const HOUR_MS = 60 * 60 * 1000;

  beforeAll(async () => {
    t = await openCircleTxDb('circle_plaza_update');
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  const setup = async () => {
    const [viewer, author] = await createUsers(t.prisma, 2);
    const circle = await createCircle(t.prisma, author, [viewer]);
    await t.prisma.user.update({
      where: { id: viewer },
      data: { circlePlazaSeenAt: new Date(Date.now() - HOUR_MS) },
    });
    return { viewer, author, circle };
  };

  const post = (
    authorID: string,
    circleID: string,
    data: { status?: 'ENDED'; expiresAt?: Date; createdAt?: Date } = {},
  ) =>
    t.prisma.circlePost.create({
      data: {
        authorID,
        circleID,
        expiresAt: new Date(Date.now() + HOUR_MS),
        circleLinks: { create: { circleID } },
        ...data,
      },
    });

  const hasUpdate = (userId: string) =>
    loadCirclePlazaHasUpdate(t.prisma as never, userId);

  it("lights up for another member's post after the last visit", async () => {
    const { viewer, author, circle } = await setup();
    await post(author, circle);
    await expect(hasUpdate(viewer)).resolves.toBe(true);
  });

  it('ignores posts from before the last visit', async () => {
    const { viewer, author, circle } = await setup();
    await post(author, circle, {
      createdAt: new Date(Date.now() - 2 * HOUR_MS),
    });
    await expect(hasUpdate(viewer)).resolves.toBe(false);
  });

  it("ignores the viewer's own posts", async () => {
    const { viewer, circle } = await setup();
    await post(viewer, circle);
    await expect(hasUpdate(viewer)).resolves.toBe(false);
  });

  it('ignores circles the viewer is not an active member of', async () => {
    const { viewer, author } = await setup();
    await post(author, await createCircle(t.prisma, author));
    await expect(hasUpdate(viewer)).resolves.toBe(false);
  });

  it('ignores posts the feed no longer shows', async () => {
    const ended = await setup();
    await post(ended.author, ended.circle, { status: 'ENDED' });
    await expect(hasUpdate(ended.viewer)).resolves.toBe(false);

    const expired = await setup();
    await post(expired.author, expired.circle, {
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(hasUpdate(expired.viewer)).resolves.toBe(false);

    const deleted = await setup();
    await post(deleted.author, deleted.circle);
    await t.prisma.circle.update({
      where: { id: deleted.circle },
      data: { deleted: true },
    });
    await expect(hasUpdate(deleted.viewer)).resolves.toBe(false);
  });

  it('does not light up a brand-new account for posts it never had', async () => {
    const [author] = await createUsers(t.prisma, 1);
    const circle = await createCircle(t.prisma, author);
    await post(author, circle, {
      createdAt: new Date(Date.now() - HOUR_MS),
    });
    const [viewer] = await createUsers(t.prisma, 1);
    await t.prisma.circleMember.create({
      data: { userID: viewer, circleID: circle, status: 'ACTIVE' },
    });
    await expect(hasUpdate(viewer)).resolves.toBe(false);
  });

  const serviceFor = (broadcastCirclePlazaSeen = jest.fn()) =>
    new CirclePlazaService(
      t.prisma as never,
      { get: () => undefined } as never,
      { broadcastCirclePlazaSeen } as never,
      {} as never,
      { getDisplayIconsForUsers: async () => new Map() } as never,
      {
        resolveEntitlement: async () => ({
          level: 1,
          tier: { quotas: { cityFilters: { actual: 1 } } },
        }),
      } as never,
      { resolvePublicAppearances: async () => new Map() } as never,
    );

  const databaseNow = async () => {
    const [row] = await t.prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT date_trunc('milliseconds', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AS "now"`;
    return row.now;
  };

  it('returns a database feed snapshot and excludes later posts from rows and count', async () => {
    const { viewer, author, circle } = await setup();
    const visible = await post(author, circle, {
      createdAt: new Date(Date.now() - 10_000),
    });
    await post(author, circle, { createdAt: new Date(Date.now() + 60_000) });
    const before = await databaseNow();

    const feed = await serviceFor().getFeed(viewer, {});

    const snapshot = new Date(feed.snapshotAt);
    expect(snapshot.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(snapshot.getTime()).toBeLessThanOrEqual(
      (await databaseNow()).getTime(),
    );
    expect(feed.items.map((item) => item.id)).toEqual([visible.id]);
    expect(feed.total).toBe(1);
  });

  it('marks only the submitted snapshot, preserving later unread posts and User.updatedAt', async () => {
    const { viewer, author, circle } = await setup();
    await post(author, circle, { createdAt: new Date(Date.now() - 10_000) });
    const snapshotAt = new Date((await databaseNow()).getTime() - 5_000);
    // Unread posts must be within the status observation, not artificially in the future.
    await post(author, circle, {
      createdAt: new Date(snapshotAt.getTime() + 1_000),
    });
    await post(author, circle, {
      createdAt: new Date(snapshotAt.getTime() + 2_000),
    });
    const broadcast = jest.fn();
    const service = serviceFor(broadcast);
    const before = await t.prisma.user.findUniqueOrThrow({
      where: { id: viewer },
      select: { updatedAt: true },
    });

    await expect(
      service.markPlazaSeen(viewer, snapshotAt.toISOString()),
    ).resolves.toEqual({ hasUpdate: true, changedAt: expect.any(String) });

    const after = await t.prisma.user.findUniqueOrThrow({
      where: { id: viewer },
      select: { updatedAt: true, circlePlazaSeenAt: true },
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.circlePlazaSeenAt).toEqual(snapshotAt);
    await expect(hasUpdate(viewer)).resolves.toBe(true);
    expect(broadcast).toHaveBeenCalledWith(viewer, true, expect.any(String));
  });

  it.each(['expired', 'deleted'] as const)(
    'clears the dot with a newer observation after the only unread post is %s',
    async (reason) => {
      const { viewer, author, circle } = await setup();
      const postAt = new Date((await databaseNow()).getTime() - 1000);
      const unread = await post(author, circle, { createdAt: postAt });
      const first = await loadCirclePlazaUpdate(t.prisma as never, viewer);
      expect(first.hasUpdate).toBe(true);
      if (reason === 'deleted')
        await t.prisma.circlePost.delete({ where: { id: unread.id } });
      else
        await t.prisma.circlePost.update({
          where: { id: unread.id },
          data: { expiresAt: new Date(postAt.getTime() - 1000) },
        });
      const second = await loadCirclePlazaUpdate(t.prisma as never, viewer);
      expect(second.hasUpdate).toBe(false);
      expect(Date.parse(second.changedAt)).toBeGreaterThan(postAt.getTime());
      expect(Date.parse(second.changedAt)).toBeGreaterThanOrEqual(
        Date.parse(first.changedAt),
      );
    },
  );

  it('does not include posts beyond the database observation watermark', async () => {
    const { viewer, author, circle } = await setup();
    await post(author, circle, {
      createdAt: new Date((await databaseNow()).getTime() + 60_000),
    });
    await expect(hasUpdate(viewer)).resolves.toBe(false);
  });

  it('does not move the watermark backwards on a delayed older request', async () => {
    const { viewer } = await setup();
    const service = serviceFor();
    const snapshotAt = await databaseNow();
    await service.markPlazaSeen(viewer, snapshotAt.toISOString());
    await service.markPlazaSeen(
      viewer,
      new Date(snapshotAt.getTime() - 1_000).toISOString(),
    );

    const user = await t.prisma.user.findUniqueOrThrow({
      where: { id: viewer },
      select: { circlePlazaSeenAt: true },
    });
    expect(user.circlePlazaSeenAt).toEqual(snapshotAt);
  });

  it('clamps a future client watermark to the database clock and clears read posts', async () => {
    const { viewer, author, circle } = await setup();
    await post(author, circle, { createdAt: new Date(Date.now() - 10_000) });
    const broadcast = jest.fn();
    const service = serviceFor(broadcast);
    const before = await databaseNow();

    await expect(
      service.markPlazaSeen(viewer, '2099-01-01T00:00:00.000Z'),
    ).resolves.toEqual({ hasUpdate: false, changedAt: expect.any(String) });

    const after = await databaseNow();
    const user = await t.prisma.user.findUniqueOrThrow({
      where: { id: viewer },
      select: { circlePlazaSeenAt: true },
    });
    expect(user.circlePlazaSeenAt.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(user.circlePlazaSeenAt.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );
    await expect(hasUpdate(viewer)).resolves.toBe(false);
    expect(broadcast).toHaveBeenCalledWith(viewer, false, expect.any(String));
  });
});

import { loadCirclePlazaHasUpdate } from 'src/circle-plaza/circle-plaza-update.query';
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

  it('marks seen at the current instant without moving User.updatedAt', async () => {
    const { viewer, author, circle } = await setup();
    await post(author, circle);
    const service = new CirclePlazaService(
      t.prisma as never,
      { get: () => undefined } as never,
      { broadcastCirclePlazaSeen: async () => undefined } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const before = await t.prisma.user.findUniqueOrThrow({
      where: { id: viewer },
      select: { updatedAt: true },
    });

    await service.markPlazaSeen(viewer);

    const after = await t.prisma.user.findUniqueOrThrow({
      where: { id: viewer },
      select: { updatedAt: true, circlePlazaSeenAt: true },
    });
    expect(after.updatedAt).toEqual(before.updatedAt);
    // 时间列没有时区：写歪了会差出整数小时，红点要么永远亮要么永远不亮。
    expect(
      Math.abs(after.circlePlazaSeenAt.getTime() - Date.now()),
    ).toBeLessThan(60_000);
    await expect(hasUpdate(viewer)).resolves.toBe(false);
  });
});

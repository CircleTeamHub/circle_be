import { randomUUID } from 'crypto';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { getGroupExpansionProduct } from 'src/group-expansion/group-expansion.catalog';
import { GroupExpansionService } from 'src/group-expansion/group-expansion.service';
import { CircleMemberRole, CircleMemberStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { runSerializableTransaction } from 'src/utils/prisma-tx';
import { getE2eApp } from './e2e-context';

function canRunPostgresE2e(): boolean {
  const databaseUrl = process.env.DATABASE_URL;
  if (process.env.NODE_ENV !== 'test' || !databaseUrl || !process.env.SECRET) {
    return false;
  }

  try {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.slice(1));
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      /(^|[_-])test($|[_-])/i.test(databaseName)
    );
  } catch {
    return false;
  }
}

const describePostgres = canRunPostgresE2e() ? describe : describe.skip;

describePostgres('Group expansion purchase concurrency e2e', () => {
  let prisma: PrismaService;
  let service: GroupExpansionService;
  let admissionPolicy: CircleAdmissionPolicy;

  const createOwnerWithCircle = async (
    options: {
      balance?: number;
      maxMembers?: number;
      vipLevel?: number;
    } = {},
  ) => {
    const ownerID = randomUUID();
    const suffix = ownerID.replace(/-/g, '').slice(0, 10);
    await prisma.user.create({
      data: {
        id: ownerID,
        accountId: `expansion-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'not-used',
        nickname: `Expansion ${suffix}`,
        vipLevel: options.vipLevel ?? 4,
      },
    });
    await prisma.wallet.create({
      data: { userID: ownerID, balance: options.balance ?? 20_000 },
    });
    const circle = await prisma.circle.create({
      data: {
        id: randomUUID(),
        name: 'Expansion concurrency',
        ownerID,
        memberCount: 1,
        maxMembers: options.maxMembers ?? 1000,
      },
    });
    return { ownerID, circleID: circle.id };
  };

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    service = app.get(GroupExpansionService);
    admissionPolicy = app.get(CircleAdmissionPolicy);
  });

  it('allows only one concurrent flagship purchase at the hard limit', async () => {
    const { ownerID, circleID } = await createOwnerWithCircle();
    const product = getGroupExpansionProduct('flagship')!;

    const results = await Promise.allSettled([
      service.purchase(ownerID, circleID, 'flagship', randomUUID()),
      service.purchase(ownerID, circleID, 'flagship', randomUUID()),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    await expect(
      prisma.circle.findUniqueOrThrow({
        where: { id: circleID },
        select: { maxMembers: true, expansionSeats: true },
      }),
    ).resolves.toEqual({ maxMembers: 3000, expansionSeats: 2000 });
    await expect(
      prisma.wallet.findUniqueOrThrow({
        where: { userID: ownerID },
        select: { balance: true },
      }),
    ).resolves.toEqual({ balance: 20_000 - product.price });
    await expect(
      prisma.groupExpansionOrder.count({ where: { circleID } }),
    ).resolves.toBe(1);
  });

  it('converges two concurrent retries with the same idempotency key', async () => {
    const { ownerID, circleID } = await createOwnerWithCircle();
    const idempotencyKey = randomUUID();
    const product = getGroupExpansionProduct('light')!;

    const purchases = await Promise.all([
      service.purchase(ownerID, circleID, 'light', idempotencyKey),
      service.purchase(ownerID, circleID, 'light', idempotencyKey),
    ]);

    expect(new Set(purchases.map(({ orderId }) => orderId)).size).toBe(1);
    await expect(
      prisma.wallet.findUniqueOrThrow({
        where: { userID: ownerID },
        select: { balance: true },
      }),
    ).resolves.toEqual({ balance: 20_000 - product.price });
    await expect(
      prisma.groupExpansionOrder.count({ where: { circleID } }),
    ).resolves.toBe(1);
  });

  it('rolls back wallet, capacity, and order when the final ledger insert fails', async () => {
    const { ownerID, circleID } = await createOwnerWithCircle({
      maxMembers: 100,
    });
    const idempotencyKey = randomUUID();
    const ledgerKey = `group-expansion:client:${ownerID}:${idempotencyKey}`;
    await prisma.coinTransaction.create({
      data: {
        userID: ownerID,
        type: 'ADJUSTMENT',
        amount: 0,
        balance: 20_000,
        idempotencyKey: ledgerKey,
      },
    });

    await expect(
      service.purchase(ownerID, circleID, 'light', idempotencyKey),
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      prisma.wallet.findUniqueOrThrow({
        where: { userID: ownerID },
        select: { balance: true },
      }),
    ).resolves.toEqual({ balance: 20_000 });
    await expect(
      prisma.circle.findUniqueOrThrow({
        where: { id: circleID },
        select: { maxMembers: true, expansionSeats: true },
      }),
    ).resolves.toEqual({ maxMembers: 100, expansionSeats: 0 });
    await expect(
      prisma.groupExpansionOrder.count({ where: { circleID } }),
    ).resolves.toBe(0);
    await expect(
      prisma.coinTransaction.count({
        where: { idempotencyKey: ledgerKey },
      }),
    ).resolves.toBe(1);
  });

  it('prevents cross-circle double spend from one 100-point wallet', async () => {
    const { ownerID, circleID: firstCircleID } = await createOwnerWithCircle({
      balance: 100,
      maxMembers: 100,
    });
    const secondCircle = await prisma.circle.create({
      data: {
        id: randomUUID(),
        name: 'Second expansion circle',
        ownerID,
        memberCount: 1,
        maxMembers: 100,
      },
    });

    const results = await Promise.allSettled([
      service.purchase(ownerID, firstCircleID, 'light', randomUUID()),
      service.purchase(ownerID, secondCircle.id, 'light', randomUUID()),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    await expect(
      prisma.wallet.findUniqueOrThrow({
        where: { userID: ownerID },
        select: { balance: true },
      }),
    ).resolves.toEqual({ balance: 0 });
    await expect(
      prisma.groupExpansionOrder.count({ where: { userID: ownerID } }),
    ).resolves.toBe(1);
    await expect(
      prisma.coinTransaction.count({
        where: { userID: ownerID, type: 'PURCHASE' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.circle.count({
        where: {
          id: { in: [firstCircleID, secondCircle.id] },
          expansionSeats: 100,
          maxMembers: 200,
        },
      }),
    ).resolves.toBe(1);
  });

  it('makes purchased seats available to real admission through the new boundary', async () => {
    const { ownerID, circleID } = await createOwnerWithCircle({
      balance: 100,
      maxMembers: 100,
      vipLevel: 0,
    });
    const createUsers = async (prefix: string, count: number) => {
      const rows = Array.from({ length: count }, (_, index) => {
        const id = randomUUID();
        const suffix = id.replace(/-/g, '').slice(0, 10);
        return {
          id,
          accountId: `${prefix}-${suffix}`,
          inviteCode: `${prefix[0]}${String(index).padStart(3, '0')}${suffix.slice(0, 6)}`,
          passwordHash: 'not-used',
          nickname: `${prefix} ${index}`,
        };
      });
      await prisma.user.createMany({ data: rows });
      return rows;
    };
    const existing = await createUsers('existing', 99);
    const candidates = await createUsers('candidate', 101);
    await prisma.circleMember.createMany({
      data: [
        {
          circleID,
          userID: ownerID,
          role: CircleMemberRole.OWNER,
          status: CircleMemberStatus.ACTIVE,
        },
        ...existing.map(({ id }) => ({
          circleID,
          userID: id,
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.ACTIVE,
        })),
      ],
    });
    await prisma.circle.update({
      where: { id: circleID },
      data: { memberCount: 100 },
    });
    await prisma.membershipProgramState.upsert({
      where: { id: 1 },
      update: { enabledAt: new Date() },
      create: { id: 1, enabledAt: new Date() },
    });
    const activate = (userIDs: string[]) =>
      runSerializableTransaction(prisma, (tx) =>
        admissionPolicy.activateMembers(tx, circleID, userIDs),
      );

    await expect(activate([candidates[0].id])).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_MEMBER_LIMIT', limit: 100 },
    });

    await service.purchase(ownerID, circleID, 'light', randomUUID());
    await expect(
      activate(candidates.slice(0, 100).map(({ id }) => id)),
    ).resolves.toHaveLength(100);
    await expect(activate([candidates[100].id])).rejects.toMatchObject({
      response: { errorCode: 'CIRCLE_MEMBER_LIMIT', limit: 200 },
    });
  });

  it('allows one request when the same key races across different products', async () => {
    const { ownerID, circleID } = await createOwnerWithCircle({
      maxMembers: 100,
    });
    const idempotencyKey = randomUUID();

    const results = await Promise.allSettled([
      service.purchase(ownerID, circleID, 'light', idempotencyKey),
      service.purchase(ownerID, circleID, 'advanced', idempotencyKey),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(
      rejected?.status === 'rejected'
        ? (rejected.reason as { response?: { errorCode?: string } }).response
            ?.errorCode
        : undefined,
    ).toBe('GROUP_EXPANSION_IDEMPOTENCY_CONFLICT');
    const order = await prisma.groupExpansionOrder.findFirstOrThrow({
      where: { circleID },
    });
    await expect(
      prisma.wallet.findUniqueOrThrow({
        where: { userID: ownerID },
        select: { balance: true },
      }),
    ).resolves.toEqual({ balance: 20_000 - order.price });
    await expect(
      prisma.coinTransaction.count({
        where: { userID: ownerID, type: 'PURCHASE' },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.circle.findUniqueOrThrow({
        where: { id: circleID },
        select: { expansionSeats: true, maxMembers: true },
      }),
    ).resolves.toEqual({
      expansionSeats: order.seats,
      maxMembers: 100 + order.seats,
    });
  });
});

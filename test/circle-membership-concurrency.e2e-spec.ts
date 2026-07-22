import { randomUUID } from 'crypto';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleService } from 'src/circle/circle.service';
import { GroupService } from 'src/group/group.service';
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

describePostgres('Circle membership transition concurrency e2e', () => {
  let prisma: PrismaService;
  let admissionPolicy: CircleAdmissionPolicy;
  let circleService: CircleService;
  let groupService: GroupService;

  const createUser = async (label: string) => {
    const id = randomUUID();
    const suffix = id.replace(/-/g, '').slice(0, 10);
    return prisma.user.create({
      data: {
        id,
        accountId: `${label}-${suffix}`,
        inviteCode: suffix.slice(0, 6),
        passwordHash: 'not-used',
        nickname: `${label} ${suffix}`,
      },
    });
  };

  const createCircleWithPendingMember = async (options?: {
    admin?: boolean;
  }) => {
    const [owner, candidate] = await Promise.all([
      createUser('owner'),
      createUser('candidate'),
    ]);
    const admin = options?.admin ? await createUser('admin') : null;
    const circle = await prisma.circle.create({
      data: {
        id: randomUUID(),
        name: 'Membership race',
        ownerID: owner.id,
        memberCount: admin ? 2 : 1,
        maxMembers: 100,
      },
    });
    await prisma.circleMember.createMany({
      data: [
        {
          circleID: circle.id,
          userID: owner.id,
          role: CircleMemberRole.OWNER,
          status: CircleMemberStatus.ACTIVE,
        },
        ...(admin
          ? [
              {
                circleID: circle.id,
                userID: admin.id,
                role: CircleMemberRole.ADMIN,
                status: CircleMemberStatus.ACTIVE,
              },
            ]
          : []),
        {
          circleID: circle.id,
          userID: candidate.id,
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.PENDING,
        },
      ],
    });
    return { owner, admin, candidate, circle };
  };

  const activate = (circleID: string, userID: string) =>
    runSerializableTransaction(prisma, (tx) =>
      admissionPolicy.activateMembers(tx, circleID, [userID]),
    );

  const expectCounterConsistent = async (circleID: string) => {
    const [circle, activeCount] = await Promise.all([
      prisma.circle.findUniqueOrThrow({
        where: { id: circleID },
        select: { memberCount: true },
      }),
      prisma.circleMember.count({
        where: { circleID, status: CircleMemberStatus.ACTIVE },
      }),
    ]);
    expect(circle.memberCount).toBe(activeCount);
  };

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    admissionPolicy = app.get(CircleAdmissionPolicy);
    circleService = app.get(CircleService);
    groupService = app.get(GroupService);
  });

  it('keeps count consistent when pending activation races circle leave', async () => {
    const { candidate, circle } = await createCircleWithPendingMember();

    await Promise.allSettled([
      activate(circle.id, candidate.id),
      circleService.leaveCircle(candidate.id, circle.id),
    ]);

    await expectCounterConsistent(circle.id);
  });

  it('keeps count consistent when pending activation races group leave', async () => {
    const { candidate, circle } = await createCircleWithPendingMember();

    await Promise.allSettled([
      activate(circle.id, candidate.id),
      groupService.leaveGroup(candidate.id, circle.id),
    ]);

    await expectCounterConsistent(circle.id);
  });

  it('keeps count consistent when pending activation races admin removal', async () => {
    const { admin, candidate, circle } = await createCircleWithPendingMember({
      admin: true,
    });

    await Promise.allSettled([
      activate(circle.id, candidate.id),
      groupService.removeGroupMember(admin!.id, circle.id, candidate.id),
    ]);

    await expectCounterConsistent(circle.id);
  });

  it('allows exactly one same-user admission from joined quota minus one', async () => {
    const [owner, candidate] = await Promise.all([
      createUser('quota-owner'),
      createUser('quota-candidate'),
    ]);
    const joinedCircleIDs = Array.from({ length: 99 }, () => randomUUID());
    const targetCircleIDs = [randomUUID(), randomUUID()];
    await prisma.circle.createMany({
      data: [...joinedCircleIDs, ...targetCircleIDs].map((id, index) => ({
        id,
        name: `Quota circle ${index}`,
        ownerID: owner.id,
        memberCount: joinedCircleIDs.includes(id) ? 2 : 1,
        maxMembers: 100,
      })),
    });
    await prisma.circleMember.createMany({
      data: [
        ...[...joinedCircleIDs, ...targetCircleIDs].map((circleID) => ({
          circleID,
          userID: owner.id,
          role: CircleMemberRole.OWNER,
          status: CircleMemberStatus.ACTIVE,
        })),
        ...joinedCircleIDs.map((circleID) => ({
          circleID,
          userID: candidate.id,
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.ACTIVE,
        })),
        ...targetCircleIDs.map((circleID) => ({
          circleID,
          userID: candidate.id,
          role: CircleMemberRole.MEMBER,
          status: CircleMemberStatus.PENDING,
        })),
      ],
    });

    const results = await Promise.allSettled(
      targetCircleIDs.map((circleID) => activate(circleID, candidate.id)),
    );

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    await expect(
      prisma.circleMember.count({
        where: {
          userID: candidate.id,
          role: { not: CircleMemberRole.OWNER },
          status: CircleMemberStatus.ACTIVE,
        },
      }),
    ).resolves.toBe(100);
    await Promise.all(targetCircleIDs.map(expectCounterConsistent));
  });
});

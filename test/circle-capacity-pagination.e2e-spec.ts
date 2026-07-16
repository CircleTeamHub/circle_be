import { randomUUID } from 'crypto';
import { CircleInvitationService } from 'src/circle-invitation/circle-invitation.service';
import { reserveCircleSeats } from 'src/circle/circle-capacity';
import { CircleMemberStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { getE2eApp } from './e2e-context';

describe('Circle capacity and invitation pagination e2e', () => {
  let prisma: PrismaService;
  let invitationService: CircleInvitationService;

  beforeEach(() => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    invitationService = app.get(CircleInvitationService);
  });

  it('allows only one concurrent transaction to take the last circle seat', async () => {
    const ownerId = randomUUID();
    const candidateIds = [randomUUID(), randomUUID()];
    const circleId = randomUUID();
    await prisma.user.createMany({
      data: [ownerId, ...candidateIds].map((id, index) => ({
        id,
        accountId: `capacity-${index}-${id}`,
        inviteCode: `cp${index}${id.replace(/-/g, '').slice(0, 3)}`,
        passwordHash: 'x',
        nickname: `Capacity ${index}`,
      })),
    });
    await prisma.circle.create({
      data: {
        id: circleId,
        name: 'Capacity race',
        ownerID: ownerId,
        memberCount: 1,
        maxMembers: 2,
      },
    });
    await prisma.circleMember.create({
      data: {
        circleID: circleId,
        userID: ownerId,
        role: 'OWNER',
        status: CircleMemberStatus.ACTIVE,
      },
    });

    let ready = 0;
    let release!: () => void;
    const bothMembershipWritesReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt = (userID: string) =>
      prisma.$transaction(async (tx) => {
        await tx.circleMember.create({
          data: {
            circleID: circleId,
            userID,
            status: CircleMemberStatus.ACTIVE,
          },
        });
        ready += 1;
        if (ready === candidateIds.length) {
          release();
        }
        await bothMembershipWritesReady;
        if (!(await reserveCircleSeats(tx, circleId, 1))) {
          throw new Error('member limit');
        }
      });

    const results = await Promise.allSettled(candidateIds.map(attempt));

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    await expect(
      prisma.circle.findUnique({ where: { id: circleId } }),
    ).resolves.toMatchObject({ memberCount: 2, maxMembers: 2 });
    await expect(
      prisma.circleMember.count({
        where: { circleID: circleId, status: CircleMemberStatus.ACTIVE },
      }),
    ).resolves.toBe(2);
  });

  it('traverses more than 50 pending applications without gaps', async () => {
    const ownerId = randomUUID();
    const applicantId = randomUUID();
    const circleId = randomUUID();
    await prisma.user.createMany({
      data: [ownerId, applicantId].map((id, index) => ({
        id,
        accountId: `pagination-${index}-${id}`,
        inviteCode: `pg${index}${id.replace(/-/g, '').slice(0, 3)}`,
        passwordHash: 'x',
        nickname: `Pagination ${index}`,
      })),
    });
    await prisma.circle.create({
      data: { id: circleId, name: 'Pagination', ownerID: ownerId },
    });
    const invitationIds = Array.from({ length: 55 }, () => randomUUID());
    const createdAt = new Date('2026-07-16T12:00:00.000Z');
    await prisma.circleInvitation.createMany({
      data: invitationIds.map((id) => ({
        id,
        circleID: circleId,
        applicantID: applicantId,
        inviterID: ownerId,
        createdAt,
      })),
    });

    const firstPage = await invitationService.getMyApplications(applicantId);
    expect(firstPage).toHaveLength(50);
    const cursor = firstPage[firstPage.length - 1].id;
    await prisma.circleInvitation.update({
      where: { id: cursor },
      data: { status: 'APPROVED' },
    });
    const secondPage = await invitationService.getMyApplications(applicantId, {
      cursor,
      limit: 50,
    });

    expect(secondPage).toHaveLength(5);
    const returnedIds = [...firstPage, ...secondPage].map(({ id }) => id);
    expect(new Set(returnedIds).size).toBe(55);
    expect(new Set(returnedIds)).toEqual(new Set(invitationIds));
  });
});

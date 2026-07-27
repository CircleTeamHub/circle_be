import { randomUUID } from 'crypto';
import { PlazaErrorCode } from 'src/common/app-error-codes';
import { CirclePlazaService } from 'src/circle-plaza/circle-plaza.service';
import { CircleMemberStatus } from 'src/generated/prisma';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { getE2eApp } from './e2e-context';

describe('CirclePlaza signup membership e2e', () => {
  let prisma: PrismaService;
  let service: CirclePlazaService;
  let ownerId: string;
  let signerId: string;
  let primaryCircleId: string;
  let secondaryCircleId: string;
  let unrelatedCircleId: string;
  let postId: string;

  beforeEach(async () => {
    const app = getE2eApp();
    prisma = app.get(PrismaService);
    service = app.get(CirclePlazaService);
    jest
      .spyOn(app.get(NotificationService), 'createCirclePostSignupNotification')
      .mockResolvedValue(null);
    jest
      .spyOn(app.get(RealtimeService), 'broadcastSignupUnread')
      .mockResolvedValue(undefined);

    ownerId = randomUUID();
    signerId = randomUUID();
    primaryCircleId = randomUUID();
    secondaryCircleId = randomUUID();
    unrelatedCircleId = randomUUID();
    postId = randomUUID();

    await prisma.user.createMany({
      data: [
        {
          id: ownerId,
          accountId: `owner-${ownerId}`,
          inviteCode: 'e2ownr',
          passwordHash: 'x',
          nickname: 'Owner',
        },
        {
          id: signerId,
          accountId: `signer-${signerId}`,
          inviteCode: 'e2sign',
          passwordHash: 'x',
          nickname: 'Signer',
        },
      ],
    });
    await prisma.circle.createMany({
      data: [
        {
          id: primaryCircleId,
          name: 'Primary',
          ownerID: ownerId,
          deleted: true,
        },
        {
          id: secondaryCircleId,
          name: 'Secondary',
          ownerID: ownerId,
        },
        {
          id: unrelatedCircleId,
          name: 'Unrelated',
          ownerID: ownerId,
        },
      ],
    });
    await prisma.circlePost.create({
      data: {
        id: postId,
        authorID: ownerId,
        circleID: primaryCircleId,
        content: 'e2e',
        circleLinks: {
          create: [
            { circle: { connect: { id: primaryCircleId } } },
            { circle: { connect: { id: secondaryCircleId } } },
          ],
        },
      },
    });
  });

  afterEach(() => jest.restoreAllMocks());

  async function expectPostNotFound(
    operation: Promise<unknown>,
  ): Promise<void> {
    await expect(operation).rejects.toMatchObject({
      response: { errorCode: PlazaErrorCode.PostNotFound },
    });
    await expect(
      prisma.circlePostSignup.count({
        where: { postID: postId, userID: signerId },
      }),
    ).resolves.toBe(0);
  }

  it('allows an ACTIVE member of a secondary linked circle when primary is deleted', async () => {
    await prisma.circleMember.create({
      data: {
        userID: signerId,
        circleID: secondaryCircleId,
        status: CircleMemberStatus.ACTIVE,
      },
    });

    await expect(service.signupForPost(signerId, postId)).resolves.toEqual({
      signed: true,
      signupCount: 1,
    });
  });

  it('rejects a level-0 signer before any signup, counter change, or notification', async () => {
    // Rollout enabled → a regular signer resolves to effective level 0 (no gold
    // marketing floor). Feed and detail forbid level 0, so signup must too, or
    // the caller writes a signup for content it can never view.
    await prisma.membershipProgramState.upsert({
      where: { id: 1 },
      update: { enabledAt: new Date() },
      create: { id: 1, enabledAt: new Date() },
    });
    await prisma.circleMember.create({
      data: {
        userID: signerId,
        circleID: secondaryCircleId,
        status: CircleMemberStatus.ACTIVE,
      },
    });
    const notifySpy = getE2eApp().get(NotificationService)
      .createCirclePostSignupNotification as jest.Mock;

    await expect(service.signupForPost(signerId, postId)).rejects.toMatchObject(
      {
        response: { errorCode: PlazaErrorCode.MembershipRequired },
      },
    );
    await expect(
      prisma.circlePostSignup.count({
        where: { postID: postId, userID: signerId },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.circlePost.findUnique({
        where: { id: postId },
        select: { signupCount: true },
      }),
    ).resolves.toMatchObject({ signupCount: 0 });
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it.each([CircleMemberStatus.PENDING, CircleMemberStatus.REJECTED] as const)(
    'rejects %s membership',
    async (status) => {
      await prisma.circleMember.create({
        data: { userID: signerId, circleID: secondaryCircleId, status },
      });

      await expectPostNotFound(service.signupForPost(signerId, postId));
    },
  );

  it('rejects membership only in a deleted or unlinked circle', async () => {
    await prisma.circleMember.createMany({
      data: [
        {
          userID: signerId,
          circleID: primaryCircleId,
          status: CircleMemberStatus.ACTIVE,
        },
        {
          userID: signerId,
          circleID: unrelatedCircleId,
          status: CircleMemberStatus.ACTIVE,
        },
      ],
    });

    await expectPostNotFound(service.signupForPost(signerId, postId));
  });

  it('keeps an existing signup idempotent after membership loss', async () => {
    await prisma.circleMember.create({
      data: {
        userID: signerId,
        circleID: secondaryCircleId,
        status: CircleMemberStatus.ACTIVE,
      },
    });
    await service.signupForPost(signerId, postId);
    await prisma.circleMember.update({
      where: {
        userID_circleID: {
          userID: signerId,
          circleID: secondaryCircleId,
        },
      },
      data: { status: CircleMemberStatus.PENDING },
    });

    await expect(service.signupForPost(signerId, postId)).resolves.toEqual({
      signed: true,
      signupCount: 1,
    });
    await expect(
      prisma.circlePostSignup.count({
        where: { postID: postId, userID: signerId },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.circlePost.findUnique({ where: { id: postId } }),
    ).resolves.toMatchObject({ signupCount: 1 });
  });
});

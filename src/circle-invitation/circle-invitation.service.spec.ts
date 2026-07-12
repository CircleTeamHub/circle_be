import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { OpenimService } from 'src/openim/openim.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { NotificationService } from 'src/notification/notification.service';
import { CircleInvitationService } from './circle-invitation.service';

describe('CircleInvitationService', () => {
  let service: CircleInvitationService;

  const prisma = {
    circleInvitation: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    circleInvitationVerifier: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    circleMember: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    notification: {
      create: jest.fn(),
    },
    circle: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    friend: {
      findFirst: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (input: any) => input(prisma)),
  };

  const openimService = {
    addGroupMembers: jest.fn(),
  };

  const realtimeService = {
    broadcastInteractionUnread: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    broadcastCircleInvitationReviewed: jest.fn(),
  };
  const privacySettings = {
    canBeInvitedToGroupOrCircle: jest.fn(),
  };
  const notificationService = {
    createCircleInvitationNotification: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (input: any) => input(prisma));
    privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(true);
    notificationService.createCircleInvitationNotification.mockReset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircleInvitationService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpenimService, useValue: openimService },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: PrivacySettingsService, useValue: privacySettings },
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    service = module.get(CircleInvitationService);
  });

  it('rejects invitation detail access for unrelated users', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      inviterID: 'inviter-1',
      requiredCount: 10,
      approvedCount: 1,
      status: 'PENDING',
      createdAt: new Date('2026-04-21T00:00:00.000Z'),
      circle: { id: 'circle-1', name: 'Trusted Circle' },
      applicant: {
        id: 'applicant-1',
        nickname: 'Applicant',
        avatarUrl: null,
        accountId: 'applicant',
      },
      inviter: {
        id: 'inviter-1',
        nickname: 'Inviter',
        avatarUrl: null,
        accountId: 'inviter',
      },
      verifiers: [],
    });
    prisma.circleMember.findUnique.mockResolvedValue(null);

    await expect(
      service.getInvitationForViewer('outsider-1', 'inv-1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects circle invites blocked by the applicant privacy setting', async () => {
    prisma.circleMember.findUnique
      .mockResolvedValueOnce({ status: 'ACTIVE' })
      .mockResolvedValueOnce(null);
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      maxMembers: null,
      memberCount: 1,
      joinVipRestriction: null,
      joinCreditRestriction: null,
      joinFancyRestriction: false,
    });
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 0,
      creditScore: 100,
      fancyNumber: false,
    });
    privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(false);

    await expect(
      service.invite('inviter-1', 'applicant-1', 'circle-1'),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('passes real friendship status to the invite privacy check (FRIENDS_ONLY)', async () => {
    prisma.circleMember.findUnique
      .mockResolvedValueOnce({ status: 'ACTIVE' })
      .mockResolvedValueOnce(null);
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      maxMembers: null,
      memberCount: 1,
      joinVipRestriction: null,
      joinCreditRestriction: null,
      joinFancyRestriction: false,
    });
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 0,
      creditScore: 100,
      fancyNumber: false,
    });
    // Inviter and applicant are accepted friends.
    prisma.friend.findFirst.mockResolvedValue({ userID: 'inviter-1' });
    // Block before the transaction so we only assert the privacy-check args.
    privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(false);

    await expect(
      service.invite('inviter-1', 'applicant-1', 'circle-1'),
    ).rejects.toThrow(ForbiddenException);

    expect(privacySettings.canBeInvitedToGroupOrCircle).toHaveBeenCalledWith(
      'applicant-1',
      true,
    );
  });

  it('rejects an invite when the applicant becomes active before the pair lock', async () => {
    prisma.circleMember.findUnique
      .mockResolvedValueOnce({ status: 'ACTIVE' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'ACTIVE' });
    prisma.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      deleted: false,
      maxMembers: null,
      memberCount: 1,
      joinVipRestriction: null,
      joinCreditRestriction: null,
      joinFancyRestriction: false,
    });
    prisma.user.findUnique.mockResolvedValue({
      vipLevel: 0,
      creditScore: 100,
      fancyNumber: false,
    });
    prisma.friend.findFirst.mockResolvedValue({ userID: 'inviter-1' });
    prisma.circleInvitation.findFirst.mockResolvedValue(null);
    prisma.circleInvitation.create.mockResolvedValue({ id: 'inv-new' });
    prisma.circleInvitationVerifier.create.mockResolvedValue({
      id: 'verifier-new',
    });
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-new',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      inviterID: 'inviter-1',
      requiredCount: 10,
      approvedCount: 1,
      status: 'PENDING',
      createdAt: new Date('2026-07-11T00:00:00.000Z'),
      circle: { id: 'circle-1', name: 'Circle' },
      applicant: {
        id: 'applicant-1',
        nickname: 'Applicant',
        avatarUrl: null,
        accountId: 'applicant',
      },
      inviter: {
        id: 'inviter-1',
        nickname: 'Inviter',
        avatarUrl: null,
        accountId: 'inviter',
      },
      verifiers: [],
    });

    await expect(
      service.invite('inviter-1', 'applicant-1', 'circle-1'),
    ).rejects.toThrow('already a member');

    expect(prisma.circleInvitation.create).not.toHaveBeenCalled();
  });

  it('queries only threshold-eligible invitations for reconciliation', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    prisma.circleInvitation.findMany.mockResolvedValue([]);

    await expect(service.reconcileApprovedInvitations()).resolves.toBe(0);

    expect(prisma.$queryRaw).toHaveBeenCalled();
    const query = prisma.$queryRaw.mock.calls[0][0].join(' ');
    expect(query).toContain('"approvedCount" >= "requiredCount"');
    expect(query).toContain('LIMIT 100');
    expect(prisma.circleInvitation.findMany).not.toHaveBeenCalled();
  });

  it('continues reconciliation after one candidate cannot be admitted', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'bad', circleID: 'circle-full', applicantID: 'user-bad' },
      { id: 'good', circleID: 'circle-open', applicantID: 'user-good' },
    ]);
    prisma.circleInvitation.findMany.mockResolvedValue([]);
    prisma.circleInvitation.findUnique
      .mockResolvedValueOnce({
        id: 'bad',
        circleID: 'circle-full',
        applicantID: 'user-bad',
        inviterID: 'inviter-1',
        status: 'PENDING',
        approvedCount: 1,
        requiredCount: 1,
        circle: { groupID: null },
      })
      .mockResolvedValueOnce({
        id: 'good',
        circleID: 'circle-open',
        applicantID: 'user-good',
        inviterID: 'inviter-1',
        status: 'PENDING',
        approvedCount: 1,
        requiredCount: 1,
        circle: { groupID: null },
      });
    prisma.circleInvitation.updateMany.mockResolvedValue({ count: 1 });
    prisma.circleMember.findUnique.mockResolvedValue(null);
    prisma.circle.findUnique
      .mockResolvedValueOnce({ maxMembers: 1, memberCount: 1 })
      .mockResolvedValueOnce({ maxMembers: 2, memberCount: 0 });
    prisma.circleMember.create.mockResolvedValue({ id: 'member-good' });
    prisma.circle.update.mockResolvedValue({});
    notificationService.createCircleInvitationNotification.mockResolvedValue(
      null,
    );

    await expect(service.reconcileApprovedInvitations()).resolves.toBe(1);

    expect(prisma.circleInvitation.findUnique).toHaveBeenCalledWith({
      where: { id: 'good' },
      include: { circle: true },
    });
  });

  it('hides cancelled invitations from pending verifier work', async () => {
    prisma.circleInvitation.findMany.mockResolvedValue([]);

    await service.getMyPendingVerifications('verifier-1');

    expect(prisma.circleInvitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING',
          verifiers: {
            some: { verifierID: 'verifier-1', status: 'PENDING' },
          },
        },
      }),
    );
  });

  it('addVerifier sends a circle-verification interaction message', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      status: 'PENDING',
      requiredCount: 10,
      verifiers: [],
    });
    prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    notificationService.createCircleInvitationNotification.mockResolvedValue({
      id: 'notification-1',
      type: 'CIRCLE_VERIFICATION_REQUESTED',
      content: '',
      read: false,
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      fromUser: { id: 'applicant-1', nickname: 'Applicant', avatarUrl: null },
      fromTrace: null,
      fromReply: null,
      fromCircle: { id: 'circle-1', name: 'Circle' },
      fromInvitation: { id: 'inv-1', status: 'PENDING' },
    });

    await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');

    expect(
      notificationService.createCircleInvitationNotification,
    ).toHaveBeenCalledWith({
      toUserID: 'verifier-9',
      fromUserID: 'applicant-1',
      type: 'CIRCLE_VERIFICATION_REQUESTED',
      fromCircleID: 'circle-1',
      fromInvitationID: 'inv-1',
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(realtimeService.broadcastInteractionUnread).toHaveBeenCalledWith(
      'verifier-9',
    );
    expect(realtimeService.broadcastNotificationCreated).toHaveBeenCalledWith(
      'verifier-9',
      expect.objectContaining({
        type: 'CIRCLE_VERIFICATION_REQUESTED',
        fromInvitation: expect.objectContaining({ id: 'inv-1' }),
      }),
    );
  });

  it('does not fail addVerifier when notification delivery fails', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      status: 'PENDING',
      requiredCount: 10,
      verifiers: [],
    });
    prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    notificationService.createCircleInvitationNotification.mockRejectedValue(
      new Error('notification unavailable'),
    );

    await expect(
      service.addVerifier('applicant-1', 'inv-1', 'verifier-9'),
    ).resolves.toBeUndefined();

    expect(prisma.circleInvitationVerifier.create).toHaveBeenCalledWith({
      data: {
        invitationID: 'inv-1',
        verifierID: 'verifier-9',
        addedByID: 'applicant-1',
        status: 'PENDING',
      },
    });
  });
});

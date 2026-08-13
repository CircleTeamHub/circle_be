import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CircleInvitationErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { NotificationService } from 'src/notification/notification.service';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { ChatCircleSyncService } from 'src/chat/chat-circle-sync.service';
import { ChatService } from 'src/chat/chat.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import { CircleInvitationService } from './circle-invitation.service';

// 卡片签发已从请求路径脱钩(不能让聊天投递挡住 add-verifier 的响应),
// 所以断言之前要把这一拍排空。
const flush = () => new Promise((resolve) => setImmediate(resolve));

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
      updateMany: jest.fn(),
    },
    circleMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
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
      findMany: jest.fn(),
    },
    friend: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    block: {
      findFirst: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (input: any) => input(prisma)),
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
  const admissionPolicy = {
    assertCanApply: jest.fn(),
    activateMembers: jest.fn(),
  };
  const memberLock = { lock: jest.fn(), lockPolicy: jest.fn() };
  const chatCircleSync = { ensureCircleConversation: jest.fn() };
  const chatService = {
    ensureDirectConversationForSettlement: jest.fn(),
    getOrCreateDirectConversation: jest.fn(),
  };
  const chatMessages = { insertServerMessage: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation(async (input: any) => input(prisma));
    privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(true);
    notificationService.createCircleInvitationNotification.mockReset();
    admissionPolicy.assertCanApply.mockResolvedValue(undefined);
    admissionPolicy.activateMembers.mockResolvedValue(['applicant-1']);
    chatCircleSync.ensureCircleConversation.mockResolvedValue('conv-1');
    chatService.ensureDirectConversationForSettlement.mockResolvedValue('dm-1');
    chatService.getOrCreateDirectConversation.mockResolvedValue({ id: 'dm-1' });
    chatMessages.insertServerMessage.mockResolvedValue({ id: 'msg-1' });
    // 验证人资格 = 好友 ∩ 本圈 ACTIVE 成员。既有用例大多只关心成员那一半,
    // 这里给好友那一半一个成立的默认值,想测反例的用例自己覆写成 null。
    prisma.friend.findFirst.mockResolvedValue({ userID: 'applicant-1' });
    prisma.block.findFirst.mockResolvedValue(null);
    // invite 事务里读的是 tx.block(与 prisma 同一份桩,见 $transaction 的实现)。

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CircleInvitationService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: PrivacySettingsService, useValue: privacySettings },
        { provide: NotificationService, useValue: notificationService },
        { provide: CircleAdmissionPolicy, useValue: admissionPolicy },
        { provide: CircleMemberLockService, useValue: memberLock },
        { provide: ChatCircleSyncService, useValue: chatCircleSync },
        { provide: ChatService, useValue: chatService },
        { provide: ChatSystemMessageService, useValue: chatMessages },
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
    prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
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

    expect(admissionPolicy.assertCanApply).not.toHaveBeenCalled();
    expect(prisma.circleInvitation.create).not.toHaveBeenCalled();
  });

  it('locks inviter and applicant before authorizing invitation creation', async () => {
    prisma.circleMember.findUnique.mockImplementation(({ where }: any) =>
      where.userID_circleID.userID === 'inviter-1'
        ? { status: 'ACTIVE', role: 'MEMBER' }
        : null,
    );
    // invite 事务内多了圈子策略读(requiredVerifierCount / memberCanInvite)。
    prisma.circle.findFirst.mockResolvedValue({
      requiredVerifierCount: 10,
      memberCanInvite: true,
    });
    prisma.circleInvitation.findFirst.mockResolvedValue(null);
    prisma.circleInvitation.create.mockResolvedValue({ id: 'inv-new' });
    prisma.circleInvitationVerifier.create.mockResolvedValue({ id: 'ver-new' });
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-new',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      inviterID: 'inviter-1',
      requiredCount: 10,
      approvedCount: 1,
      status: 'PENDING',
      createdAt: new Date('2026-07-22T00:00:00.000Z'),
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

    await service.invite('inviter-1', 'applicant-1', 'circle-1');

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'inviter-1',
      'applicant-1',
    ]);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.circleMember.findUnique.mock.invocationCallOrder[0],
    );
    expect(prisma.circleInvitation.create).toHaveBeenCalledTimes(1);
  });

  it('rejects invitation creation when the locked inviter is no longer active', async () => {
    prisma.circleMember.findUnique.mockImplementation(({ where }: any) =>
      where.userID_circleID.userID === 'inviter-1'
        ? { status: 'PENDING', role: 'MEMBER' }
        : null,
    );

    await expect(
      service.invite('inviter-1', 'applicant-1', 'circle-1'),
    ).rejects.toThrow(ForbiddenException);

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'inviter-1',
      'applicant-1',
    ]);
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
    admissionPolicy.activateMembers
      .mockRejectedValueOnce(new BadRequestException('circle full'))
      .mockResolvedValueOnce(['user-good']);
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { id: 'bad', circleID: 'circle-full', applicantID: 'user-bad' },
        { id: 'good', circleID: 'circle-open', applicantID: 'user-good' },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'circle-open' }]);
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
    prisma.circle.findUnique.mockResolvedValue({ id: 'circle-full' });
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
    // The permanently-blocked 'bad' row is deferred (touched) so it rotates to
    // the back of the updatedAt-ordered batch instead of re-filling it forever.
    expect(prisma.circleInvitation.updateMany).toHaveBeenCalledWith({
      where: { id: 'bad', status: 'PENDING' },
      data: { status: 'PENDING' },
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

  it('paginates verifier work with a caller-scoped keyset cursor', async () => {
    const cursor = '11111111-1111-4111-8111-111111111111';
    const createdAt = new Date('2026-07-16T10:00:00.000Z');
    prisma.circleInvitation.findFirst.mockResolvedValue({ createdAt });
    prisma.circleInvitation.findMany.mockResolvedValue([]);

    await service.getMyPendingVerifications('verifier-1', {
      cursor,
      limit: 20,
    });

    expect(prisma.circleInvitation.findFirst).toHaveBeenCalledWith({
      where: {
        id: cursor,
        verifiers: { some: { verifierID: 'verifier-1' } },
      },
      select: { createdAt: true },
    });
    expect(prisma.circleInvitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              status: 'PENDING',
              verifiers: {
                some: { verifierID: 'verifier-1', status: 'PENDING' },
              },
            },
            {
              OR: [
                { createdAt: { lt: createdAt } },
                { createdAt, id: { lt: cursor } },
              ],
            },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
      }),
    );
  });

  it('rejects a pending-list cursor outside the caller scope', async () => {
    prisma.circleInvitation.findFirst.mockResolvedValue(null);

    await expect(
      service.getMyApplications('applicant-1', {
        cursor: '22222222-2222-4222-8222-222222222222',
        limit: 50,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.circleInvitation.findMany).not.toHaveBeenCalled();
  });

  it('uses stable default pagination for a circle after checking admin access', async () => {
    prisma.circleMember.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      role: 'ADMIN',
    });
    prisma.circleInvitation.findMany.mockResolvedValue([]);

    await service.getPendingInvitationsForCircle('admin-1', 'circle-1');

    expect(prisma.circleInvitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { circleID: 'circle-1', status: 'PENDING' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
      }),
    );
  });

  // Regression: leaveCircle / removeGroupMember delete the membership but keep
  // the verifier row, so a departed member could still cast a binding vote.
  it('rejects a respond() vote from a verifier who left the circle', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      status: 'PENDING',
      circle: { id: 'circle-1', groupID: 'group-1' },
    });
    prisma.circleInvitationVerifier.findFirst.mockResolvedValue({
      id: 'ver-1',
      invitationID: 'inv-1',
      verifierID: 'verifier-1',
      status: 'PENDING',
    });
    // Membership row is gone: they left or were removed.
    prisma.circleMember.findUnique.mockResolvedValue(null);

    await expect(service.respond('verifier-1', 'inv-1', true)).rejects.toThrow(
      ForbiddenException,
    );

    expect(prisma.circleInvitationVerifier.update).not.toHaveBeenCalled();
    expect(prisma.circleInvitation.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a respond() vote from a verifier whose membership is no longer active', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      status: 'PENDING',
      circle: { id: 'circle-1', groupID: 'group-1' },
    });
    prisma.circleInvitationVerifier.findFirst.mockResolvedValue({
      id: 'ver-1',
      invitationID: 'inv-1',
      verifierID: 'verifier-1',
      status: 'PENDING',
    });
    prisma.circleMember.findUnique.mockResolvedValue({ status: 'PENDING' });

    await expect(service.respond('verifier-1', 'inv-1', true)).rejects.toThrow(
      ForbiddenException,
    );

    expect(prisma.circleInvitationVerifier.update).not.toHaveBeenCalled();
  });

  it('accepts a respond() vote from a still-active verifier', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      inviterID: 'inviter-1',
      status: 'PENDING',
      approvedCount: 1,
      requiredCount: 10,
      circle: { id: 'circle-1', groupID: 'group-1' },
    });
    prisma.circleInvitationVerifier.findFirst.mockResolvedValue({
      id: 'ver-1',
      invitationID: 'inv-1',
      verifierID: 'verifier-1',
      status: 'PENDING',
    });
    prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.circleInvitationVerifier.update.mockResolvedValue({});
    prisma.circleInvitation.updateMany.mockResolvedValue({ count: 1 });

    await service.respond('verifier-1', 'inv-1', true);

    expect(prisma.circleInvitationVerifier.update).toHaveBeenCalledWith({
      where: { id: 'ver-1' },
      data: expect.objectContaining({ status: 'APPROVED' }),
    });
  });

  it('locks the applicant globally before final verifier-approved activation', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      inviterID: 'inviter-1',
      status: 'PENDING',
      approvedCount: 10,
      requiredCount: 10,
      circle: { id: 'circle-1', groupID: 'group-1' },
    });
    prisma.circleInvitationVerifier.findFirst.mockResolvedValue({
      id: 'ver-1',
      status: 'PENDING',
    });
    prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.circleInvitation.updateMany.mockResolvedValue({ count: 1 });

    await service.respond('verifier-1', 'inv-1', true);

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'verifier-1',
      'applicant-1',
    ]);
    expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
      prisma,
      'circle-1',
      ['applicant-1'],
      { locksHeld: true, actor: 'third-party' },
    );
    // 座位不等对账:激活提交后立刻触发一次幂等 ensure。
    expect(chatCircleSync.ensureCircleConversation).toHaveBeenCalledWith(
      'circle-1',
    );
  });

  it('uses the admission policy for admin-approved activation', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      inviterID: 'inviter-1',
      status: 'PENDING',
      circle: { groupID: 'group-1' },
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      role: 'ADMIN',
    });
    prisma.circleInvitation.updateMany.mockResolvedValue({ count: 1 });

    await service.adminApprove('admin-1', 'inv-1');

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'admin-1',
      'applicant-1',
    ]);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.circleMember.findUnique.mock.invocationCallOrder[0],
    );
    expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
      prisma,
      'circle-1',
      ['applicant-1'],
      { locksHeld: true, actor: 'third-party' },
    );
    // 座位不等对账:激活提交后立刻触发一次幂等 ensure。
    expect(chatCircleSync.ensureCircleConversation).toHaveBeenCalledWith(
      'circle-1',
    );
  });

  it('uses the admission policy when reconciling a threshold-approved invitation', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'inv-1', circleID: 'circle-1', applicantID: 'applicant-1' },
    ]);
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      inviterID: 'inviter-1',
      status: 'PENDING',
      approvedCount: 10,
      requiredCount: 10,
      circle: { groupID: 'group-1' },
    });
    prisma.circleInvitation.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.reconcileApprovedInvitations()).resolves.toBe(1);

    expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
      prisma,
      'circle-1',
      ['applicant-1'],
      { locksHeld: true },
    );
    // 座位不等对账:激活提交后立刻触发一次幂等 ensure。
    expect(chatCircleSync.ensureCircleConversation).toHaveBeenCalledWith(
      'circle-1',
    );
  });

  it('does not reactivate an applicant from a cancelled invitation', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      status: 'CANCELLED',
      circle: { groupID: 'group-1' },
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      role: 'ADMIN',
    });

    await expect(service.adminApprove('admin-1', 'inv-1')).rejects.toThrow(
      BadRequestException,
    );

    expect(admissionPolicy.activateMembers).not.toHaveBeenCalled();
    expect(chatCircleSync.ensureCircleConversation).not.toHaveBeenCalled();
  });

  it('rejects admin approval when the locked admin was demoted', async () => {
    prisma.circleInvitation.findUnique.mockResolvedValue({
      id: 'inv-1',
      circleID: 'circle-1',
      applicantID: 'applicant-1',
      status: 'PENDING',
      circle: { groupID: 'group-1' },
    });
    prisma.circleMember.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      role: 'MEMBER',
    });

    await expect(service.adminApprove('admin-1', 'inv-1')).rejects.toThrow(
      ForbiddenException,
    );

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'admin-1',
      'applicant-1',
    ]);
    expect(prisma.circleInvitation.updateMany).not.toHaveBeenCalled();
    expect(admissionPolicy.activateMembers).not.toHaveBeenCalled();
    expect(chatCircleSync.ensureCircleConversation).not.toHaveBeenCalled();
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

    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'applicant-1',
      'verifier-9',
    ]);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.circleMember.findUnique.mock.invocationCallOrder[0],
    );
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

  // ─── 验证邀请卡片:服务端签发 ──────────────────────────────────────────────
  //
  // 卡片以前由 SelectVerifierScreen 在客户端发。verification-card 在后端的
  // SERVER_MESSAGE_TYPES 里(客户端能发 = 能凭空捏造「这人被邀请当验证人」),
  // 于是那次发送 100% 被 validateSendPayload 拒,还被 best-effort 的 catch 吞掉
  // —— 验证人从来收不到这张卡(与转账卡不同,这里连补偿 cron 都没有)。
  describe('verification card issuance', () => {
    function arrangeAddVerifier() {
      prisma.circleInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        circleID: 'circle-1',
        applicantID: 'applicant-1',
        status: 'PENDING',
        requiredCount: 10,
        verifiers: [],
      });
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      prisma.circle.findUnique.mockResolvedValue({ name: 'Trusted Circle' });
      prisma.user.findUnique.mockResolvedValue({ nickname: 'Applicant' });
      notificationService.createCircleInvitationNotification.mockResolvedValue(
        null,
      );
    }

    it('issues the card to the verifier once the invitation commits', async () => {
      arrangeAddVerifier();

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');
      await flush();

      // 会话是「申请人 → 验证人」的单聊,与客户端此前发卡的收件人一致。
      expect(chatService.getOrCreateDirectConversation).toHaveBeenCalledWith(
        'applicant-1',
        'verifier-9',
      );
      expect(chatMessages.insertServerMessage).toHaveBeenCalledWith('dm-1', {
        senderID: 'applicant-1',
        type: 'verification-card',
        content: {
          invitationId: 'inv-1',
          circleName: 'Trusted Circle',
          applicantName: 'Applicant',
        },
        clientMessageId: 'verification_card_inv-1_verifier-9',
        push: true,
      });
    });

    it('issues the card only after the invitation transaction commits', async () => {
      // 事务里签发的话:回滚掉的邀请已经把卡片广播出去了 —— 验证人点进去
      // 会看到一条并不存在的验证请求。
      arrangeAddVerifier();
      const order: string[] = [];
      prisma.$transaction.mockImplementation(async (input: any) => {
        const result = await input(prisma);
        order.push('commit');
        return result;
      });
      chatMessages.insertServerMessage.mockImplementation(async () => {
        order.push('card');
        return { id: 'msg-1' };
      });

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');
      await flush();

      expect(order).toEqual(['commit', 'card']);
    });

    it('does not fail addVerifier when card issuance fails', async () => {
      // 验证人席位已经落库了。为一张发不出去的卡把请求判失败,申请人会重试,
      // 而重试撞 (invitationID, verifierID) 唯一约束 → AlreadyVerifier 冲突,
      // 表现为「加不进去也取消不掉」。卡片是通知之外的第二条通道,可降级。
      arrangeAddVerifier();
      chatMessages.insertServerMessage.mockRejectedValue(
        new Error('chat down'),
      );

      await expect(
        service.addVerifier('applicant-1', 'inv-1', 'verifier-9'),
      ).resolves.toBeUndefined();

      expect(prisma.circleInvitationVerifier.create).toHaveBeenCalled();
    });

    it('keys the card on (invitation, verifier) so a retry cannot double-post', async () => {
      // 与 CircleInvitationVerifier 的 @@unique([invitationID, verifierID]) 同源:
      // 一个邀请里同一个验证人只可能有一席,卡片也就只该有一张。
      arrangeAddVerifier();

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');
      await flush();

      const [, input] = chatMessages.insertServerMessage.mock.calls[0] as [
        string,
        { clientMessageId: string },
      ];
      expect(input.clientMessageId).toBe('verification_card_inv-1_verifier-9');
    });

    it('never opens an unsolicited DM channel to deliver the card (P1)', async () => {
      // 加验证人只要求对方是圈子活跃成员,**不要求是好友**,而这一步是申请人
      // 主动挑人触发的。用结算专用解析会绕过对方的「接收陌生人消息」开关直接
      // 建出正常 DIRECT 会话 —— 那道闸全仓只在建会话时查一次、发送路径永不复查,
      // 于是 add-verifier 就成了任何人强开私聊通道的入口。
      arrangeAddVerifier();

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');
      await flush();

      expect(
        chatService.ensureDirectConversationForSettlement,
      ).not.toHaveBeenCalled();
      expect(chatService.getOrCreateDirectConversation).toHaveBeenCalledWith(
        'applicant-1',
        'verifier-9',
      );
    });

    it('treats a privacy refusal as terminal, not as a failure to retry', async () => {
      // 对方关了陌生人消息 = 隐私设置在正确地生效,不是故障。按失败处理会白烧
      // 12 次重试,最后还打一条「永久丢失、需人工介入」的 error 日志。
      arrangeAddVerifier();
      chatService.getOrCreateDirectConversation.mockRejectedValue(
        new ForbiddenException({ message: '对方不接收陌生人消息' }),
      );

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');
      await flush();

      expect(chatMessages.insertServerMessage).not.toHaveBeenCalled();
      // 终结这一席:补偿任务不再捡它。验证人照样能从站内通知与待验证列表看到请求。
      expect(prisma.circleInvitationVerifier.updateMany).toHaveBeenCalledWith({
        where: { invitationID: 'inv-1', verifierID: 'verifier-9' },
        data: { cardDeliveredAt: expect.any(Date) },
      });
    });

    it('returns even when the chat dependency never settles', async () => {
      // 席位与站内通知都已提交。挂住的话客户端超时重试会撞 AlreadyVerifier
      //(「加不进去也退不掉」),而补偿任务要等这个请求被放弃才轮得到。
      arrangeAddVerifier();
      chatMessages.insertServerMessage.mockImplementation(
        () => new Promise(() => undefined), // 永不兑现
      );

      await expect(
        service.addVerifier('applicant-1', 'inv-1', 'verifier-9'),
      ).resolves.toBeUndefined();

      expect(prisma.circleInvitationVerifier.create).toHaveBeenCalled();
    });

    it('marks the seat delivered when the inline issuance succeeds', async () => {
      arrangeAddVerifier();

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');
      await flush();

      expect(prisma.circleInvitationVerifier.updateMany).toHaveBeenCalledWith({
        where: { invitationID: 'inv-1', verifierID: 'verifier-9' },
        data: { cardDeliveredAt: expect.any(Date) },
      });
    });

    it('leaves the seat undelivered when issuance fails, for the sweep to pick up', async () => {
      arrangeAddVerifier();
      chatMessages.insertServerMessage.mockRejectedValue(
        new Error('chat down'),
      );

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');

      // 置位是补偿任务的唯一判据 —— 失败时绝不能置位,否则这张卡永久丢失。
      expect(prisma.circleInvitationVerifier.updateMany).not.toHaveBeenCalled();
    });

    it('still issues the card when the circle or applicant lookup comes back empty', async () => {
      // 名字只是卡面文案,取不到不该让整张卡消失 —— 卡片的实际价值是那个
      // invitationId 深链。
      arrangeAddVerifier();
      prisma.circle.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');
      await flush();

      expect(chatMessages.insertServerMessage).toHaveBeenCalledWith(
        'dm-1',
        expect.objectContaining({
          content: {
            invitationId: 'inv-1',
            circleName: '',
            applicantName: '',
          },
        }),
      );
    });
  });

  // ─── 验证卡片补偿 ─────────────────────────────────────────────────────────
  //
  // 席位提交之后卡片才签发,中间那一小段(圈子/用户查询、会话解析、消息写入)
  // 任何一步抖动都会让卡片丢掉 —— 而席位已经落库,申请人重试会撞
  // @@unique([invitationID, verifierID]) 变成 AlreadyVerifier,「加不进去也退不掉」。
  // 与转账卡同型的补偿:先抢占后外呼,幂等键让重复投递在唯一约束上合并。
  describe('sweepUndeliveredVerificationCards', () => {
    const now = new Date('2026-08-11T12:00:00.000Z');
    const seat = {
      id: 'seat-1',
      invitationID: 'inv-1',
      verifierID: 'verifier-9',
      addedByID: 'applicant-1',
      cardAttempts: 0,
      invitation: {
        circleID: 'circle-1',
        applicantID: 'applicant-1',
        circle: { name: 'Trusted Circle' },
        applicant: { nickname: 'Applicant' },
      },
    };

    function arrangeSweep({ seats = [seat], claimCount = 1 } = {}) {
      prisma.circleInvitationVerifier.findMany.mockResolvedValue(seats);
      prisma.circleInvitationVerifier.updateMany.mockResolvedValue({
        count: claimCount,
      });
    }

    it('claims the row BEFORE the send, then delivers exactly once', async () => {
      arrangeSweep();

      const delivered = await service.sweepUndeliveredVerificationCards(now);

      expect(delivered).toBe(1);
      // 抢占:条件 updateMany(仍未送达 + attempts 没被别人动过)。多副本同时
      // 扫表时输家 count=0 直接跳过,不会出现「发完才发现别人已置位」的窗口。
      expect(
        prisma.circleInvitationVerifier.updateMany,
      ).toHaveBeenNthCalledWith(1, {
        where: {
          id: 'seat-1',
          // 扫表与抢占之间 respond / adminApprove / reconcile 都可能把席位或
          // 父邀请落成终态,抢占必须把资格条件一起复查,而不是只 CAS attempts。
          status: 'PENDING',
          invitation: { is: { status: 'PENDING' } },
          cardDeliveredAt: null,
          cardAttempts: 0,
        },
        data: { cardAttempts: { increment: 1 } },
      });
      const claimOrder =
        prisma.circleInvitationVerifier.updateMany.mock.invocationCallOrder[0];
      const sendOrder =
        chatMessages.insertServerMessage.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(sendOrder);

      // 与 inline 签发同键 —— 两条路径撞唯一约束时合并,验证人只看到一张卡。
      expect(chatMessages.insertServerMessage).toHaveBeenCalledWith('dm-1', {
        senderID: 'applicant-1',
        type: 'verification-card',
        content: {
          invitationId: 'inv-1',
          circleName: 'Trusted Circle',
          applicantName: 'Applicant',
        },
        clientMessageId: 'verification_card_inv-1_verifier-9',
        push: true,
      });
    });

    it('skips the row when another replica already claimed it', async () => {
      arrangeSweep({ claimCount: 0 });

      const delivered = await service.sweepUndeliveredVerificationCards(now);

      expect(delivered).toBe(0);
      expect(chatMessages.insertServerMessage).not.toHaveBeenCalled();
    });

    it('never sweeps the auto-approved inviter seat', async () => {
      // invite() 把邀请人自己记成 APPROVED 的那一席,cardDeliveredAt 同样为空 ——
      // 不按 status 过滤的话,每个邀请人都会收到一张凭空出现的「请你验证」卡。
      arrangeSweep();

      await service.sweepUndeliveredVerificationCards(now);

      const [args] = prisma.circleInvitationVerifier.findMany.mock.calls[0];
      expect(args.where.status).toBe('PENDING');
    });

    it('never resends a card for an invitation that is no longer pending', async () => {
      // adminApprove / reconcileApprovedInvitations 把邀请落成 ADMIN_APPROVED /
      // APPROVED 时不动席位行 —— 只看席位状态的话会补出一张过期卡,
      // 验证人点进去只会拿到 NotPending。
      arrangeSweep();

      await service.sweepUndeliveredVerificationCards(now);

      const [args] = prisma.circleInvitationVerifier.findMany.mock.calls[0];
      expect(args.where.invitation).toEqual({ is: { status: 'PENDING' } });
    });

    it('only looks at seats past the grace period', async () => {
      // 宽限期内 inline 签发可能还在飞 —— 立刻补投等于和它自己抢。
      arrangeSweep();

      await service.sweepUndeliveredVerificationCards(now);

      const [args] = prisma.circleInvitationVerifier.findMany.mock.calls[0];
      expect(args.where.cardDeliveredAt).toBeNull();
      expect(args.where.createdAt.lt.getTime()).toBeLessThan(now.getTime());
    });

    it('settles the seat instead of retrying when the peer refuses (P1)', async () => {
      arrangeSweep();
      chatService.getOrCreateDirectConversation.mockRejectedValue(
        new ForbiddenException({ message: '对方不接收陌生人消息' }),
      );

      const delivered = await service.sweepUndeliveredVerificationCards(now);

      expect(delivered).toBe(0);
      // 抢占 + 终结,各一次;不应留在队列里反复重试。
      expect(
        prisma.circleInvitationVerifier.updateMany,
      ).toHaveBeenNthCalledWith(2, {
        where: { id: 'seat-1' },
        data: { cardDeliveredAt: expect.any(Date) },
      });
    });

    it('does not mark delivered when the send fails', async () => {
      arrangeSweep();
      chatMessages.insertServerMessage.mockRejectedValue(
        new Error('chat down'),
      );

      const delivered = await service.sweepUndeliveredVerificationCards(now);

      expect(delivered).toBe(0);
      // 只有抢占那一次 updateMany;置位的那次不能发生。
      expect(prisma.circleInvitationVerifier.updateMany).toHaveBeenCalledTimes(
        1,
      );
    });

    it('gives up loudly once attempts are exhausted', async () => {
      // 打光后这行会被查询永久排除 —— 必须留下 error 级日志,否则「卡片永久
      // 丢失」这件事在生产上没有任何信号。
      const warn = jest
        .spyOn(
          (service as never as { logger: { error: () => void } }).logger,
          'error',
        )
        .mockImplementation(() => undefined);
      arrangeSweep({ seats: [{ ...seat, cardAttempts: 35 }] });
      chatMessages.insertServerMessage.mockRejectedValue(
        new Error('chat down'),
      );

      await service.sweepUndeliveredVerificationCards(now);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('verification card PERMANENTLY failed'),
      );
      warn.mockRestore();
    });
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
  // ─── 验证人资格:好友 ∩ 本圈 ACTIVE 成员 ────────────────────────────────────
  //
  // 「成员」那一半一直有(加席查一次、投票再复查一次),「好友」那一半此前一处都
  // 没有 —— 错误码 VerifierNotFriend 只存在于枚举里,全仓零处 throw。于是这条
  // 规则只靠 SelectVerifierScreen 拉好友列表这个 UI 约定撑着:直接打
  // POST /circle-invitation/:id/add-verifier 就能把圈里任意 ACTIVE 成员塞成
  // 自己的验证人。这一组把交集的两半都钉在服务端。
  describe('verifier eligibility (friend ∩ active member)', () => {
    function arrangeRespondSeat() {
      prisma.circleInvitation.findUnique
        .mockResolvedValueOnce({
          circleID: 'circle-1',
          applicantID: 'applicant-1',
        })
        .mockResolvedValueOnce({
          id: 'inv-1',
          circleID: 'circle-1',
          applicantID: 'applicant-1',
          status: 'PENDING',
          requiredCount: 10,
          approvedCount: 1,
          circle: { id: 'circle-1', name: 'Circle' },
        });
      prisma.circleInvitationVerifier.findFirst.mockResolvedValue({
        id: 'seat-1',
        status: 'PENDING',
      });
    }

    function arrangePendingInvitation() {
      prisma.circleInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        circleID: 'circle-1',
        applicantID: 'applicant-1',
        status: 'PENDING',
        requiredCount: 10,
        verifiers: [],
      });
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    }

    it('addVerifier rejects an active member who is not the applicant friend', async () => {
      arrangePendingInvitation();
      prisma.friend.findFirst.mockResolvedValue(null);

      await expect(
        service.addVerifier('applicant-1', 'inv-1', 'verifier-9'),
      ).rejects.toMatchObject({
        response: {
          errorCode: CircleInvitationErrorCode.VerifierNotFriend,
        },
      });

      expect(prisma.circleInvitationVerifier.create).not.toHaveBeenCalled();
      expect(
        notificationService.createCircleInvitationNotification,
      ).not.toHaveBeenCalled();
      await flush();
      expect(chatMessages.insertServerMessage).not.toHaveBeenCalled();
    });

    it('addVerifier reads friendship inside the pair lock', async () => {
      arrangePendingInvitation();
      notificationService.createCircleInvitationNotification.mockResolvedValue({
        id: 'notification-1',
        type: 'CIRCLE_VERIFICATION_REQUESTED',
        content: '',
        read: false,
        createdAt: new Date('2026-08-12T00:00:00.000Z'),
        fromUser: { id: 'applicant-1', nickname: 'Applicant', avatarUrl: null },
        fromTrace: null,
        fromReply: null,
        fromCircle: { id: 'circle-1', name: 'Circle' },
        fromInvitation: { id: 'inv-1', status: 'PENDING' },
      });

      await service.addVerifier('applicant-1', 'inv-1', 'verifier-9');

      // 与成员检查同一取向:好友关系也可能在这一拍被并发解除,读之前必须已经
      // 拿到这一对用户的锁,否则「解除好友」与「加席」会交叉通过。
      expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.friend.findFirst.mock.invocationCallOrder[0],
      );
      expect(prisma.friend.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            state: 'ACCEPTED',
            OR: [
              { userID: 'applicant-1', friendID: 'verifier-9' },
              { userID: 'verifier-9', friendID: 'applicant-1' },
            ],
          }),
        }),
      );
    });

    it('respond rejects a verifier who is no longer the applicant friend', async () => {
      prisma.circleInvitation.findUnique
        .mockResolvedValueOnce({
          circleID: 'circle-1',
          applicantID: 'applicant-1',
        })
        .mockResolvedValueOnce({
          id: 'inv-1',
          circleID: 'circle-1',
          applicantID: 'applicant-1',
          status: 'PENDING',
          requiredCount: 10,
          approvedCount: 1,
          circle: { id: 'circle-1', name: 'Circle' },
        });
      prisma.circleInvitationVerifier.findFirst.mockResolvedValue({
        id: 'seat-1',
        status: 'PENDING',
      });
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      // 加席时是好友,投票前解除了 —— 与「加席后退圈」同一形状,资格必须在
      // 投票这一刻重算,不能信加席那次检查。
      prisma.friend.findFirst.mockResolvedValue(null);

      await expect(
        service.respond('verifier-9', 'inv-1', true),
      ).rejects.toMatchObject({
        response: {
          errorCode: CircleInvitationErrorCode.VerifierNotFriend,
        },
      });

      expect(prisma.circleInvitationVerifier.update).not.toHaveBeenCalled();
      expect(prisma.circleInvitation.updateMany).not.toHaveBeenCalled();
    });

    // 闸只对「同意」设。挡掉拒绝的话那一席永远 PENDING 且计入 activeSlots ——
    // 本仓既没有撤销验证人的接口、PENDING 担保单也不会过期,申请人补不上人、
    // 也永远凑不满票,整单卡死到管理员来兜底。
    it('respond lets a verifier who lost eligibility still reject, freeing the seat', async () => {
      arrangeRespondSeat();
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      prisma.friend.findFirst.mockResolvedValue(null);

      await expect(
        service.respond('verifier-9', 'inv-1', false),
      ).resolves.toBeUndefined();

      expect(prisma.circleInvitationVerifier.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'seat-1' },
          data: expect.objectContaining({ status: 'REJECTED' }),
        }),
      );
      // 反对票不加票数,只把席位让出来。
      expect(prisma.circleInvitation.updateMany).not.toHaveBeenCalled();
    });

    it('respond lets a verifier who left the circle still reject', async () => {
      arrangeRespondSeat();
      prisma.circleMember.findUnique.mockResolvedValue(null);
      prisma.friend.findFirst.mockResolvedValue({ userID: 'applicant-1' });

      await expect(
        service.respond('verifier-9', 'inv-1', false),
      ).resolves.toBeUndefined();

      expect(prisma.circleInvitationVerifier.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'REJECTED' }),
        }),
      );
    });

    it('respond still blocks approval from a verifier who left the circle', async () => {
      arrangeRespondSeat();
      prisma.circleMember.findUnique.mockResolvedValue(null);
      prisma.friend.findFirst.mockResolvedValue({ userID: 'applicant-1' });

      await expect(
        service.respond('verifier-9', 'inv-1', true),
      ).rejects.toMatchObject({
        response: {
          errorCode: CircleInvitationErrorCode.VerifierNotMember,
        },
      });
      expect(prisma.circleInvitationVerifier.update).not.toHaveBeenCalled();
    });
  });

  // 选人页此前拉的是**全部好友**,不在圈里的也照列 —— 点下去才被服务端打回。
  // 资格规则归服务端所有,列表也就该由服务端算好再给,前端不做集合运算。
  describe('getEligibleVerifiers', () => {
    function arrangeInvitation(overrides = {}) {
      prisma.circleInvitation.findUnique.mockResolvedValue({
        id: 'inv-1',
        circleID: 'circle-1',
        applicantID: 'applicant-1',
        status: 'PENDING',
        requiredCount: 10,
        verifiers: [
          { verifierID: 'inviter-1', status: 'APPROVED' },
          { verifierID: 'verifier-rejected', status: 'REJECTED' },
        ],
        ...overrides,
      });
    }

    // 成员查询只取 id;profile 在交集之后单独 hydrate。
    function member(id: string) {
      return { userID: id };
    }

    function profile(id: string) {
      return {
        id,
        nickname: `nick-${id}`,
        avatarUrl: null,
        accountId: `acct-${id}`,
      };
    }

    it('returns active circle members who are also friends', async () => {
      arrangeInvitation();
      prisma.circleMember.findMany.mockResolvedValue([
        member('friend-member'),
        member('stranger-member'),
      ]);
      prisma.friend.findMany.mockResolvedValue([
        { userID: 'applicant-1', friendID: 'friend-member' },
        // 反向存储的好友行也算,friend 表一对只有一行。
        { userID: 'friend-elsewhere', friendID: 'applicant-1' },
      ]);
      prisma.user.findMany.mockResolvedValue([profile('friend-member')]);

      const result = await service.getEligibleVerifiers('applicant-1', 'inv-1');

      // 只为交集付 hydration,不是把全圈成员的资料先拉一遍再过滤。
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['friend-member'] } },
        }),
      );

      expect(result).toEqual([
        {
          id: 'friend-member',
          nickname: 'nick-friend-member',
          avatarUrl: null,
          accountId: 'acct-friend-member',
        },
      ]);
      // 已占席的(含 REJECTED —— addVerifier 的 AlreadyVerifier 不看状态)
      // 和申请人自己都不该再出现在候选里。
      expect(prisma.circleMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            circleID: 'circle-1',
            status: 'ACTIVE',
            userID: {
              notIn: ['inviter-1', 'verifier-rejected', 'applicant-1'],
            },
          }),
        }),
      );
    });

    it('returns an empty list without querying friends when no member is left', async () => {
      arrangeInvitation();
      prisma.circleMember.findMany.mockResolvedValue([]);

      await expect(
        service.getEligibleVerifiers('applicant-1', 'inv-1'),
      ).resolves.toEqual([]);
      expect(prisma.friend.findMany).not.toHaveBeenCalled();
    });

    it('returns an empty list once every slot is filled', async () => {
      arrangeInvitation({
        requiredCount: 1,
        verifiers: [{ verifierID: 'inviter-1', status: 'APPROVED' }],
      });

      await expect(
        service.getEligibleVerifiers('applicant-1', 'inv-1'),
      ).resolves.toEqual([]);
      expect(prisma.circleMember.findMany).not.toHaveBeenCalled();
    });

    it('rejects a caller who is not the applicant', async () => {
      arrangeInvitation();

      await expect(
        service.getEligibleVerifiers('someone-else', 'inv-1'),
      ).rejects.toMatchObject({
        response: { errorCode: CircleInvitationErrorCode.ApplicantOnly },
      });
      expect(prisma.circleMember.findMany).not.toHaveBeenCalled();
    });

    it('rejects a settled invitation', async () => {
      arrangeInvitation({ status: 'APPROVED' });

      await expect(
        service.getEligibleVerifiers('applicant-1', 'inv-1'),
      ).rejects.toMatchObject({
        response: { errorCode: CircleInvitationErrorCode.NotPending },
      });
      expect(prisma.circleMember.findMany).not.toHaveBeenCalled();
    });
  });
  // ─── 宣传期招新策略:requiredVerifierCount 快照 + memberCanInvite 闸 ────────
  //
  // 宣传期把圈子的 requiredVerifierCount 设为 1:成员邀请自动带首票,建单即满
  // → 立即入圈;后期收紧改回 10 就恢复满员担保。担保单存的是**建单那一刻的快照**,
  // 调整策略不影响在途申请。memberCanInvite=false 时普通成员的邀请入口关闭,
  // 只留圈主/管理员 —— 「只有管理员拉人进来才能进」的严格形态。
  describe('promotional admission policy', () => {
    function arrangeInviteFlow(
      params: {
        inviterRole?: string;
        circle?: Record<string, unknown>;
        created?: Record<string, unknown>;
      } = {},
    ) {
      prisma.circleMember.findUnique.mockImplementation(({ where }: any) =>
        where.userID_circleID.userID === 'inviter-1'
          ? { status: 'ACTIVE', role: params.inviterRole ?? 'MEMBER' }
          : null,
      );
      prisma.circle.findFirst.mockResolvedValue({
        requiredVerifierCount: 10,
        memberCanInvite: true,
        ...params.circle,
      });
      prisma.circleInvitation.findFirst.mockResolvedValue(null);
      prisma.circleInvitation.create.mockResolvedValue({
        id: 'inv-new',
        circleID: 'circle-1',
        applicantID: 'applicant-1',
        inviterID: 'inviter-1',
        requiredCount: 10,
        approvedCount: 1,
        status: 'PENDING',
        circle: { id: 'circle-1', name: 'Circle', groupID: 'circle-1' },
        ...params.created,
      });
      prisma.circleInvitationVerifier.create.mockResolvedValue({
        id: 'ver-new',
      });
      // 收尾的 fetchInvitationDto 读。
      prisma.circleInvitation.findUnique.mockResolvedValue({
        id: 'inv-new',
        circleID: 'circle-1',
        applicantID: 'applicant-1',
        inviterID: 'inviter-1',
        requiredCount: 10,
        approvedCount: 1,
        status: 'PENDING',
        createdAt: new Date('2026-08-12T00:00:00.000Z'),
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
    }

    it('invite snapshots the circle requiredVerifierCount into the invitation', async () => {
      arrangeInviteFlow({ circle: { requiredVerifierCount: 10 } });

      await service.invite('inviter-1', 'applicant-1', 'circle-1');

      expect(prisma.circleInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ requiredCount: 10 }),
        }),
      );
      expect(admissionPolicy.activateMembers).not.toHaveBeenCalled();
      expect(
        realtimeService.broadcastCircleInvitationReviewed,
      ).not.toHaveBeenCalled();
    });

    it('invite admits immediately when the inviter first vote satisfies the policy', async () => {
      arrangeInviteFlow({
        circle: { requiredVerifierCount: 1 },
        created: { requiredCount: 1 },
      });
      notificationService.createCircleInvitationNotification.mockResolvedValue({
        id: 'notification-1',
        type: 'CIRCLE_INVITATION_APPROVED',
        content: '',
        read: false,
        createdAt: new Date('2026-08-12T00:00:00.000Z'),
        fromUser: { id: 'inviter-1', nickname: 'Inviter', avatarUrl: null },
        fromTrace: null,
        fromReply: null,
        fromCircle: { id: 'circle-1', name: 'Circle' },
        fromInvitation: { id: 'inv-new', status: 'APPROVED' },
      });

      await service.invite('inviter-1', 'applicant-1', 'circle-1');

      expect(prisma.circleInvitation.update).toHaveBeenCalledWith({
        where: { id: 'inv-new' },
        data: { status: 'APPROVED' },
      });
      expect(admissionPolicy.activateMembers).toHaveBeenCalledWith(
        prisma,
        'circle-1',
        ['applicant-1'],
        { locksHeld: true, actor: 'third-party' },
      );
      // 席位同步 + 申请人通知 + 实时广播,与 respond 的满票收尾同一套。
      expect(chatCircleSync.ensureCircleConversation).toHaveBeenCalledWith(
        'circle-1',
      );
      expect(
        notificationService.createCircleInvitationNotification,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          toUserID: 'applicant-1',
          fromUserID: 'inviter-1',
          type: 'CIRCLE_INVITATION_APPROVED',
        }),
      );
      expect(
        realtimeService.broadcastCircleInvitationReviewed,
      ).toHaveBeenCalledWith('applicant-1', {
        invitationId: 'inv-new',
        circleId: 'circle-1',
        status: 'APPROVED',
      });
    });

    // 自动首票 = 邀请人替被邀请人担保,资格与申请人自己挑的验证人同规,
    // 否则「验证人必须是好友」这条闸从 invite 这条路整条绕过去。
    it('invite withholds the first vote when a plain member is not the friend', async () => {
      arrangeInviteFlow({
        circle: { requiredVerifierCount: 1 },
        created: { requiredCount: 1, approvedCount: 0 },
      });
      prisma.friend.findFirst.mockResolvedValue(null);
      privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(true);

      await service.invite('inviter-1', 'applicant-1', 'circle-1');

      expect(prisma.circleInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ approvedCount: 0 }),
        }),
      );
      expect(prisma.circleInvitationVerifier.create).not.toHaveBeenCalled();
      // 没有首票就没满票:陌生人不会被瞬间塞进圈子。
      expect(admissionPolicy.activateMembers).not.toHaveBeenCalled();
    });

    it('invite keeps the first vote for a non-friend owner or admin', async () => {
      arrangeInviteFlow({
        circle: { requiredVerifierCount: 10 },
        inviterRole: 'ADMIN',
      });
      prisma.friend.findFirst.mockResolvedValue(null);
      privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(true);

      await service.invite('inviter-1', 'applicant-1', 'circle-1');

      expect(prisma.circleInvitation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ approvedCount: 1 }),
        }),
      );
      expect(prisma.circleInvitationVerifier.create).toHaveBeenCalledTimes(1);
    });

    // 隐私开关只看 groupInvitePermission 与好友关系,默认 EVERYONE 之下
    // 被拉黑的人照样拉得动对方 —— 而管理员例外 + requiredVerifierCount=1
    // 时那是「立刻入圈」。
    it('invite refuses when either side has blocked the other', async () => {
      for (const block of [
        { blockerID: 'applicant-1', blockedID: 'inviter-1' },
        { blockerID: 'inviter-1', blockedID: 'applicant-1' },
      ]) {
        jest.clearAllMocks();
        arrangeInviteFlow({
          inviterRole: 'ADMIN',
          circle: { requiredVerifierCount: 1 },
          created: { requiredCount: 1 },
        });
        privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(true);
        prisma.friend.findFirst.mockResolvedValue({ userID: 'applicant-1' });
        prisma.block.findFirst.mockResolvedValue(block);

        await expect(
          service.invite('inviter-1', 'applicant-1', 'circle-1'),
        ).rejects.toMatchObject({
          response: { errorCode: CircleInvitationErrorCode.NotAllowed },
        });
        expect(prisma.circleInvitation.create).not.toHaveBeenCalled();
        expect(admissionPolicy.activateMembers).not.toHaveBeenCalled();
      }
    });

    // 拉黑判定排在成员校验之前的话,任何登录用户都能拿这个接口当拉黑探针:
    // 被拉黑返回 NotAllowed、没拉黑返回 InviterNotMember,两者可分。
    it('does not let a non-member distinguish a block from the membership error', async () => {
      for (const block of [null, { blockerID: 'applicant-1' }]) {
        jest.clearAllMocks();
        arrangeInviteFlow();
        privacySettings.canBeInvitedToGroupOrCircle.mockResolvedValue(true);
        prisma.friend.findFirst.mockResolvedValue({ userID: 'applicant-1' });
        prisma.block.findFirst.mockResolvedValue(block);
        // 调用者根本不是本圈成员。
        prisma.circleMember.findUnique.mockResolvedValue(null);

        await expect(
          service.invite('stranger-1', 'applicant-1', 'circle-1'),
        ).rejects.toMatchObject({
          response: { errorCode: CircleInvitationErrorCode.InviterNotMember },
        });
      }
    });

    // 预检式的读拦不住「读完之后才拉黑」:必须在事务内读,让 Serializable 的
    // SSI 把它与并发的拉黑写判成冲突。
    it('reads the block relation inside the invitation transaction', async () => {
      arrangeInviteFlow();

      await service.invite('inviter-1', 'applicant-1', 'circle-1');

      expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.block.findFirst.mock.invocationCallOrder[0],
      );
    });

    // 成员锁是按 (circle, user) 对取的,与 PATCH /circle/:id 拿的那几把不相交,
    // 策略快照必须另有一把圈级锁,否则「收严已返回成功」之后还会放进来一个人。
    it('invite takes the circle policy lock before snapshotting the policy', async () => {
      arrangeInviteFlow();

      await service.invite('inviter-1', 'applicant-1', 'circle-1');

      expect(memberLock.lockPolicy).toHaveBeenCalledWith(prisma, 'circle-1');
      expect(memberLock.lockPolicy.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.circle.findFirst.mock.invocationCallOrder[0],
      );
    });

    it('invite rejects a plain member when memberCanInvite is off', async () => {
      arrangeInviteFlow({
        circle: { memberCanInvite: false },
        inviterRole: 'MEMBER',
      });

      await expect(
        service.invite('inviter-1', 'applicant-1', 'circle-1'),
      ).rejects.toMatchObject({
        response: {
          errorCode: CircleInvitationErrorCode.MemberInviteDisabled,
        },
      });
      expect(prisma.circleInvitation.create).not.toHaveBeenCalled();
    });

    it('invite keeps owner and admin invites when memberCanInvite is off', async () => {
      arrangeInviteFlow({
        circle: { memberCanInvite: false },
        inviterRole: 'ADMIN',
      });

      await service.invite('inviter-1', 'applicant-1', 'circle-1');

      expect(prisma.circleInvitation.create).toHaveBeenCalledTimes(1);
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FriendState, NotificationType, Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationService } from 'src/notification/notification.service';
import { OpenimService } from 'src/openim/openim.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { CreditService } from 'src/credit/credit.service';
import { SendFriendRequestDto } from './dto/friend.dto';
import { FriendController } from './friend.controller';
import { FriendService } from './friend.service';

describe('FriendService', () => {
  let service: FriendService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    block: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
    },
    friend: {
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    friendTag: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    friendTagOnFriend: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      upsert: jest.fn(),
    },
    pendingFriendTagOnRequest: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    friendActivity: {
      count: jest.fn(),
      createMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    friendReport: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    friendSyncOutbox: {
      createMany: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $transaction: jest.fn((operations: any) =>
      typeof operations === 'function'
        ? operations(prisma as any)
        : Promise.all(operations),
    ),
  };

  const realtimeService = {
    broadcastFriendUnreadCount: jest.fn(),
    broadcastInteractionUnread: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    broadcastUserProfileSummary: jest.fn(),
    invalidateUserProfileSummaryCache: jest.fn(),
    safeBroadcastAll: jest.fn(),
  };
  const notificationService = {
    createFriendRequestNotification: jest.fn(),
  };
  const openimService = {
    addBlacklist: jest.fn(),
    deleteFriend: jest.fn(),
    importFriends: jest.fn(),
    removeBlacklist: jest.fn(),
  };
  const privacySettings = {
    canReceiveStrangerMessage: jest.fn(),
  };
  const creditService = {
    applyDeltaInTransaction: jest.fn(),
    revertBySourceInTransaction: jest.fn(),
    broadcastCreditProfileChanged: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    for (const value of Object.values(prisma)) {
      if (jest.isMockFunction(value)) {
        value.mockReset();
      } else if (value && typeof value === 'object') {
        for (const nested of Object.values(value as Record<string, unknown>)) {
          if (jest.isMockFunction(nested)) {
            nested.mockReset();
          }
        }
      }
    }
    notificationService.createFriendRequestNotification.mockReset();
    for (const mock of Object.values(openimService)) {
      mock.mockReset();
      mock.mockResolvedValue(undefined);
    }
    privacySettings.canReceiveStrangerMessage.mockReset();
    privacySettings.canReceiveStrangerMessage.mockResolvedValue(true);
    creditService.applyDeltaInTransaction.mockResolvedValue({
      eventId: 'credit-event-1',
      scoreBefore: 100,
      scoreAfter: 95,
    });
    creditService.revertBySourceInTransaction.mockResolvedValue({
      reverted: true,
      userId: 'user-2',
      reversalEventId: 'reversal-1',
      scoreBefore: 95,
      scoreAfter: 100,
    });
    creditService.broadcastCreditProfileChanged.mockResolvedValue(undefined);

    prisma.$transaction.mockImplementation((operations: any) =>
      typeof operations === 'function'
        ? operations(prisma as any)
        : Promise.all(operations),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FriendService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: NotificationService, useValue: notificationService },
        { provide: OpenimService, useValue: openimService },
        { provide: PrivacySettingsService, useValue: privacySettings },
        { provide: CreditService, useValue: creditService },
      ],
    }).compile();

    service = module.get<FriendService>(FriendService);
  });

  it('rejects blocking a missing user before touching friendship state', async () => {
    prisma.block.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.blockUser('user-1', 'user-2')).rejects.toThrow(
      NotFoundException,
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates mirrored friend activities when sending a request', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.friend.count.mockResolvedValue(0);
    prisma.friend.create.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });

    await service.sendRequest('user-1', 'user-2', 'hello');

    expect(prisma.friend.create).toHaveBeenCalled();
    expect(prisma.friendActivity.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          requestId: 'request-1',
          viewerId: 'user-1',
          actorId: 'user-1',
          counterpartyId: 'user-2',
          type: 'REQUEST_SENT',
        }),
        expect.objectContaining({
          requestId: 'request-1',
          viewerId: 'user-2',
          actorId: 'user-1',
          counterpartyId: 'user-1',
          type: 'REQUEST_RECEIVED',
        }),
      ]),
      skipDuplicates: true,
    });
    expect(realtimeService.broadcastFriendUnreadCount).toHaveBeenCalledWith(
      'user-1',
    );
    expect(realtimeService.broadcastFriendUnreadCount).toHaveBeenCalledWith(
      'user-2',
    );
  });

  it('rejects friend requests when the target disallows stranger messages', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.count.mockResolvedValue(0);
    privacySettings.canReceiveStrangerMessage.mockResolvedValue(false);

    await expect(
      service.sendRequest('user-1', 'user-2', 'hello'),
    ).rejects.toThrow(ForbiddenException);

    expect(prisma.friend.create).not.toHaveBeenCalled();
    expect(prisma.friendActivity.createMany).not.toHaveBeenCalled();
  });

  it('creates and broadcasts a friend request notification for the recipient', async () => {
    const notification = {
      id: 'notification-1',
      type: NotificationType.FRIEND_REQUEST_RECEIVED,
    };
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.friend.count.mockResolvedValue(0);
    prisma.friend.create.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });
    notificationService.createFriendRequestNotification.mockResolvedValue(
      notification,
    );

    await service.sendRequest('user-1', 'user-2', 'hello');

    expect(
      notificationService.createFriendRequestNotification,
    ).toHaveBeenCalledWith({
      type: NotificationType.FRIEND_REQUEST_RECEIVED,
      toUserId: 'user-2',
      fromUserId: 'user-1',
      content: 'hello',
    });
    expect(realtimeService.broadcastNotificationCreated).toHaveBeenCalledWith(
      'user-2',
      notification,
    );
  });

  it('does not fail a created friend request when notification delivery fails', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.friend.count.mockResolvedValue(0);
    prisma.friend.create.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });
    notificationService.createFriendRequestNotification.mockRejectedValue(
      new Error('notification unavailable'),
    );

    await expect(
      service.sendRequest('user-1', 'user-2', 'hello'),
    ).resolves.toBeUndefined();

    expect(realtimeService.broadcastFriendUnreadCount).toHaveBeenCalled();
  });

  it('returns editable friend settings with current remark and assigned tags', async () => {
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
      remarkA: '深圳乔酷',
      remarkB: null,
    });
    prisma.friendTag.findMany.mockResolvedValue([
      { id: 'tag-1', ownerID: 'user-1', name: '同事', color: '#3B82F6' },
      { id: 'tag-2', ownerID: 'user-1', name: '健身', color: null },
    ]);
    prisma.friendTagOnFriend.findMany.mockResolvedValue([
      {
        id: 'link-1',
        tag: { id: 'tag-2', ownerID: 'user-1', name: '健身', color: null },
      },
    ]);

    await expect(
      service.getFriendSettings('user-1', 'user-2'),
    ).resolves.toEqual({
      remark: '深圳乔酷',
      assignedTags: [
        { id: 'tag-2', ownerID: 'user-1', name: '健身', color: null },
      ],
      availableTags: [
        { id: 'tag-1', ownerID: 'user-1', name: '同事', color: '#3B82F6' },
        { id: 'tag-2', ownerID: 'user-1', name: '健身', color: null },
      ],
    });
  });

  it('stores sender-owned pending metadata when sending a request', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([
      { id: 'tag-1' },
      { id: 'tag-2' },
    ]);
    prisma.friend.create.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
      pendingRemarkBySender: 'met at school',
    });

    await service.sendRequest('user-1', 'user-2', 'hello', 'met at school', [
      'tag-1',
      'tag-2',
    ]);

    expect(prisma.friend.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        message: 'hello',
        pendingRemarkBySender: 'met at school',
      }),
    });
    expect(prisma.pendingFriendTagOnRequest.createMany).toHaveBeenCalledWith({
      data: [
        { ownerID: 'user-1', requestID: 'request-1', tagID: 'tag-1' },
        { ownerID: 'user-1', requestID: 'request-1', tagID: 'tag-2' },
      ],
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('creates a fresh request when retrying after rejection and preserves history', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'request-old',
      userID: 'user-2',
      friendID: 'user-1',
      state: FriendState.REJECTED,
      message: 'old',
      pendingRemarkBySender: 'old note',
    });
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([{ id: 'tag-3' }]);
    prisma.friend.create.mockResolvedValue({
      id: 'request-new',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'new',
      pendingRemarkBySender: 'new note',
    });

    await service.sendRequest('user-1', 'user-2', 'new', 'new note', ['tag-3']);

    expect(prisma.friend.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userID: 'user-1',
        friendID: 'user-2',
        state: FriendState.PENDING,
        message: 'new',
        pendingRemarkBySender: 'new note',
      }),
    });
    expect(prisma.friend.update).not.toHaveBeenCalled();
    expect(prisma.friendActivity.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          requestId: 'request-new',
          viewerId: 'user-1',
          type: 'REQUEST_SENT',
        }),
        expect.objectContaining({
          requestId: 'request-new',
          viewerId: 'user-2',
          type: 'REQUEST_RECEIVED',
        }),
      ]),
      skipDuplicates: true,
    });
  });

  it('translates a concurrent duplicate pending request into a conflict', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'request-active',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
    });
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([]);
    prisma.friend.create.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['active pair'] },
    });

    await expect(
      service.sendRequest('user-1', 'user-2', 'hello'),
    ).rejects.toThrow('Friend request already pending');

    expect(prisma.friendActivity.createMany).not.toHaveBeenCalled();
  });

  it('translates a concurrent duplicate accepted request into a conflict', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'request-active',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
    });
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([]);
    prisma.friend.create.mockRejectedValueOnce({
      code: 'P2002',
      meta: { target: ['active pair'] },
    });

    await expect(
      service.sendRequest('user-1', 'user-2', 'hello'),
    ).rejects.toThrow('Already friends');
  });

  it('does not rewrite a non-unique Prisma error into a conflict', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([]);
    prisma.friend.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: 'test',
        meta: { modelName: 'Friend' },
      }),
    );

    await expect(
      service.sendRequest('user-1', 'user-2', 'hello'),
    ).rejects.toMatchObject({ code: 'P2025' });
  });

  it('writes request state and activity history in the same transaction when sending', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([]);

    const tx = {
      $executeRaw: jest.fn(),
      friend: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({
          id: 'request-1',
          userID: 'user-1',
          friendID: 'user-2',
          state: FriendState.PENDING,
          message: 'hello',
          pendingRemarkBySender: null,
        }),
      },
      pendingFriendTagOnRequest: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
      },
      friendActivity: {
        createMany: jest.fn().mockRejectedValue(new Error('activity failed')),
      },
    };
    prisma.$transaction.mockImplementationOnce(async (operations: any) =>
      operations(tx as any),
    );

    await expect(
      service.sendRequest('user-1', 'user-2', 'hello'),
    ).rejects.toThrow('activity failed');

    expect(tx.friend.create).toHaveBeenCalled();
    expect(tx.friendActivity.createMany).toHaveBeenCalled();
    expect(prisma.friendActivity.createMany).not.toHaveBeenCalled();
  });

  it('uses the explicit sender remark instead of falling back to message', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([]);
    prisma.friend.create.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
      pendingRemarkBySender: null,
    });

    await service.sendRequest('user-1', 'user-2', 'hello', undefined, []);

    expect(prisma.friend.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        message: 'hello',
        pendingRemarkBySender: null,
      }),
    });
  });

  it('rejects tag ids that do not belong to the sender', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.block.findFirst.mockResolvedValue(null);
    prisma.friend.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([{ id: 'tag-1' }]);

    await expect(
      service.sendRequest('user-1', 'user-2', 'hello', 'met at school', [
        'tag-1',
        'tag-2',
      ]),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.friend.create).not.toHaveBeenCalled();
    expect(prisma.pendingFriendTagOnRequest.createMany).not.toHaveBeenCalled();
  });

  it('passes remark and tag ids through when sending a friend request', async () => {
    const serviceMock = {
      sendRequest: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FriendController(serviceMock as any);

    await controller.sendRequest(
      {
        targetId: 'user-2',
        message: 'hello',
        remark: 'met at school',
        tagIds: ['tag-1'],
      } as any,
      { user: { userId: 'user-1' } } as any,
    );

    expect(serviceMock.sendRequest).toHaveBeenCalledWith(
      'user-1',
      'user-2',
      'hello',
      'met at school',
      ['tag-1'],
    );
  });

  it('rejects reporting yourself', async () => {
    await expect(
      service.reportFriend('user-1', 'user-1', {
        category: 'spam',
        description: 'self report',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.friendReport.create).not.toHaveBeenCalled();
  });

  it('creates a friend report for an active friendship', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      state: FriendState.ACCEPTED,
      userID: 'user-1',
      friendID: 'user-2',
    });
    // No duplicate report exists yet
    prisma.friendReport.findFirst.mockResolvedValue(null);
    prisma.friendReport.create.mockResolvedValue({
      id: 'report-1',
      reporterID: 'user-1',
      targetID: 'user-2',
    });

    await service.reportFriend('user-1', 'user-2', {
      category: 'harassment',
      description: ' abusive language ',
      evidence: ['s3://bucket/report-1.png'],
    });

    expect(prisma.friendReport.create).toHaveBeenCalledWith({
      data: {
        reporterID: 'user-1',
        targetID: 'user-2',
        category: 'harassment',
        description: 'abusive language',
        evidence: ['s3://bucket/report-1.png'],
      },
    });
    expect(creditService.applyDeltaInTransaction).toHaveBeenCalledWith(prisma, {
      userId: 'user-2',
      delta: -5,
      reason: 'FRIEND_REPORT',
      sourceType: 'FRIEND_REPORT',
      sourceId: 'report-1',
      actorId: 'user-1',
      idempotencyKey: 'friend-report:report-1',
      metadata: { category: 'harassment' },
    });
    expect(creditService.broadcastCreditProfileChanged).toHaveBeenCalledWith(
      'user-2',
    );
  });

  it('rejects a duplicate report for the same reporter/target/category', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      state: FriendState.ACCEPTED,
      userID: 'user-1',
      friendID: 'user-2',
    });
    // Simulate an existing report for this combination
    prisma.friendReport.findFirst.mockResolvedValue({ id: 'existing-report' });

    await expect(
      service.reportFriend('user-1', 'user-2', {
        category: 'harassment',
        description: 'again',
      }),
    ).rejects.toThrow(ConflictException);

    expect(prisma.friendReport.create).not.toHaveBeenCalled();
    expect(creditService.applyDeltaInTransaction).not.toHaveBeenCalled();
    expect(creditService.broadcastCreditProfileChanged).not.toHaveBeenCalled();
  });

  it('rejects reporting a non-friend target through the friend API', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue(null);

    await expect(
      service.reportFriend('user-1', 'user-2', {
        category: 'fraud',
        description: 'fake investment pitch',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.friendReport.create).not.toHaveBeenCalled();
  });

  it('passes report payloads through the controller with the current user', async () => {
    const serviceMock = {
      reportFriend: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FriendController(serviceMock as any);

    await controller.reportFriend(
      'user-2',
      {
        category: 'impersonation',
        description: 'pretending to be support',
        evidence: ['proof-1'],
      } as any,
      { user: { userId: 'user-1' } } as any,
    );

    expect(serviceMock.reportFriend).toHaveBeenCalledWith('user-1', 'user-2', {
      category: 'impersonation',
      description: 'pretending to be support',
      evidence: ['proof-1'],
    });
  });

  it('withdraws the caller reports and refunds credit atomically', async () => {
    prisma.friendReport.findMany.mockResolvedValue([
      { id: 'report-1' },
      { id: 'report-2' },
    ]);
    prisma.friendReport.delete.mockResolvedValue({ id: 'report-1' });

    await service.withdrawReport('user-1', 'user-2');

    // Only the caller's own reports are targeted.
    expect(prisma.friendReport.findMany).toHaveBeenCalledWith({
      where: { reporterID: 'user-1', targetID: 'user-2' },
      select: { id: true },
    });
    // Each report is deleted and its deduction reverted inside the transaction.
    expect(prisma.friendReport.delete).toHaveBeenCalledTimes(2);
    expect(creditService.revertBySourceInTransaction).toHaveBeenCalledWith(
      prisma,
      'FRIEND_REPORT',
      'report-1',
      {
        actorId: 'user-1',
        reason: 'FRIEND_REPORT_WITHDRAWN',
      },
    );
    expect(creditService.revertBySourceInTransaction).toHaveBeenCalledTimes(2);
    expect(creditService.broadcastCreditProfileChanged).toHaveBeenCalledWith(
      'user-2',
    );
  });

  it('rejects withdrawing when the caller has no report on the target', async () => {
    prisma.friendReport.findMany.mockResolvedValue([]);

    await expect(service.withdrawReport('user-1', 'user-2')).rejects.toThrow(
      NotFoundException,
    );

    expect(prisma.friendReport.delete).not.toHaveBeenCalled();
    expect(creditService.revertBySourceInTransaction).not.toHaveBeenCalled();
    expect(creditService.broadcastCreditProfileChanged).not.toHaveBeenCalled();
  });

  it('rejects withdrawing a report on yourself', async () => {
    await expect(service.withdrawReport('user-1', 'user-1')).rejects.toThrow(
      BadRequestException,
    );

    expect(prisma.friendReport.findMany).not.toHaveBeenCalled();
  });

  it('passes withdrawReport through the controller with the current user', async () => {
    const serviceMock = {
      withdrawReport: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FriendController(serviceMock as any);

    await controller.withdrawReport('user-2', {
      user: { userId: 'user-1' },
    } as any);

    expect(serviceMock.withdrawReport).toHaveBeenCalledWith('user-1', 'user-2');
  });

  it('supports the restful blacklist controller route', async () => {
    const serviceMock = {
      blockUser: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FriendController(serviceMock as any);

    await controller.blacklistFriend('user-2', {
      user: { userId: 'user-1' },
    } as any);

    expect(serviceMock.blockUser).toHaveBeenCalledWith('user-1', 'user-2');
  });

  it('supports the restful unblacklist controller route', async () => {
    const serviceMock = {
      unblockUser: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new FriendController(serviceMock as any);

    await controller.removeFriendFromBlacklist('user-2', {
      user: { userId: 'user-1' },
    } as any);

    expect(serviceMock.unblockUser).toHaveBeenCalledWith('user-1', 'user-2');
  });

  it('marks a pending request as withdrawn and notifies the recipient', async () => {
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });
    prisma.friend.update.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: 'WITHDRAWN',
      message: 'hello',
    });

    await service.cancelRequest('user-1', 'request-1');

    expect(prisma.friend.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { state: 'WITHDRAWN' },
    });
    expect(prisma.friendActivity.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          requestId: 'request-1',
          viewerId: 'user-2',
          actorId: 'user-1',
          counterpartyId: 'user-1',
          type: 'REQUEST_WITHDRAWN_BY_OTHER',
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.friendTagOnFriend.createMany).not.toHaveBeenCalled();
  });

  it('writes withdraw state and activity history in the same transaction', async () => {
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });

    const tx = {
      friend: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'request-1',
          userID: 'user-1',
          friendID: 'user-2',
          state: FriendState.PENDING,
          message: 'hello',
        }),
        update: jest.fn().mockResolvedValue({
          id: 'request-1',
          userID: 'user-1',
          friendID: 'user-2',
          state: FriendState.WITHDRAWN,
          message: 'hello',
        }),
      },
      pendingFriendTagOnRequest: {
        deleteMany: jest.fn(),
      },
      friendActivity: {
        createMany: jest.fn().mockRejectedValue(new Error('activity failed')),
      },
    };
    prisma.$transaction.mockImplementationOnce(async (operations: any) =>
      operations(tx as any),
    );

    await expect(service.cancelRequest('user-1', 'request-1')).rejects.toThrow(
      'activity failed',
    );

    expect(tx.friend.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { state: FriendState.WITHDRAWN },
    });
    expect(tx.friendActivity.createMany).toHaveBeenCalled();
    expect(prisma.friendActivity.createMany).not.toHaveBeenCalled();
  });

  it('applies pending sender remark and tags when accepting a request', async () => {
    const notification = {
      id: 'notification-1',
      type: NotificationType.FRIEND_REQUEST_ACCEPTED,
    };
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
      pendingRemarkBySender: 'met at school',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: 'ACTIVE',
    });
    prisma.friend.count.mockResolvedValue(0);
    prisma.friendTag.findMany.mockResolvedValue([{ id: 'tag-1' }]);
    prisma.pendingFriendTagOnRequest.findMany.mockResolvedValue([
      { ownerID: 'user-1', requestID: 'request-1', tagID: 'tag-1' },
    ]);
    prisma.friend.update.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
      message: 'hello',
      pendingRemarkBySender: 'met at school',
      remarkA: 'met at school',
    });
    notificationService.createFriendRequestNotification.mockResolvedValue(
      notification,
    );

    await service.handleRequest('user-2', 'request-1', FriendState.ACCEPTED);

    expect(prisma.friend.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({
        state: FriendState.ACCEPTED,
        remarkA: 'met at school',
      }),
    });
    expect(prisma.friendTagOnFriend.createMany).toHaveBeenCalledWith({
      data: [
        {
          ownerID: 'user-1',
          tagID: 'tag-1',
          friendID: 'request-1',
        },
      ],
    });
    expect(
      notificationService.createFriendRequestNotification,
    ).toHaveBeenCalledWith({
      type: NotificationType.FRIEND_REQUEST_ACCEPTED,
      toUserId: 'user-1',
      fromUserId: 'user-2',
      content: 'hello',
    });
    expect(realtimeService.broadcastNotificationCreated).toHaveBeenCalledWith(
      'user-1',
      notification,
    );
  });

  it('does not fail an accepted request when notification delivery fails', async () => {
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.friend.count.mockResolvedValue(0);
    prisma.pendingFriendTagOnRequest.findMany.mockResolvedValue([]);
    prisma.friend.update.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
      message: 'hello',
    });
    notificationService.createFriendRequestNotification.mockRejectedValue(
      new Error('notification unavailable'),
    );

    await expect(
      service.handleRequest('user-2', 'request-1', FriendState.ACCEPTED),
    ).resolves.toBeUndefined();
  });

  it('queues accepted friend request OpenIM sync in both directions', async () => {
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.friend.count.mockResolvedValue(0);
    prisma.pendingFriendTagOnRequest.findMany.mockResolvedValue([]);
    prisma.friend.update.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
      message: 'hello',
    });

    await service.handleRequest('user-2', 'request-1', FriendState.ACCEPTED);

    expect(prisma.friendSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'IMPORT_FRIEND',
          userID: 'user-1',
          targetUserID: 'user-2',
        },
        {
          operation: 'IMPORT_FRIEND',
          userID: 'user-2',
          targetUserID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
    expect(openimService.importFriends).not.toHaveBeenCalled();
  });

  it('does not call OpenIM directly when accepting a friend request', async () => {
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.friend.count.mockResolvedValue(0);
    prisma.pendingFriendTagOnRequest.findMany.mockResolvedValue([]);
    prisma.friend.update.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
      message: 'hello',
    });

    await expect(
      service.handleRequest('user-2', 'request-1', FriendState.ACCEPTED),
    ).resolves.toBeUndefined();
    expect(openimService.importFriends).not.toHaveBeenCalled();
  });

  it('queues removeFriend OpenIM sync in both directions', async () => {
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
    });
    prisma.friend.delete.mockResolvedValue({});

    await service.removeFriend('user-1', 'user-2');

    expect(prisma.friendSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'DELETE_FRIEND',
          userID: 'user-1',
          targetUserID: 'user-2',
        },
        {
          operation: 'DELETE_FRIEND',
          userID: 'user-2',
          targetUserID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
    expect(openimService.deleteFriend).not.toHaveBeenCalled();
  });

  it('does not call OpenIM directly when removing a friend', async () => {
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
    });
    prisma.friend.delete.mockResolvedValue({});

    await expect(
      service.removeFriend('user-1', 'user-2'),
    ).resolves.toBeUndefined();
    expect(openimService.deleteFriend).not.toHaveBeenCalled();
  });

  it('writes accept state, promoted tags, and activity history in the same transaction', async () => {
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
      pendingRemarkBySender: 'met at school',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.friend.count.mockResolvedValue(0);

    const tx = {
      friend: {
        update: jest.fn().mockResolvedValue({
          id: 'request-1',
          userID: 'user-1',
          friendID: 'user-2',
          state: FriendState.ACCEPTED,
          message: 'hello',
          pendingRemarkBySender: 'met at school',
          remarkA: 'met at school',
        }),
      },
      friendTag: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tag-1' }]),
      },
      pendingFriendTagOnRequest: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { ownerID: 'user-1', requestID: 'request-1', tagID: 'tag-1' },
          ]),
        deleteMany: jest.fn(),
      },
      friendTagOnFriend: {
        createMany: jest.fn(),
      },
      friendActivity: {
        createMany: jest.fn().mockRejectedValue(new Error('activity failed')),
      },
    };
    prisma.$transaction.mockImplementationOnce(async (operations: any) =>
      operations(tx as any),
    );

    await expect(
      service.handleRequest('user-2', 'request-1', FriendState.ACCEPTED),
    ).rejects.toThrow('activity failed');

    expect(tx.friend.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({
        state: FriendState.ACCEPTED,
        remarkA: 'met at school',
      }),
    });
    expect(tx.friendTagOnFriend.createMany).toHaveBeenCalledWith({
      data: [
        {
          ownerID: 'user-1',
          tagID: 'tag-1',
          friendID: 'request-1',
        },
      ],
    });
    expect(tx.friendActivity.createMany).toHaveBeenCalled();
    expect(prisma.friendActivity.createMany).not.toHaveBeenCalled();
  });

  it('writes reject state and activity history in the same transaction', async () => {
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
      role: 'USER',
    });
    prisma.friend.count.mockResolvedValue(0);

    const tx = {
      friend: {
        update: jest.fn().mockResolvedValue({
          id: 'request-1',
          userID: 'user-1',
          friendID: 'user-2',
          state: FriendState.REJECTED,
          message: 'hello',
        }),
      },
      pendingFriendTagOnRequest: {
        deleteMany: jest.fn(),
      },
      friendActivity: {
        createMany: jest.fn().mockRejectedValue(new Error('activity failed')),
      },
    };
    prisma.$transaction.mockImplementationOnce(async (operations: any) =>
      operations(tx as any),
    );

    await expect(
      service.handleRequest('user-2', 'request-1', FriendState.REJECTED),
    ).rejects.toThrow('activity failed');

    expect(tx.friend.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { state: FriendState.REJECTED },
    });
    expect(tx.friendActivity.createMany).toHaveBeenCalled();
    expect(prisma.friendActivity.createMany).not.toHaveBeenCalled();
  });

  it('does not apply pending metadata when rejecting a request', async () => {
    const notification = {
      id: 'notification-1',
      type: NotificationType.FRIEND_REQUEST_REJECTED,
    };
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
      pendingRemarkBySender: 'met at school',
    });
    prisma.friend.update.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.REJECTED,
      message: 'hello',
      pendingRemarkBySender: 'met at school',
    });
    notificationService.createFriendRequestNotification.mockResolvedValue(
      notification,
    );

    await service.handleRequest('user-2', 'request-1', FriendState.REJECTED);

    expect(prisma.friend.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { state: FriendState.REJECTED },
    });
    expect(prisma.friendTagOnFriend.createMany).not.toHaveBeenCalled();
    expect(
      notificationService.createFriendRequestNotification,
    ).toHaveBeenCalledWith({
      type: NotificationType.FRIEND_REQUEST_REJECTED,
      toUserId: 'user-1',
      fromUserId: 'user-2',
      content: 'hello',
    });
    expect(realtimeService.broadcastNotificationCreated).toHaveBeenCalledWith(
      'user-1',
      notification,
    );
  });

  it('rejects accepting a request whose sender is no longer active', async () => {
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
    });
    // The sender (user-1) has been banned since sending the request.
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: 'BANNED',
    });

    await expect(
      service.handleRequest('user-2', 'request-1', FriendState.ACCEPTED),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('maps a concurrent block race (P2002) to a clean conflict', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
    });
    prisma.block.findUnique.mockResolvedValue(null);
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' });

    await expect(service.blockUser('user-1', 'user-2')).rejects.toThrow(
      ConflictException,
    );
  });

  it('queues block OpenIM sync for blacklist and friendship removal', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
    });
    prisma.block.findUnique.mockResolvedValue(null);

    await service.blockUser('user-1', 'user-2');

    expect(prisma.friendSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'ADD_BLACKLIST',
          userID: 'user-1',
          targetUserID: 'user-2',
        },
        {
          operation: 'DELETE_FRIEND',
          userID: 'user-1',
          targetUserID: 'user-2',
        },
        {
          operation: 'DELETE_FRIEND',
          userID: 'user-2',
          targetUserID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
    expect(openimService.addBlacklist).not.toHaveBeenCalled();
    expect(openimService.deleteFriend).not.toHaveBeenCalled();
  });

  it('does not call OpenIM directly when blocking a user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-2',
      status: 'ACTIVE',
    });
    prisma.block.findUnique.mockResolvedValue(null);

    await expect(
      service.blockUser('user-1', 'user-2'),
    ).resolves.toBeUndefined();
    expect(openimService.addBlacklist).not.toHaveBeenCalled();
  });

  it('marks exactly one friend activity as read for the viewer', async () => {
    prisma.friendActivity.updateMany.mockResolvedValue({ count: 1 });

    await service.markActivityRead('user-1', 'activity-1');

    expect(prisma.friendActivity.updateMany).toHaveBeenCalledWith({
      where: { id: 'activity-1', viewerId: 'user-1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it('backfills missing activities for legacy pending requests before listing inbox items', async () => {
    // Viewer not yet backfilled — the one-time gate lets the scan run.
    prisma.user.findUnique.mockResolvedValue({ activitiesBackfilledAt: null });
    prisma.friend.findMany.mockResolvedValue([
      {
        id: 'request-1',
        userID: 'user-1',
        friendID: 'user-2',
        state: FriendState.PENDING,
        message: 'hello',
        createdAt: new Date('2026-04-08T00:00:00.000Z'),
        updatedAt: new Date('2026-04-08T00:00:00.000Z'),
      },
    ]);
    prisma.friendActivity.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'activity-1',
          type: 'REQUEST_RECEIVED',
          requestId: 'request-1',
          messageSnapshot: 'hello',
          readAt: null,
          createdAt: new Date('2026-04-08T00:00:00.000Z'),
          counterparty: {
            id: 'user-1',
            accountId: 'alice',
            nickname: 'Alice',
            avatarUrl: null,
          },
          request: {
            id: 'request-1',
            state: FriendState.PENDING,
            message: 'hello',
          },
        },
      ]);

    const activities = await service.listActivities('user-2');

    expect(prisma.friendActivity.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          requestId: 'request-1',
          viewerId: 'user-2',
          actorId: 'user-1',
          counterpartyId: 'user-1',
          type: 'REQUEST_RECEIVED',
        }),
      ],
      skipDuplicates: true,
    });
    expect(activities).toHaveLength(1);
  });

  it('validates sender remark and tag ids on the request dto', () => {
    const dto = plainToInstance(SendFriendRequestDto, {
      targetId: '550e8400-e29b-41d4-a716-446655440000',
      remark: 'a'.repeat(51),
      tagIds: ['not-a-uuid'],
    });

    const errors = validateSync(dto);

    expect(errors.some((error) => error.property === 'remark')).toBe(true);
    expect(errors.some((error) => error.property === 'tagIds')).toBe(true);
  });

  // ─── Phase 2b: tags / remark / activities ───────────────────────────────────

  it('createTag rejects an empty (whitespace-only) tag name', async () => {
    await expect(service.createTag('user-1', '   ')).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.friendTag.upsert).not.toHaveBeenCalled();
  });

  it('createTag rejects a new tag once the per-user limit is reached', async () => {
    prisma.friendTag.findUnique.mockResolvedValue(null);
    prisma.friendTag.count.mockResolvedValue(50);

    await expect(service.createTag('user-1', 'classmates')).rejects.toThrow(
      /limit reached/i,
    );
    expect(prisma.friendTag.upsert).not.toHaveBeenCalled();
  });

  it('createTag still allows updating an existing tag at the limit', async () => {
    prisma.friendTag.findUnique.mockResolvedValue({ id: 'tag-1' });
    prisma.friendTag.upsert.mockResolvedValue({ id: 'tag-1' });

    await service.createTag('user-1', 'classmates', '#FF0000');

    expect(prisma.friendTag.count).not.toHaveBeenCalled();
    expect(prisma.friendTag.upsert).toHaveBeenCalled();
  });

  it('assignTag rejects a tag that does not belong to the user', async () => {
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
    });
    prisma.friendTag.findUnique.mockResolvedValue({
      id: 'tag-9',
      ownerID: 'someone-else',
    });

    await expect(
      service.assignTag('user-1', 'user-2', 'tag-9'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.friendTagOnFriend.upsert).not.toHaveBeenCalled();
  });

  it('removeTag now rejects a foreign tag id instead of silently no-op', async () => {
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.ACCEPTED,
    });
    prisma.friendTag.findUnique.mockResolvedValue({
      id: 'tag-9',
      ownerID: 'someone-else',
    });

    await expect(
      service.removeTag('user-1', 'user-2', 'tag-9'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.friendTagOnFriend.deleteMany).not.toHaveBeenCalled();
  });

  it('setRemark writes remarkB when the caller is the friendID side', async () => {
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'user-2',
      friendID: 'user-1',
      state: FriendState.ACCEPTED,
    });

    await service.setRemark('user-1', 'user-2', '老同事');

    expect(prisma.friend.update).toHaveBeenCalledWith({
      where: { id: 'friendship-1' },
      data: { remarkB: '老同事' },
    });
  });

  it('getActivity does not leak another viewer activity', async () => {
    prisma.friendActivity.findFirst.mockResolvedValue(null);

    await expect(
      service.getActivity('user-1', 'activity-of-someone-else'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.friendActivity.findFirst).toHaveBeenCalledWith({
      where: { id: 'activity-of-someone-else', viewerId: 'user-1' },
      include: expect.any(Object),
    });
  });

  it('unblockUser maps a missing block (P2025) to a 404', async () => {
    prisma.block.delete.mockRejectedValueOnce({ code: 'P2025' });

    await expect(service.unblockUser('user-1', 'user-2')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('queues unblock OpenIM blacklist removal', async () => {
    prisma.block.delete.mockResolvedValue({});

    await service.unblockUser('user-1', 'user-2');

    expect(prisma.friendSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'REMOVE_BLACKLIST',
          userID: 'user-1',
          targetUserID: 'user-2',
        },
      ],
      skipDuplicates: true,
    });
    expect(openimService.removeBlacklist).not.toHaveBeenCalled();
  });

  it('does not call OpenIM directly when unblocking a user', async () => {
    prisma.block.delete.mockResolvedValue({});

    await expect(
      service.unblockUser('user-1', 'user-2'),
    ).resolves.toBeUndefined();
    expect(openimService.removeBlacklist).not.toHaveBeenCalled();
  });
});

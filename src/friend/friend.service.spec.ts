import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { FriendState, Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { SendFriendRequestDto } from './dto/friend.dto';
import { FriendController } from './friend.controller';
import { FriendService } from './friend.service';

describe('FriendService', () => {
  let service: FriendService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    block: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
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
      upsert: jest.fn(),
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
    $transaction: jest.fn((operations: any) =>
      typeof operations === 'function'
        ? operations(prisma as any)
        : Promise.all(operations),
    ),
  };

  beforeEach(async () => {
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

    prisma.$transaction.mockImplementation((operations: any) =>
      typeof operations === 'function'
        ? operations(prisma as any)
        : Promise.all(operations),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [FriendService, { provide: PrismaService, useValue: prisma }],
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
    });
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
      friend: {
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
    prisma.friend.findUnique.mockResolvedValue({
      id: 'request-1',
      userID: 'user-1',
      friendID: 'user-2',
      state: FriendState.PENDING,
      message: 'hello',
      pendingRemarkBySender: 'met at school',
    });
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

    await service.handleRequest('user-2', 'request-1', FriendState.REJECTED);

    expect(prisma.friend.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: { state: FriendState.REJECTED },
    });
    expect(prisma.friendTagOnFriend.createMany).not.toHaveBeenCalled();
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
});

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ChatErrorCode, GroupErrorCode } from 'src/common/app-error-codes';
import { ChatService } from './chat.service';

/**
 * 独立群聊(不挂圈子的 GROUP 会话)专属行为:
 * 建群/邀请只认好友、圈子群拒绝独立群操作、群主退群转移、目录全员可见。
 */
describe('ChatService standalone group conversations', () => {
  const prisma = {
    chatConversation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    chatMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    chatMessage: { aggregate: jest.fn() },
    user: { findMany: jest.fn(), count: jest.fn() },
    friend: { findMany: jest.fn() },
    userPrivacySetting: { findMany: jest.fn() },
    circleMember: { findUnique: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
  };
  const broadcast = {
    joinUserToConversation: jest.fn().mockResolvedValue(undefined),
    removeUserFromConversation: jest.fn().mockResolvedValue(undefined),
    emitConversationChange: jest.fn(),
  };
  const systemMessage = { emit: jest.fn().mockResolvedValue(undefined) };

  const service = new ChatService(
    prisma as never,
    { check: jest.fn() } as never,
    { ensureCircleConversation: jest.fn() } as never,
    { attachMediaUrls: jest.fn(), deleteObjects: jest.fn() } as never,
    { canReceiveStrangerMessage: jest.fn() } as never,
    broadcast as never,
    systemMessage as never,
    { isSupportAgent: jest.fn() } as never,
  );

  const conversationDto = { id: 'conv-1' };

  const seat = (overrides: Record<string, unknown> = {}) => ({
    id: 'seat-1',
    conversationID: 'conv-1',
    userID: 'owner-1',
    leftAt: null,
    conversation: {
      id: 'conv-1',
      type: 'GROUP',
      directKey: null,
      circleID: null,
      tempChatID: null,
      name: '周末爬山',
      ownerID: 'owner-1',
      lastMessageAt: null,
    },
    ...overrides,
  });

  // 好友表任一方向的 ACCEPTED 行都算好友。
  const friendRows = (userId: string, friendIds: string[]) =>
    friendIds.map((id, index) =>
      index % 2 === 0
        ? { userID: userId, friendID: id }
        : { userID: id, friendID: userId },
    );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([
      { id: 'conv-1', type: 'GROUP', circleID: null, ownerID: 'owner-1' },
    ]);
    prisma.chatMember.count.mockResolvedValue(1);
    prisma.userPrivacySetting.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) => cb(prisma),
    );
    jest
      .spyOn(
        service as unknown as {
          buildConversationDto: (u: string, c: string) => Promise<unknown>;
        },
        'buildConversationDto',
      )
      .mockResolvedValue(conversationDto);
  });

  it('rejects group creation with fewer than 2 other members', async () => {
    await expect(
      service.createGroupConversation('owner-1', {
        // 自己混进名单也不算数。
        memberIds: ['owner-1', 'f1'],
      }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: { errorCode: ChatErrorCode.GroupMinMembers },
    });
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('rejects group creation when any invitee is not a friend', async () => {
    prisma.friend.findMany.mockResolvedValue(friendRows('owner-1', ['f1']));

    await expect(
      service.createGroupConversation('owner-1', {
        memberIds: ['f1', 'stranger-1'],
      }),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: ChatErrorCode.GroupFriendsOnly },
    });
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('rejects group creation when a friend disables group invitations', async () => {
    prisma.friend.findMany.mockResolvedValue(
      friendRows('owner-1', ['f1', 'f2']),
    );
    prisma.userPrivacySetting.findMany.mockResolvedValue([
      { userID: 'f2', groupInvitePermission: 'NONE' },
    ]);
    prisma.user.count.mockResolvedValue(2);

    await expect(
      service.createGroupConversation('owner-1', {
        memberIds: ['f1', 'f2'],
      }),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: GroupErrorCode.InviteNotAllowed },
    });
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('rejects group creation above the 200-member cap', async () => {
    const memberIds = Array.from({ length: 200 }, (_, index) => `f${index}`);

    await expect(
      service.createGroupConversation('owner-1', { memberIds }),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: { errorCode: ChatErrorCode.GroupFull },
    });
    expect(prisma.friend.findMany).not.toHaveBeenCalled();
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('creates a standalone group with owner, seats, rooms, and one notice', async () => {
    prisma.friend.findMany.mockResolvedValue(
      friendRows('owner-1', ['f1', 'f2']),
    );
    prisma.user.count.mockResolvedValue(2);
    prisma.chatConversation.create.mockResolvedValue({ id: 'conv-1' });

    const result = await service.createGroupConversation('owner-1', {
      name: '  周末爬山  ',
      memberIds: ['f1', 'f2', 'f1'],
    });

    expect(prisma.chatConversation.create).toHaveBeenCalledWith({
      data: {
        type: 'GROUP',
        name: '周末爬山',
        ownerID: 'owner-1',
        members: {
          create: [{ userID: 'owner-1' }, { userID: 'f1' }, { userID: 'f2' }],
        },
      },
      select: { id: true },
    });
    // 三人各自入房 + 个人事件;建群提示只发一条 group-created,不逐人刷屏。
    expect(broadcast.joinUserToConversation).toHaveBeenCalledTimes(3);
    expect(broadcast.emitConversationChange).toHaveBeenCalledTimes(3);
    expect(systemMessage.emit).toHaveBeenCalledWith('conv-1', {
      kind: 'group-created',
    });
    expect(result).toBe(conversationDto);
  });

  it('rejects standalone-group operations on circle-managed groups', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(
      seat({
        conversation: { ...seat().conversation, circleID: 'circle-1' },
      }),
    );

    await expect(
      service.inviteToGroupConversation('owner-1', 'conv-1', ['f1']),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: ChatErrorCode.GroupCircleManaged },
    });
  });

  it('invite reactivates a left seat and raises its cleared floor', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.friend.findMany.mockResolvedValue(
      friendRows('owner-1', ['f-back', 'f-seated']),
    );
    prisma.chatMember.findMany.mockResolvedValue([
      // 退过群的:要复位并抬清空水位,退群前历史不回放。
      { id: 'seat-left', userID: 'f-back', leftAt: new Date('2026-08-01') },
      // 仍在座的:跳过,不重复建座位。
      { id: 'seat-live', userID: 'f-seated', leftAt: null },
    ]);
    prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 42 } });

    await service.inviteToGroupConversation('owner-1', 'conv-1', [
      'f-back',
      'f-seated',
    ]);

    expect(prisma.chatMember.update).toHaveBeenCalledWith({
      where: { id: 'seat-left' },
      data: expect.objectContaining({
        leftAt: null,
        clearedBeforeHeight: 42,
      }),
    });
    expect(prisma.chatMember.create).not.toHaveBeenCalled();
    expect(systemMessage.emit).not.toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ kind: 'member-joined', names: ['f-seated'] }),
    );
  });

  it('rejects an invite when target privacy changes to NONE before the transaction check', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.friend.findMany.mockResolvedValue(friendRows('owner-1', ['f1']));
    prisma.userPrivacySetting.findMany.mockResolvedValue([
      { userID: 'f1', groupInvitePermission: 'NONE' },
    ]);
    prisma.chatMember.findMany.mockResolvedValue([]);

    await expect(
      service.inviteToGroupConversation('owner-1', 'conv-1', ['f1']),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: GroupErrorCode.InviteNotAllowed },
    });
    expect(prisma.chatMember.create).not.toHaveBeenCalled();
  });

  it('rejects an invite when the actor has left before the locked transaction check', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.friend.findMany.mockResolvedValue(friendRows('owner-1', ['f1']));
    prisma.chatMember.findMany.mockResolvedValue([]);
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) =>
        cb({
          ...prisma,
          chatMember: { ...prisma.chatMember, findUnique: jest.fn() },
        } as typeof prisma),
    );

    await expect(
      service.inviteToGroupConversation('owner-1', 'conv-1', ['f1']),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: ChatErrorCode.NotMember },
    });
    expect(prisma.chatMember.create).not.toHaveBeenCalled();
  });

  it('rejects invitations that would exceed the 200-member cap', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.friend.findMany.mockResolvedValue(
      friendRows('owner-1', ['f1', 'f2']),
    );
    prisma.$queryRaw.mockResolvedValue([
      { id: 'conv-1', type: 'GROUP', circleID: null },
    ]);
    prisma.chatMember.findMany.mockResolvedValue([]);
    prisma.chatMember.count.mockResolvedValue(199);

    await expect(
      service.inviteToGroupConversation('owner-1', 'conv-1', ['f1', 'f2']),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: { errorCode: ChatErrorCode.GroupFull },
    });
    expect(prisma.chatMember.create).not.toHaveBeenCalled();
    expect(prisma.chatMember.update).not.toHaveBeenCalled();
  });

  it('admits at most one concurrent QR join when 199 members are seated', async () => {
    prisma.chatConversation.findUnique.mockResolvedValue({
      id: 'conv-1',
      type: 'GROUP',
      circleID: null,
    });
    prisma.chatMember.findFirst.mockResolvedValue(null);

    let seatedCount = 199;
    prisma.chatMember.count.mockImplementation(async () => seatedCount);
    prisma.chatMember.create.mockImplementation(async () => {
      seatedCount += 1;
      return { id: `seat-${seatedCount}` };
    });

    let lockTail = Promise.resolve();
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) => {
        const previous = lockTail;
        let releaseLock!: () => void;
        lockTail = new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
        const tx = {
          ...prisma,
          $queryRaw: jest.fn(async () => {
            await previous;
            return [{ id: 'conv-1', type: 'GROUP', circleID: null }];
          }),
        };
        try {
          return await cb(tx as typeof prisma);
        } finally {
          releaseLock();
        }
      },
    );

    const results = await Promise.allSettled([
      service.joinStandaloneGroupViaQr('u1', 'conv-1'),
      service.joinStandaloneGroupViaQr('u2', 'conv-1'),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(seatedCount).toBe(200);
  });

  it('owner leaving hands the group to the earliest seated member', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.chatMember.findFirst.mockResolvedValue({ userID: 'f1' });

    await service.leaveGroupConversation('owner-1', 'conv-1');

    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', userID: 'owner-1', leftAt: null },
      data: { leftAt: expect.any(Date) },
    });
    expect(prisma.chatMember.findFirst).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', leftAt: null },
      orderBy: { joinedAt: 'asc' },
      select: { userID: true },
    });
    expect(prisma.chatConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { ownerID: 'f1' },
    });
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('owner-1', {
      kind: 'left',
      conversationId: 'conv-1',
      userId: 'owner-1',
    });
    expect(systemMessage.emit).toHaveBeenCalledWith('conv-1', {
      kind: 'member-left',
    });
  });

  it('non-owner leaving keeps the owner untouched', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat({ userID: 'f1' }));

    await service.leaveGroupConversation('f1', 'conv-1');

    expect(prisma.chatConversation.update).not.toHaveBeenCalled();
  });

  it('uses the locked owner snapshot when ownership changes before leave commits', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(
      seat({
        conversation: { ...seat().conversation, ownerID: 'f1' },
      }),
    );
    prisma.$queryRaw.mockResolvedValue([
      { id: 'conv-1', type: 'GROUP', circleID: null, ownerID: 'owner-1' },
    ]);
    prisma.chatMember.findFirst.mockResolvedValue({ userID: 'f2' });

    await service.leaveGroupConversation('owner-1', 'conv-1');

    expect(prisma.chatConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { ownerID: 'f2' },
    });
  });

  it('rejects leave when the actor seat disappeared before the locked re-read', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) =>
        cb({
          ...prisma,
          chatMember: { ...prisma.chatMember, findUnique: jest.fn() },
        } as typeof prisma),
    );

    await expect(
      service.leaveGroupConversation('owner-1', 'conv-1'),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: ChatErrorCode.NotMember },
    });
    expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
  });

  it('rename trims, persists, and leaves a system notice', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());

    await service.renameGroupConversation('owner-1', 'conv-1', ' 新群名 ');

    expect(prisma.chatConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { name: '新群名' },
    });
    expect(systemMessage.emit).toHaveBeenCalledWith('conv-1', {
      kind: 'group-renamed',
      name: '新群名',
    });
  });

  it('standalone group members can read the member directory', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat({ userID: 'f1' }));
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'owner-1' },
      { userID: 'f1' },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'owner-1', nickname: 'Owner', avatarUrl: null },
      { id: 'f1', nickname: 'Friend', avatarUrl: null },
    ]);

    const members = await service.listMembers('f1', 'conv-1');

    // 无圈群不查 circleMember(那是圈子群才有的角色目录门)。
    expect(prisma.circleMember.findUnique).not.toHaveBeenCalled();
    expect(
      members.map((m) => m.userId).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['f1', 'owner-1']);
  });
});

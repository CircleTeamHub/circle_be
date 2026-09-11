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
      updateMany: jest.fn(),
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
    user: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
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
  const groupEvents = {
    record: jest.fn().mockResolvedValue(undefined),
    recordInTx: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ChatService(
    prisma as never,
    { check: jest.fn() } as never,
    { ensureCircleConversation: jest.fn() } as never,
    { attachMediaUrls: jest.fn(), deleteObjects: jest.fn() } as never,
    { canReceiveStrangerMessage: jest.fn() } as never,
    broadcast as never,
    systemMessage as never,
    { isSupportAgent: jest.fn() } as never,
    { lock: jest.fn() } as never,
    groupEvents as never,
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

  // 群名的真闸门在这里而不是 DTO:ValidationPipe 打回的 400 不带 errorCode,
  // 客户端只能显示通用文案。空名/缺名都要走到这一层才拿得到 CHAT_GROUP_NAME_REQUIRED。
  it.each<[string, string | undefined]>([
    ['a blank group name', '   '],
    ['a missing group name', undefined],
  ])('rejects %s before creating any group data', async (_case, name) => {
    await expect(
      service.createGroupConversation('owner-1', {
        name,
        memberIds: ['f1', 'f2'],
      }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: { errorCode: ChatErrorCode.GroupNameRequired },
    });
    expect(prisma.chatConversation.create).not.toHaveBeenCalled();
  });

  it('rejects group creation with fewer than 2 other members', async () => {
    await expect(
      service.createGroupConversation('owner-1', {
        name: '测试群',
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
        name: '测试群',
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
        name: '测试群',
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
      service.createGroupConversation('owner-1', { name: '测试群', memberIds }),
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

  // 旧客户端缓存里的成员 id 是去连字符的 32-hex 别名。归一必须发生在查好友表/
  // 用户表之前,否则合法好友会被当成陌生人打回 CHAT_GROUP_FRIENDS_ONLY。
  it('normalizes 32-hex member aliases before the friend and user checks', async () => {
    const friendId = '2f7c1d9e-8b3a-4c5d-9e1f-0a1b2c3d4e5f';
    const friendAlias = '2F7C1D9E8B3A4C5D9E1F0A1B2C3D4E5F';
    prisma.friend.findMany.mockResolvedValue(
      friendRows('owner-1', [friendId, 'f2']),
    );
    prisma.user.count.mockResolvedValue(2);
    prisma.chatConversation.create.mockResolvedValue({ id: 'conv-1' });

    await service.createGroupConversation('owner-1', {
      name: '周末爬山',
      // 同一个人的别名与 UUID 各来一次:归一后只该留下一个座位。
      memberIds: [friendAlias, 'f2', friendId],
    });

    expect(prisma.friend.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { userID: 'owner-1', friendID: { in: [friendId, 'f2'] } },
            { friendID: 'owner-1', userID: { in: [friendId, 'f2'] } },
          ],
        }),
      }),
    );
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: { id: { in: [friendId, 'f2'] }, status: 'ACTIVE' },
    });
    expect(prisma.chatConversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          members: {
            create: [
              { userID: 'owner-1' },
              { userID: friendId },
              { userID: 'f2' },
            ],
          },
        }),
      }),
    );
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

  // 解散(微信语义):群主一按,群从所有人的列表里消失,所有人的记录一起没。
  const dissolvableConversation = (
    overrides: Record<string, unknown> = {},
  ) => ({
    id: 'conv-1',
    type: 'GROUP',
    circleID: null,
    ownerID: 'owner-1',
    nextHeight: 42,
    clearedBeforeHeight: 0,
    ...overrides,
  });

  it('owner dissolving evicts every seat and hides history for everyone', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.$queryRaw.mockResolvedValue([dissolvableConversation()]);
    prisma.chatMember.findMany.mockResolvedValue([
      { userID: 'owner-1' },
      { userID: 'f1' },
      { userID: 'f2' },
    ]);

    await service.dissolveGroupConversation('owner-1', 'conv-1');

    // 会话级水位:解散之后任何新座位(理论上不该有)也读不回历史。
    expect(prisma.chatConversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'conv-1', clearedBeforeHeight: { lt: 42 } },
      data: { clearedBeforeHeight: 42 },
    });
    // 座位:水位推到顶 + 全员离座,一次 updateMany 完成。
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', leftAt: null },
      data: {
        clearedBeforeHeight: 42,
        lastReadHeight: 42,
        leftAt: expect.any(Date),
      },
    });
    for (const userID of ['owner-1', 'f1', 'f2']) {
      expect(broadcast.removeUserFromConversation).toHaveBeenCalledWith(
        userID,
        'conv-1',
      );
    }
    // 解散的人自己收 left:收 removed 的话客户端会给他弹「你已被移出该群聊」。
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('owner-1', {
      kind: 'left',
      conversationId: 'conv-1',
      userId: 'owner-1',
    });
    for (const userID of ['f1', 'f2']) {
      expect(broadcast.emitConversationChange).toHaveBeenCalledWith(userID, {
        kind: 'removed',
        conversationId: 'conv-1',
        userId: userID,
      });
    }
  });

  it('rejects dissolve from a non-owner member', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(
      seat({ userID: 'f1', conversation: seat().conversation }),
    );
    prisma.$queryRaw.mockResolvedValue([dissolvableConversation()]);

    await expect(
      service.dissolveGroupConversation('f1', 'conv-1'),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: ChatErrorCode.GroupOwnerOnly },
    });
    expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
    expect(broadcast.emitConversationChange).not.toHaveBeenCalled();
  });

  it('rejects dissolve from a member who already left', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(
      seat({ leftAt: new Date() }),
    );

    await expect(
      service.dissolveGroupConversation('owner-1', 'conv-1'),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: ChatErrorCode.NotMember },
    });
    expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
  });

  it('rejects dissolve on a circle-managed group', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(
      seat({
        conversation: { ...seat().conversation, circleID: 'circle-1' },
      }),
    );

    await expect(
      service.dissolveGroupConversation('owner-1', 'conv-1'),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: ChatErrorCode.GroupCircleManaged },
    });
    expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
  });

  it('owner leaving hands the group to the earliest seated member when no admin exists', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.chatMember.findFirst
      // 先找最早入群的管理员:没有
      .mockResolvedValueOnce(null)
      // 再找最早入群的任意在座成员
      .mockResolvedValueOnce({ id: 'seat-f1', userID: 'f1' });
    prisma.user.findUnique.mockResolvedValue({ nickname: '小方' });

    await service.leaveGroupConversation('owner-1', 'conv-1');

    // 座位关闭时管理员标记归零。
    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', userID: 'owner-1', leftAt: null },
      data: { leftAt: expect.any(Date), role: 'MEMBER' },
    });
    expect(prisma.chatMember.findFirst).toHaveBeenNthCalledWith(1, {
      where: { conversationID: 'conv-1', leftAt: null, role: 'ADMIN' },
      orderBy: { joinedAt: 'asc' },
      select: { id: true, userID: true },
    });
    expect(prisma.chatMember.findFirst).toHaveBeenNthCalledWith(2, {
      where: { conversationID: 'conv-1', leftAt: null },
      orderBy: { joinedAt: 'asc' },
      select: { id: true, userID: true },
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
    // 群日志:退群 + 转让两条;新群主收 updated 刷新群设置入口。
    expect(groupEvents.record).toHaveBeenCalledWith('conv-1', {
      kind: 'member-left',
      actorId: 'owner-1',
      targetIds: ['owner-1'],
    });
    expect(groupEvents.record).toHaveBeenCalledWith('conv-1', {
      kind: 'owner-transferred',
      actorId: 'owner-1',
      targetIds: ['f1'],
    });
    expect(broadcast.emitConversationChange).toHaveBeenCalledWith('f1', {
      kind: 'updated',
      conversationId: 'conv-1',
      userId: 'f1',
    });
  });

  it('owner leaving prefers the earliest admin and clears that admin flag', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(seat());
    prisma.chatMember.findFirst.mockResolvedValueOnce({
      id: 'seat-admin-1',
      userID: 'admin-1',
    });
    prisma.user.findUnique.mockResolvedValue({ nickname: '管理员甲' });

    await service.leaveGroupConversation('owner-1', 'conv-1');

    expect(prisma.chatMember.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.chatConversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data: { ownerID: 'admin-1' },
    });
    // 群主身份只由 ownerID 表达,座位上的管理员标记归零。
    expect(prisma.chatMember.update).toHaveBeenCalledWith({
      where: { id: 'seat-admin-1' },
      data: { role: 'MEMBER', silencedAt: null, silencedUntil: null },
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

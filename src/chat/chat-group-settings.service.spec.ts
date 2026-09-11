import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatGroupSettingsService } from './chat-group-settings.service';

/**
 * 群设置第二批:全员禁言开关、群主转让、独立群公告/头像、群策略开关。
 * 钉住:锁外先鉴权(非管理员碰不到会话行锁)、幂等不刷提示、圈子群的
 * memberCanInvite 写在 Circle、转让时新群主座位清零、头像 URL 只认本应用存储。
 */
describe('ChatGroupSettingsService', () => {
  const prisma = {
    chatMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    chatConversation: { update: jest.fn() },
    circleMember: { findUnique: jest.fn() },
    circle: { findUnique: jest.fn(), update: jest.fn() },
    user: { findUnique: jest.fn() },
    block: { findFirst: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'MINIO_PUBLIC_URL' || key === 'STORAGE_PUBLIC_URL'
        ? 'http://10.0.0.195:9000'
        : null,
    ),
  };
  const broadcast = { emitConversationChange: jest.fn() };
  const systemMessage = {
    insertSystemMessageAfterLockedConversationInTx: jest
      .fn()
      .mockImplementation(
        async (
          _tx: unknown,
          conversationId: string,
          lockedNextHeight: number,
          content: unknown,
        ) => ({
          id: `notice-${lockedNextHeight + 1}`,
          conversationId,
          height: lockedNextHeight + 1,
          content,
        }),
      ),
    broadcastSystemMessage: jest.fn().mockResolvedValue(undefined),
  };
  const groupEvents = { recordInTx: jest.fn().mockResolvedValue(undefined) };

  const service = new ChatGroupSettingsService(
    prisma as never,
    config as never,
    broadcast as never,
    systemMessage as never,
    groupEvents as never,
  );

  const locked = (overrides: Record<string, unknown> = {}) => ({
    id: 'conv-1',
    type: 'GROUP',
    circleID: null,
    ownerID: 'owner-1',
    nextHeight: 10,
    muteAllAt: null,
    notice: null,
    avatarUrl: null,
    memberCanInvite: true,
    qrJoinEnabled: true,
    membersCanViewProfiles: true,
    membersCanAddFriends: true,
    ...overrides,
  });
  const seat = (userID: string, overrides: Record<string, unknown> = {}) => ({
    id: `seat-${userID}`,
    conversationID: 'conv-1',
    userID,
    role: 'MEMBER',
    leftAt: null,
    silencedAt: null,
    silencedUntil: null,
    ...overrides,
  });

  /** 锁外快照(本人座位 + 会话)与锁后快照(会话行 + 本人座位)。 */
  const arrange = (params: {
    row?: Record<string, unknown>;
    actor: ReturnType<typeof seat>;
    circleRole?: string | null;
  }) => {
    const row = locked(params.row);
    prisma.chatMember.findUnique.mockResolvedValue({
      ...params.actor,
      conversation: row,
    });
    prisma.$queryRaw.mockResolvedValue([row]);
    if (params.circleRole !== undefined) {
      prisma.circleMember.findUnique.mockResolvedValue(
        params.circleRole
          ? { role: params.circleRole, status: 'ACTIVE' }
          : null,
      );
    }
    return row;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) => cb(prisma),
    );
    prisma.circle.findUnique.mockResolvedValue({ memberCanInvite: true });
    // 转让的目标默认是个正常账号,且与本人没有任何拉黑关系。
    prisma.user.findUnique.mockResolvedValue({
      nickname: '小方',
      status: 'ACTIVE',
    });
    prisma.block.findFirst.mockResolvedValue(null);
  });

  describe('setMuteAll', () => {
    it('rejects ordinary members before locking', async () => {
      arrange({ actor: seat('u-2') });
      await expect(
        service.setMuteAll('u-2', 'conv-1', true),
      ).rejects.toMatchObject({
        constructor: ForbiddenException,
        response: { errorCode: ChatErrorCode.GroupManagerOnly },
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('turns mute-all on with a notice and a log entry, then broadcasts', async () => {
      arrange({ actor: seat('admin-1', { role: 'ADMIN' }) });
      await expect(
        service.setMuteAll('admin-1', 'conv-1', true),
      ).resolves.toEqual({
        muteAll: true,
      });
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { muteAllAt: expect.any(Date) },
      });
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledWith(prisma, 'conv-1', 10, {
        kind: 'mute-all-changed',
        actorId: 'admin-1',
        enabled: true,
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'mute-all-changed',
        actorId: 'admin-1',
        payload: { enabled: true },
      });
      expect(systemMessage.broadcastSystemMessage).toHaveBeenCalledTimes(1);
    });

    it('is idempotent when already in the requested state', async () => {
      arrange({ actor: seat('owner-1'), row: { muteAllAt: new Date() } });
      await service.setMuteAll('owner-1', 'conv-1', true);
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
      expect(groupEvents.recordInTx).not.toHaveBeenCalled();
    });

    it('works for circle groups through the circle role', async () => {
      arrange({
        actor: seat('admin-1'),
        row: { circleID: 'circle-1', ownerID: null, muteAllAt: new Date() },
        circleRole: 'ADMIN',
      });
      await expect(
        service.setMuteAll('admin-1', 'conv-1', false),
      ).resolves.toEqual({
        muteAll: false,
      });
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { muteAllAt: null },
      });
    });
  });

  describe('transferOwnership', () => {
    it('is owner-only and standalone-only', async () => {
      arrange({ actor: seat('admin-1', { role: 'ADMIN' }) });
      await expect(
        service.transferOwnership('admin-1', 'conv-1', 'u-2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupOwnerOnly },
      });
      arrange({
        actor: seat('owner-1'),
        row: { circleID: 'circle-1' },
        circleRole: 'OWNER',
      });
      await expect(
        service.transferOwnership('owner-1', 'conv-1', 'u-2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupCircleManaged },
      });
    });

    it('refuses to transfer to yourself or to someone who left', async () => {
      await expect(
        service.transferOwnership('owner-1', 'conv-1', 'owner-1'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupSelfTarget },
      });
      arrange({ actor: seat('owner-1') });
      prisma.chatMember.findMany.mockResolvedValue([
        seat('owner-1'),
        seat('u-2', { leftAt: new Date() }),
      ]);
      await expect(
        service.transferOwnership('owner-1', 'conv-1', 'u-2'),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { errorCode: ChatErrorCode.GroupMemberNotFound },
      });
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
    });

    it('moves ownerID, clears the new owner seat, demotes the old owner and notifies both', async () => {
      arrange({ actor: seat('owner-1') });
      prisma.chatMember.findMany.mockResolvedValue([
        seat('owner-1'),
        seat('u-2', { role: 'ADMIN', silencedAt: new Date() }),
      ]);
      await service.transferOwnership('owner-1', 'conv-1', 'u-2');
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { ownerID: 'u-2' },
      });
      expect(prisma.chatMember.update).toHaveBeenCalledWith({
        where: { id: 'seat-u-2' },
        data: { role: 'MEMBER', silencedAt: null, silencedUntil: null },
      });
      expect(prisma.chatMember.update).toHaveBeenCalledWith({
        where: { id: 'seat-owner-1' },
        data: { role: 'MEMBER' },
      });
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledWith(prisma, 'conv-1', 10, {
        kind: 'owner-transferred',
        actorId: 'owner-1',
        targetUserId: 'u-2',
        name: '小方',
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'owner-transferred',
        actorId: 'owner-1',
        targetIds: ['u-2'],
      });
      for (const userId of ['u-2', 'owner-1']) {
        expect(broadcast.emitConversationChange).toHaveBeenCalledWith(userId, {
          kind: 'updated',
          conversationId: 'conv-1',
          userId,
        });
      }
    });

    it('refuses a banned target and a target on either side of a block', async () => {
      // 转让不可撤销:交给封禁/注销的账号 = 这个群从此无人可管。
      arrange({ actor: seat('owner-1') });
      prisma.chatMember.findMany.mockResolvedValue([
        seat('owner-1'),
        seat('u-2'),
      ]);
      prisma.user.findUnique.mockResolvedValue({
        nickname: '小方',
        status: 'BANNED',
      });
      await expect(
        service.transferOwnership('owner-1', 'conv-1', 'u-2'),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { errorCode: ChatErrorCode.PeerNotFound },
      });
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();

      prisma.user.findUnique.mockResolvedValue({
        nickname: '小方',
        status: 'ACTIVE',
      });
      prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(
        service.transferOwnership('owner-1', 'conv-1', 'u-2'),
      ).rejects.toMatchObject({
        constructor: ForbiddenException,
        response: { errorCode: ChatErrorCode.Blocked },
      });
      expect(prisma.block.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { blockerID: 'owner-1', blockedID: 'u-2' },
              { blockerID: 'u-2', blockedID: 'owner-1' },
            ],
          },
        }),
      );
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
    });
  });

  describe('setNotice / setAvatar', () => {
    it('stores a trimmed notice, clears on empty, and skips unchanged', async () => {
      arrange({ actor: seat('admin-1', { role: 'ADMIN' }) });
      await expect(
        service.setNotice('admin-1', 'conv-1', '  周末爬山  '),
      ).resolves.toEqual({
        notice: '周末爬山',
      });
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { notice: '周末爬山' },
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'group-notice-updated',
        actorId: 'admin-1',
      });

      jest.clearAllMocks();
      prisma.$transaction.mockImplementation(
        async (cb: (tx: typeof prisma) => unknown) => cb(prisma),
      );
      arrange({
        actor: seat('admin-1', { role: 'ADMIN' }),
        row: { notice: '周末爬山' },
      });
      await service.setNotice('admin-1', 'conv-1', '周末爬山');
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
      await expect(
        service.setNotice('admin-1', 'conv-1', '   '),
      ).resolves.toEqual({
        notice: null,
      });
    });

    it('rejects avatar URLs that are not served from app storage', async () => {
      arrange({ actor: seat('owner-1') });
      await expect(
        service.setAvatar('owner-1', 'conv-1', 'https://evil.example/a.png'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupAvatarUrlInvalid },
      });
      expect(prisma.chatMember.findUnique).not.toHaveBeenCalled();
    });

    it('stores a storage-served avatar and logs it', async () => {
      arrange({ actor: seat('owner-1') });
      const url = 'http://10.0.0.195:9000/circle/avatars/group.jpg';
      await expect(
        service.setAvatar('owner-1', 'conv-1', url),
      ).resolves.toEqual({
        avatarUrl: url,
      });
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { avatarUrl: url },
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'group-avatar-updated',
        actorId: 'owner-1',
      });
    });

    it('skips the write, the notice and the log when the avatar is unchanged', async () => {
      // 上传重试拿到同一个 key 时再插一条提示 + 一条群日志,就是凭空复制治理记录。
      const url = 'http://10.0.0.195:9000/circle/avatars/group.jpg';
      arrange({ actor: seat('owner-1'), row: { avatarUrl: url } });
      await expect(
        service.setAvatar('owner-1', 'conv-1', ` ${url} `),
      ).resolves.toEqual({ avatarUrl: url });
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).not.toHaveBeenCalled();
      expect(groupEvents.recordInTx).not.toHaveBeenCalled();
      expect(systemMessage.broadcastSystemMessage).not.toHaveBeenCalled();
    });
  });

  describe('updatePolicies', () => {
    it('writes only the keys that changed, one notice and log entry each', async () => {
      arrange({ actor: seat('owner-1') });
      const result = await service.updatePolicies('owner-1', 'conv-1', {
        membersCanAddFriends: false,
        qrJoinEnabled: true, // unchanged
        membersCanViewProfiles: false,
      });
      expect(result).toEqual({
        memberCanInvite: true,
        qrJoinEnabled: true,
        membersCanViewProfiles: false,
        membersCanAddFriends: false,
      });
      expect(prisma.chatConversation.update).toHaveBeenCalledTimes(2);
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { membersCanViewProfiles: false },
      });
      // 连续两条提示要串行取号:第二条建立在第一条的 height 之上。
      const heights =
        systemMessage.insertSystemMessageAfterLockedConversationInTx.mock.calls.map(
          (call) => call[2],
        );
      expect(heights).toEqual([10, 11]);
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'policy-changed',
        actorId: 'owner-1',
        payload: { policy: 'membersCanAddFriends', enabled: false },
      });
      expect(systemMessage.broadcastSystemMessage).toHaveBeenCalledTimes(2);
    });

    it('routes memberCanInvite to the Circle row for circle groups', async () => {
      arrange({
        actor: seat('admin-1'),
        row: { circleID: 'circle-1', ownerID: null },
        circleRole: 'ADMIN',
      });
      prisma.circle.findUnique.mockResolvedValue({ memberCanInvite: true });
      const result = await service.updatePolicies('admin-1', 'conv-1', {
        memberCanInvite: false,
      });
      expect(prisma.circle.update).toHaveBeenCalledWith({
        where: { id: 'circle-1' },
        data: { memberCanInvite: false },
      });
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
      expect(result.memberCanInvite).toBe(false);
    });

    it('rejects ordinary members before locking', async () => {
      arrange({ actor: seat('u-2') });
      await expect(
        service.updatePolicies('u-2', 'conv-1', { qrJoinEnabled: false }),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupManagerOnly },
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});

import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatGroupSettingsService } from './chat-group-settings.service';

/**
 * 群设置第二批:全员禁言开关、群主转让、独立群公告/头像、群策略开关。
 * 钉住:锁外先鉴权(非管理员碰不到会话行锁)、幂等不刷提示、圈子群的
 * memberCanInvite 写在 Circle、转让时新群主座位清零、头像 URL 只认本应用存储、
 * 进群渠道/邀请权限四个开关只记群日志不写灰字(成员端靠个人房 updated 同步)。
 */
describe('ChatGroupSettingsService', () => {
  const prisma = {
    chatMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    chatConversation: { update: jest.fn(), findUnique: jest.fn() },
    chatMessage: { findUnique: jest.fn() },
    chatPinnedMessage: {
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
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
  const circleMemberLock = {
    lock: jest.fn().mockResolvedValue(undefined),
    lockPolicy: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ChatGroupSettingsService(
    prisma as never,
    config as never,
    broadcast as never,
    systemMessage as never,
    groupEvents as never,
    circleMemberLock as never,
  );

  const locked = (overrides: Record<string, unknown> = {}) => ({
    id: 'conv-1',
    type: 'GROUP',
    circleID: null,
    ownerID: 'owner-1',
    nextHeight: 10,
    muteAllAt: null,
    notice: null,
    noticePinned: false,
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
    clearedBeforeHeight: 0,
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
        noticePinned: false,
      });
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { notice: '周末爬山', noticePinned: false },
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
        noticePinned: false,
      });
    });

    it('saves a pin-only change and broadcasts the existing notice event', async () => {
      arrange({
        actor: seat('admin-1', { role: 'ADMIN' }),
        row: { notice: '公告' },
      });
      await expect(
        service.setNotice('admin-1', 'conv-1', '公告', true),
      ).resolves.toEqual({ notice: '公告', noticePinned: true });
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { notice: '公告', noticePinned: true },
      });
      expect(systemMessage.broadcastSystemMessage).toHaveBeenCalledTimes(1);
    });

    it('turns broadcast off when the notice is cleared', async () => {
      arrange({
        actor: seat('owner-1'),
        row: { notice: '公告', noticePinned: true },
      });
      await expect(
        service.setNotice('owner-1', 'conv-1', '', true),
      ).resolves.toEqual({ notice: null, noticePinned: false });
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { notice: null, noticePinned: false },
      });
    });

    it('updates circle description and the shared conversation flag in one transaction', async () => {
      arrange({
        actor: seat('admin-1'),
        row: { circleID: 'circle-1' },
        circleRole: 'ADMIN',
      });
      prisma.circle.findUnique.mockResolvedValue({
        description: '旧公告',
        deleted: false,
      });
      await expect(
        service.setNotice('admin-1', 'conv-1', ' 新公告 ', true),
      ).resolves.toEqual({ notice: '新公告', noticePinned: true });
      expect(circleMemberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
        'admin-1',
      ]);
      expect(prisma.circle.update).toHaveBeenCalledWith({
        where: { id: 'circle-1' },
        data: { description: '新公告' },
      });
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { noticePinned: true },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('rejects a member broadcast change before taking a group lock', async () => {
      arrange({ actor: seat('member-1') });
      await expect(
        service.setNotice('member-1', 'conv-1', '公告', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('does not publish another notice for unchanged text and broadcast state', async () => {
      arrange({
        actor: seat('owner-1'),
        row: { notice: '公告', noticePinned: true },
      });
      await expect(
        service.setNotice('owner-1', 'conv-1', '公告', true),
      ).resolves.toEqual({ notice: '公告', noticePinned: true });
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
      expect(systemMessage.broadcastSystemMessage).not.toHaveBeenCalled();
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
    it('writes only the keys that changed, one notice and log entry each for member-facing toggles', async () => {
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
      // 灰字本身带着新状态,不用再逐人推 updated。
      expect(broadcast.emitConversationChange).not.toHaveBeenCalled();
    });

    // 进群渠道/邀请权限是管理设置:只记群日志(群主/管理员可见),不往聊天里写灰字。
    // 成员端的邀请按钮、群二维码入口仍要跟着变 —— 前端只认发给本人的 updated,逐人发。
    it('logs the join/invite toggles without a chat notice and tells every seated member to refresh', async () => {
      arrange({ actor: seat('owner-1') });
      prisma.chatMember.findMany.mockResolvedValue([
        { userID: 'owner-1' },
        { userID: 'u-2' },
      ]);
      const result = await service.updatePolicies('owner-1', 'conv-1', {
        qrJoinEnabled: false,
        membersCanViewRoster: false,
      });
      expect(result).toMatchObject({
        qrJoinEnabled: false,
        membersCanViewRoster: false,
      });
      // 只有成员可见的那个开关写灰字,且取号不被只记日志的键占用。
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledTimes(1);
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledWith(prisma, 'conv-1', 10, {
        kind: 'group-policy-changed',
        actorId: 'owner-1',
        policy: 'membersCanViewRoster',
        enabled: false,
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'policy-changed',
        actorId: 'owner-1',
        payload: { policy: 'qrJoinEnabled', enabled: false },
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledTimes(2);
      expect(prisma.chatMember.findMany).toHaveBeenCalledWith({
        where: { conversationID: 'conv-1', leftAt: null },
        select: { userID: true },
      });
      expect(broadcast.emitConversationChange).toHaveBeenCalledTimes(2);
      for (const userId of ['owner-1', 'u-2']) {
        expect(broadcast.emitConversationChange).toHaveBeenCalledWith(userId, {
          kind: 'updated',
          conversationId: 'conv-1',
          userId,
        });
      }
    });

    it('still returns the committed policies when the member refresh fan-out fails', async () => {
      arrange({ actor: seat('owner-1') });
      prisma.chatMember.findMany.mockRejectedValueOnce(
        new Error('pool exhausted for u-2'),
      );
      const warn = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);
      await expect(
        service.updatePolicies('owner-1', 'conv-1', {
          joinApprovalRequired: true,
        }),
      ).resolves.toMatchObject({ joinApprovalRequired: true });
      expect(groupEvents.recordInTx).toHaveBeenCalledTimes(1);
      expect(broadcast.emitConversationChange).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'group policy member sync failed after commit (Error)',
      );
      warn.mockRestore();
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
      expect(circleMemberLock.lockPolicy).toHaveBeenCalledWith(
        prisma,
        'circle-1',
      );
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
      expect(result.memberCanInvite).toBe(false);
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).not.toHaveBeenCalled();
      expect(systemMessage.broadcastSystemMessage).not.toHaveBeenCalled();
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'policy-changed',
        actorId: 'admin-1',
        payload: { policy: 'memberCanInvite', enabled: false },
      });
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
  describe('setPinnedMessage', () => {
    const message = (overrides: Record<string, unknown> = {}) => ({
      id: 'msg-1',
      conversationID: 'conv-1',
      height: 8,
      type: 'text',
      content: { text: '周六上午九点集合' },
      revokedAt: null,
      deleted: false,
      burnDurationSec: null,
      burnExpiresAt: null,
      ...overrides,
    });
    const PINNED_AT = new Date('2026-11-18T00:00:00.000Z');
    const pinRow = (overrides: Record<string, unknown> = {}) => ({
      conversationID: 'conv-1',
      messageID: 'msg-1',
      height: 8,
      preview: '周六上午九点集合',
      pinnedAt: PINNED_AT,
      pinnedByID: 'admin-1',
      ...overrides,
    });
    const arrangePin = (params: {
      actor: ReturnType<typeof seat>;
      row?: Record<string, unknown>;
      /** 这条消息已经在置顶栏里。 */
      alreadyPinned?: boolean;
      /** 会话里已有的置顶条数(水位以上)。 */
      count?: number;
      target?: Record<string, unknown> | null;
    }) => {
      arrange({
        actor: params.actor,
        row: { clearedBeforeHeight: 0, ...params.row },
      });
      prisma.chatPinnedMessage.findUnique.mockResolvedValue(
        params.alreadyPinned ? pinRow() : null,
      );
      prisma.chatPinnedMessage.count.mockResolvedValue(params.count ?? 0);
      prisma.chatPinnedMessage.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...data,
          pinnedAt: PINNED_AT,
        }),
      );
      prisma.chatPinnedMessage.deleteMany.mockResolvedValue({
        count: params.alreadyPinned ? 1 : 0,
      });
      prisma.chatMessage.findUnique.mockResolvedValue(
        params.target === undefined ? message() : params.target,
      );
    };

    it('a group admin pins a message for everyone and the change is announced', async () => {
      arrangePin({ actor: seat('admin-1', { role: 'ADMIN' }), count: 2 });
      const pinned = await service.setPinnedMessage(
        'admin-1',
        'conv-1',
        'msg-1',
        true,
      );
      expect(pinned).toEqual({
        messageId: 'msg-1',
        height: 8,
        preview: '周六上午九点集合',
        pinnedAt: PINNED_AT.toISOString(),
      });
      // 已有的置顶不动,新的加进去。
      expect(prisma.chatPinnedMessage.create).toHaveBeenCalledWith({
        data: {
          conversationID: 'conv-1',
          messageID: 'msg-1',
          height: 8,
          preview: '周六上午九点集合',
          pinnedByID: 'admin-1',
        },
      });
      expect(prisma.chatPinnedMessage.deleteMany).not.toHaveBeenCalled();
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledWith(prisma, 'conv-1', 10, {
        kind: 'message-pinned',
        actorId: 'admin-1',
      });
      expect(groupEvents.recordInTx).toHaveBeenCalledWith(prisma, 'conv-1', {
        kind: 'message-pinned',
        actorId: 'admin-1',
      });
      expect(systemMessage.broadcastSystemMessage).toHaveBeenCalled();
    });

    it('an ordinary group member cannot pin', async () => {
      arrangePin({ actor: seat('member-1') });
      await expect(
        service.setPinnedMessage('member-1', 'conv-1', 'msg-1', true),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.GroupManagerOnly },
      });
      expect(prisma.chatPinnedMessage.create).not.toHaveBeenCalled();
    });

    it('either side of a private chat can pin, without a group log entry', async () => {
      arrangePin({
        actor: seat('peer-1'),
        row: { type: 'DIRECT', ownerID: null },
      });
      prisma.$queryRaw.mockResolvedValue([{ nextHeight: 4 }]);
      await service.setPinnedMessage('peer-1', 'conv-1', 'msg-1', true);
      expect(prisma.chatPinnedMessage.create).toHaveBeenCalled();
      expect(groupEvents.recordInTx).not.toHaveBeenCalled();
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledWith(prisma, 'conv-1', 4, {
        kind: 'message-pinned',
        actorId: 'peer-1',
      });
    });

    // 拉黑不摘座位:被拉黑的一方不能再改对方看到的置顶栏、往对方会话里插提示。
    it('refuses a private-chat unpin when either side has blocked the other', async () => {
      arrangePin({
        actor: seat('peer-1'),
        row: { type: 'DIRECT', ownerID: null, directKey: 'peer-1:peer-2' },
        alreadyPinned: true,
      });
      prisma.$queryRaw.mockResolvedValue([{ nextHeight: 4 }]);
      prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(
        service.setPinnedMessage('peer-1', 'conv-1', 'msg-1', false),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.Blocked },
      });
      expect(prisma.block.findFirst).toHaveBeenCalledWith({
        where: {
          OR: [
            { blockerID: 'peer-1', blockedID: 'peer-2' },
            { blockerID: 'peer-2', blockedID: 'peer-1' },
          ],
        },
        select: { id: true },
      });
      expect(prisma.chatPinnedMessage.deleteMany).not.toHaveBeenCalled();
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).not.toHaveBeenCalled();
    });

    // 锁外读到之后、加锁之前刚提交了一次编辑:置顶栏要用锁内那份正文。
    it('builds the preview from the row re-read under the lock', async () => {
      arrangePin({ actor: seat('admin-1', { role: 'ADMIN' }) });
      prisma.chatMessage.findUnique
        .mockResolvedValueOnce(message())
        .mockResolvedValueOnce(message({ content: { text: '改成十点集合' } }));
      const pinned = await service.setPinnedMessage(
        'admin-1',
        'conv-1',
        'msg-1',
        true,
      );
      expect(pinned?.preview).toBe('改成十点集合');
      expect(prisma.chatPinnedMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ preview: '改成十点集合' }),
      });
    });

    // 一个群置顶好几篇笔记时,只看「[笔记]」分不出是哪篇。
    it('a pinned note card shows its title in the preview', async () => {
      arrangePin({
        actor: seat('admin-1', { role: 'ADMIN' }),
        target: message({
          type: 'note-card',
          content: { noteId: 'n1', title: '  周末羽毛球场地 ' },
        }),
      });
      const pinned = await service.setPinnedMessage(
        'admin-1',
        'conv-1',
        'msg-1',
        true,
      );
      expect(pinned?.preview).toBe('[笔记] 周末羽毛球场地');
    });

    it.each([
      ['a revoked message', { revokedAt: new Date() }],
      ['a deleted message', { deleted: true }],
      ['a system notice', { type: 'system' }],
      ['a message from another conversation', { conversationID: 'conv-2' }],
      ['a message below the cleared history', { height: 0 }],
      // 预览存在置顶行上,焚毁后置顶栏里还会留着原文。
      ['a burn-after-reading message', { burnDurationSec: 30 }],
      ['an expiring message', { burnExpiresAt: new Date() }],
    ])('refuses to pin %s', async (_case, overrides) => {
      arrangePin({
        actor: seat('admin-1', { role: 'ADMIN' }),
        target: message(overrides),
      });
      await expect(
        service.setPinnedMessage('admin-1', 'conv-1', 'msg-1', true),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.MessageNotFound },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('a message revoked while the pin was waiting for the lock is not pinned', async () => {
      arrangePin({ actor: seat('admin-1', { role: 'ADMIN' }) });
      prisma.chatMessage.findUnique
        .mockResolvedValueOnce(message())
        .mockResolvedValueOnce(message({ revokedAt: new Date() }));
      await expect(
        service.setPinnedMessage('admin-1', 'conv-1', 'msg-1', true),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.MessageNotFound },
      });
      expect(prisma.chatPinnedMessage.create).not.toHaveBeenCalled();
    });

    it('pinning an already pinned message changes nothing and announces nothing', async () => {
      arrangePin({
        actor: seat('admin-1', { role: 'ADMIN' }),
        alreadyPinned: true,
      });
      const pinned = await service.setPinnedMessage(
        'admin-1',
        'conv-1',
        'msg-1',
        true,
      );
      expect(pinned?.messageId).toBe('msg-1');
      expect(prisma.chatPinnedMessage.create).not.toHaveBeenCalled();
      expect(systemMessage.broadcastSystemMessage).not.toHaveBeenCalled();
    });

    // 上限在会话行锁内数;会话级清空水位以下的置顶谁都看不到,不占名额。
    it('refuses a sixth pin and counts only pins above the conversation floor', async () => {
      arrangePin({
        actor: seat('admin-1', { role: 'ADMIN' }),
        row: { clearedBeforeHeight: 3 },
        count: 5,
      });
      await expect(
        service.setPinnedMessage('admin-1', 'conv-1', 'msg-1', true),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: { errorCode: ChatErrorCode.PinLimitReached },
      });
      expect(prisma.chatPinnedMessage.count).toHaveBeenCalledWith({
        where: { conversationID: 'conv-1', height: { gt: 3 } },
      });
      expect(prisma.chatPinnedMessage.create).not.toHaveBeenCalled();
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).not.toHaveBeenCalled();
    });

    it('allows the fifth pin', async () => {
      arrangePin({ actor: seat('admin-1', { role: 'ADMIN' }), count: 4 });
      await service.setPinnedMessage('admin-1', 'conv-1', 'msg-1', true);
      expect(prisma.chatPinnedMessage.create).toHaveBeenCalled();
    });

    // 置顶之后那条消息可能已经焚毁 / 清空到水位以下:不看消息本身,照样要能取消。
    it('unpinning removes only that pin and announces it', async () => {
      arrangePin({
        actor: seat('admin-1', { role: 'ADMIN' }),
        alreadyPinned: true,
        target: null,
      });
      await expect(
        service.setPinnedMessage('admin-1', 'conv-1', 'msg-1', false),
      ).resolves.toBeNull();
      expect(prisma.chatMessage.findUnique).not.toHaveBeenCalled();
      expect(prisma.chatPinnedMessage.deleteMany).toHaveBeenCalledWith({
        where: { conversationID: 'conv-1', messageID: 'msg-1' },
      });
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledWith(prisma, 'conv-1', 10, {
        kind: 'message-unpinned',
        actorId: 'admin-1',
      });
    });

    it('unpinning a message that is not pinned announces nothing', async () => {
      arrangePin({ actor: seat('admin-1', { role: 'ADMIN' }) });
      await expect(
        service.setPinnedMessage('admin-1', 'conv-1', 'msg-1', false),
      ).resolves.toBeNull();
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).not.toHaveBeenCalled();
      expect(systemMessage.broadcastSystemMessage).not.toHaveBeenCalled();
    });

    it('someone who left the conversation cannot pin', async () => {
      arrangePin({ actor: seat('gone-1', { leftAt: new Date() }) });
      await expect(
        service.setPinnedMessage('gone-1', 'conv-1', 'msg-1', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});

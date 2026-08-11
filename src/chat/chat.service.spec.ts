import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatService } from './chat.service';
import type { ChatSendPayload } from './chat.types';

describe('ChatService', () => {
  const prisma = {
    chatConversation: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    chatMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    chatMessage: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    tempChatGuest: { findMany: jest.fn() },
    circleMember: { findUnique: jest.fn(), findMany: jest.fn() },
    chatMessageReaction: {
      create: jest.fn(),
      deleteMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    circle: { findMany: jest.fn() },
    block: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    friend: { findFirst: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const sensitiveWords = { check: jest.fn() };
  const circleSync = { ensureCircleConversation: jest.fn() };
  const media = {
    attachMediaUrls: jest.fn().mockResolvedValue(undefined),
    deleteObjects: jest.fn().mockResolvedValue(undefined),
  };
  const privacySettings = {
    canReceiveStrangerMessage: jest.fn().mockResolvedValue(true),
    // 默认关掉自动销毁,让既有用例不受时间窗口影响;需要时逐例覆盖。
    getSettings: jest.fn().mockResolvedValue({ messageSelfDestructDays: 0 }),
  };
  const broadcast = {
    joinUserToConversation: jest.fn().mockResolvedValue(undefined),
    emitRevoke: jest.fn(),
    emitRead: jest.fn(),
  };
  const systemMessage = {
    emit: jest.fn().mockResolvedValue(undefined),
    // 设置变更的留痕必须与设置本身同事务落地(emit 内部吞异常,await 它无用)。
    insertSystemMessageInTx: jest.fn(),
    broadcastSystemMessage: jest.fn(),
  };

  const service = new ChatService(
    prisma as never,
    sensitiveWords as never,
    circleSync as never,
    media as never,
    privacySettings as never,
    broadcast as never,
    systemMessage as never,
  );

  // tx 即 prisma 本身,tx.* 委托到同一批 mock。
  const runTx = async (cb: (tx: typeof prisma) => unknown) => cb(prisma);

  const membership = (overrides: Record<string, unknown> = {}) => ({
    id: 'member-1',
    conversationID: 'conv-1',
    userID: 'u1',
    lastReadHeight: 0,
    pinned: false,
    muted: false,
    leftAt: null,
    conversation: {
      id: 'conv-1',
      type: 'GROUP',
      directKey: null,
      circleID: null,
      tempChatID: null,
      lastMessageAt: null,
    },
    ...overrides,
  });

  const sendPayload = (
    overrides: Partial<ChatSendPayload> = {},
  ): ChatSendPayload => ({
    conversationId: 'conv-1',
    type: 'text',
    content: { text: 'hello' },
    d: 'client-msg-1',
    ...overrides,
  });

  const createdRow = {
    id: 'msg-1',
    conversationID: 'conv-1',
    height: 4,
    senderID: 'u1',
    type: 'text',
    content: { text: 'hello' },
    clientMessageId: 'client-msg-1',
    replyToID: null,
    deleted: false,
    createdAt: new Date('2026-08-05T12:00:00Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(runTx as never);
    prisma.$executeRaw.mockResolvedValue(1);
    sensitiveWords.check.mockReturnValue({ blocked: false });
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', nickname: '一波', avatarUrl: null },
    ]);
    prisma.circle.findMany.mockResolvedValue([]);
    prisma.tempChatGuest.findMany.mockResolvedValue([]);
    // 默认返回发号计数器行(G-05 行锁读)。列表类集合查询($queryRaw 复用同一 mock)
    // 读不到 conversationID 字段时得到 undefined 键,查找自然落空,等价「无行」。
    prisma.$queryRaw.mockResolvedValue([{ nextHeight: 3 }]);
    privacySettings.canReceiveStrangerMessage.mockResolvedValue(true);
    privacySettings.getSettings.mockResolvedValue({
      messageSelfDestructDays: 0,
    });
    broadcast.joinUserToConversation.mockResolvedValue(undefined);
    prisma.friend.findFirst.mockResolvedValue(null);
    // 搜索/焚毁读路径:默认没有会话开焚毁。
    prisma.chatConversation.findMany.mockResolvedValue([]);
    systemMessage.insertSystemMessageInTx.mockResolvedValue({
      id: 'sys-1',
      conversationId: 'conv-1',
      height: 9,
      type: 'system',
      content: {},
      sender: null,
      replyToId: null,
      d: null,
      createdAt: new Date().toISOString(),
    });
  });

  // 访客(临时房)没有 User 行:查隐私设置只会拿到 2 天默认值,而房间可以开
  // 3 天甚至 7 天 —— 活着的房间里超过 2 天的消息对访客凭空消失,他还没有任何
  // 地方能改这个设置。访客的保留边界是房间寿命,不是用户偏好。
  it('does not apply viewer retention to guest history', async () => {
    privacySettings.getSettings.mockResolvedValue({
      messageSelfDestructDays: 2,
    });
    prisma.chatMember.findUnique.mockResolvedValue(membership());
    prisma.chatMessage.findMany.mockResolvedValue([]);

    await service.getHistory(
      'guest-1',
      'conv-1',
      undefined,
      50,
      {},
      {
        applyViewerRetention: false,
      },
    );

    const [[args]] = prisma.chatMessage.findMany.mock.calls as [
      [{ where: Record<string, unknown> }],
    ];
    expect(args.where.AND).toBeUndefined();
    // 隐私设置压根不该被查 —— 访客 id 不对应任何 User。
    expect(privacySettings.getSettings).not.toHaveBeenCalled();
  });

  // 事务已提交,之后的富化只是装饰。抛出去的话 handleSend 既不广播也不推送,
  // 而客户端同 d 重发会命中幂等分支(刻意不广播)—— 一次瞬时的昵称查询失败
  // 就让这条消息对所有收件人永久消失,数据库里却存着。
  // G-05:发号走会话行计数器(SELECT..FOR UPDATE 行锁),不再做聚合扫描;
  // 复查与幂等判定在取号之前 —— 被拒/重发不烧号,height 无空洞无重复。
  it('allocates height from the conversation counter under a row lock', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(membership());
    prisma.chatMessage.findUnique.mockResolvedValue(null);
    prisma.$queryRaw.mockResolvedValue([{ nextHeight: 3 }]);
    prisma.chatMessage.create.mockResolvedValue(createdRow);
    prisma.chatConversation.update.mockResolvedValue({});

    const result = await service.sendMessage('u1', sendPayload());

    expect(result.reused).toBe(false);
    expect(prisma.chatMessage.aggregate).not.toHaveBeenCalled();
    expect(prisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ height: 4 }),
      }),
    );
    // 计数器前进与 lastMessageAt 合并成同一条 UPDATE。
    expect(prisma.chatConversation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          nextHeight: 4,
          lastMessageAt: expect.any(Date),
        }),
      }),
    );
  });

  it('still returns the message when post-commit sender enrichment fails', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(membership());
    prisma.chatMessage.findUnique.mockResolvedValue(null);
    prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 3 } });
    prisma.chatMessage.create.mockResolvedValue(createdRow);
    prisma.chatConversation.update.mockResolvedValue({});
    prisma.user.findMany.mockRejectedValue(new Error('db down'));

    const result = await service.sendMessage('u1', sendPayload());

    expect(result.reused).toBe(false);
    expect(result.message.id).toBe('msg-1');
    // 降级:昵称取不到就发 null,客户端仍有 senderID 可用。
    expect(result.message.sender).toBeNull();
  });

  describe('server-only message types', () => {
    // transfer-card 断言的是「钱已经划走」。它只由 GiftCardOutboxProcessor 在结算
    // 之后签发,客户端能发就等于能凭空捏造一笔转账 —— 伪造卡和真卡在收件人眼里
    // 完全一样。call-record / verification-card 同理(既成事实的服务端回执)。
    it.each(['transfer-card', 'call-record', 'verification-card', 'system'])(
      'rejects a client-sent %s',
      (type) => {
        expect(() =>
          service.validateSendPayload('u1', {
            conversationId: 'conv-1',
            type,
            d: 'client-1',
            content: { amount: 999_999 },
          } as never),
        ).toThrow(BadRequestException);
      },
    );

    // 分享类卡片只是指针(收件人点开会自己取真值),伪造顶多是条无效链接,
    // 不该被这条收口误伤。
    it.each(['text', 'image', 'note-card', 'friend-card', 'plaza-post-card'])(
      'still accepts %s from clients',
      (type) => {
        expect(() =>
          service.validateSendPayload('u1', {
            conversationId: 'conv-1',
            type,
            d: 'client-1',
            content:
              type === 'image' ? { key: 'chat/u1/a.jpg' } : { text: 'hi' },
          } as never),
        ).not.toThrow();
      },
    );
  });

  describe('sendMessage', () => {
    // 锁外校验与落库之间是一个真实窗口:踢人、拉黑、管理台禁言、临时房到期
    // 都可能恰好落在这中间。advisory lock 之后才是真正串行的位置,所以那几道
    // 判定必须在事务内用事务客户端再跑一遍 —— 否则「立刻生效」的封禁语义
    // 就变成了概率问题。
    it('rejects when the seat is revoked between the pre-check and the transaction', async () => {
      prisma.chatMember.findUnique
        // 锁外 requireMembership:此刻还在座
        .mockResolvedValueOnce(membership())
        // 事务内复查:已被踢出(座位置了 leftAt)
        .mockResolvedValueOnce(membership({ leftAt: new Date() }));
      prisma.chatMessage.findUnique.mockResolvedValue(null);

      await expect(service.sendMessage('u1', sendPayload())).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('persists with height = counter + 1 and returns the dto', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(null);
      prisma.$queryRaw.mockResolvedValue([{ nextHeight: 3 }]);
      prisma.chatMessage.create.mockResolvedValue(createdRow);
      prisma.chatConversation.update.mockResolvedValue({});

      const result = await service.sendMessage('u1', sendPayload());

      expect(result.reused).toBe(false);
      expect(result.message).toMatchObject({
        id: 'msg-1',
        conversationId: 'conv-1',
        height: 4,
        d: 'client-msg-1',
        sender: { id: 'u1', nickname: '一波' },
      });
      expect(prisma.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            height: 4,
            clientMessageId: 'client-msg-1',
          }),
        }),
      );
      // 会话活跃时间在同一事务内推进(会话列表排序依据)。
      expect(prisma.chatConversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'conv-1' } }),
      );
      // G-05:height 分配走会话行锁读(SELECT..FOR UPDATE),advisory lock 退役。
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.chatMessage.aggregate).not.toHaveBeenCalled();
    });

    it('returns the existing row on clientMessageId replay without re-persisting', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(createdRow);

      const result = await service.sendMessage('u1', sendPayload());

      expect(result.reused).toBe(true);
      expect(result.message.id).toBe('msg-1');
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
    });

    it('rejects senders that are not members', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(null);
      await expect(service.sendMessage('u1', sendPayload())).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects members that already left', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({ leftAt: new Date() }),
      );
      await expect(service.sendMessage('u1', sendPayload())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('blocks sensitive words before any DB write', async () => {
      sensitiveWords.check.mockReturnValue({ blocked: true, word: 'bad' });
      await expect(
        service.sendMessage('u1', sendPayload()),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.SensitiveWord },
      });
      expect(prisma.chatMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects server-only message types from clients', async () => {
      await expect(
        service.sendMessage('u1', sendPayload({ type: 'system' })),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.InvalidPayload },
      });
    });

    it('rejects media payloads that carry URLs instead of object keys', async () => {
      await expect(
        service.sendMessage(
          'u1',
          sendPayload({
            type: 'image',
            content: { key: 'https://evil.example/a.jpg' },
          }),
        ),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.InvalidPayload },
      });
      await expect(
        service.sendMessage(
          'u1',
          sendPayload({ type: 'voice', content: { duration: 3 } }),
        ),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.InvalidPayload },
      });
    });

    it("rejects media keys outside the sender's own chat namespace", async () => {
      // 从早期授权响应里学到的别人的私有 key,不能借聊天读路径无限续签。
      for (const key of [
        'notes/u2/private.jpg',
        'chat/u2/other.jpg',
        'chat/u1',
        'chat/u1/../notes/u2/private.jpg',
      ]) {
        await expect(
          service.sendMessage(
            'u1',
            sendPayload({ type: 'image', content: { key } }),
          ),
        ).rejects.toMatchObject({
          response: { errorCode: ChatErrorCode.InvalidPayload },
        });
      }
      // thumbKey 同样收口。
      await expect(
        service.sendMessage(
          'u1',
          sendPayload({
            type: 'image',
            content: { key: 'chat/u1/a.jpg', thumbKey: 'chat/u2/t.jpg' },
          }),
        ),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.InvalidPayload },
      });
    });

    it("accepts a media key inside the sender's own namespace", () => {
      expect(() =>
        service.validateSendPayload(
          'u1',
          sendPayload({
            type: 'image',
            content: { key: 'chat/u1/a.jpg', thumbKey: 'chat/u1/t.jpg' },
          }),
        ),
      ).not.toThrow();
    });

    it('strips client-supplied presentation fields from media content', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(null);
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 3 } });
      prisma.chatMessage.create.mockResolvedValue(createdRow);
      prisma.chatConversation.update.mockResolvedValue({});

      await service.sendMessage(
        'u1',
        sendPayload({
          type: 'image',
          content: {
            key: 'chat/u1/a.jpg',
            // 客户端塞的展示地址:签名失败时会原样存活并被渲染。
            url: 'https://attacker.example/1x1.gif',
            thumbUrl: 'https://attacker.example/t.gif',
            // 本机预览地址本不该上行;被塞成 https 就是个静默追踪信标。
            localUri: 'https://attacker.example/beacon.gif',
          },
        }),
      );

      const persisted = prisma.chatMessage.create.mock.calls[0][0].data.content;
      expect(persisted).toEqual({ key: 'chat/u1/a.jpg' });
    });

    it('rejects oversized content', async () => {
      await expect(
        service.sendMessage(
          'u1',
          sendPayload({ content: { text: 'x'.repeat(9000) } }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-checks blocks on DIRECT sends', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            id: 'conv-1',
            type: 'DIRECT',
            directKey: 'u1:u2',
            circleID: null,
            tempChatID: null,
            lastMessageAt: null,
          },
        }),
      );
      prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(
        service.sendMessage('u1', sendPayload()),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.Blocked },
      });
    });
  });

  describe('markRead', () => {
    it('advances the watermark and reports advancement', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 9 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.markRead('u1', 'conv-1', 5)).resolves.toEqual({
        advanced: true,
        height: 5,
      });
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
        where: {
          conversationID: 'conv-1',
          userID: 'u1',
          lastReadHeight: { lt: 5 },
        },
        data: { lastReadHeight: 5 },
      });
    });

    it('reports no advancement for stale watermarks (forward-only)', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 9 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.markRead('u1', 'conv-1', 1)).resolves.toEqual({
        advanced: false,
        height: 1,
      });
    });

    it('clamps a future watermark to the conversation height', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 9 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });

      // height=2e9 未钳位的话会永久压掉后续所有未读,并广播一条假已读。
      await expect(
        service.markRead('u1', 'conv-1', 2_000_000_000),
      ).resolves.toEqual({ advanced: true, height: 9 });
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastReadHeight: 9 } }),
      );
    });

    it('is a no-op on an empty conversation', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({
        _max: { height: null },
      });
      await expect(service.markRead('u1', 'conv-1', 5)).resolves.toEqual({
        advanced: false,
        height: 0,
      });
      expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
    });

    it('rejects non-integer heights', async () => {
      await expect(service.markRead('u1', 'conv-1', 1.5)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('filterVisiblePresenceTargets', () => {
    it('drops users that share no conversation with the requester', async () => {
      prisma.chatMember.findMany
        // listConversationIds
        .mockResolvedValueOnce([{ conversationID: 'conv-1' }])
        // 共处会话的目标
        .mockResolvedValueOnce([{ userID: 'u2' }]);

      await expect(
        service.filterVisiblePresenceTargets('u1', ['u2', 'stranger']),
      ).resolves.toEqual(['u2']);
    });

    // 拉黑不动 ChatMember,座位照旧留着 —— 只按共享会话过滤的话,拉黑双方
    // 仍能互相看到在线状态,等于把「我拉黑了你」变成一个可长期追踪的信道。
    it('hides peers on either side of a block even when a seat is shared', async () => {
      prisma.chatMember.findMany
        .mockResolvedValueOnce([{ conversationID: 'conv-1' }])
        .mockResolvedValueOnce([
          { userID: 'blocked-by-me' },
          { userID: 'blocked-me' },
          { userID: 'ok' },
        ]);
      prisma.block.findMany.mockResolvedValue([
        { blockerID: 'u1', blockedID: 'blocked-by-me' },
        { blockerID: 'blocked-me', blockedID: 'u1' },
      ]);

      await expect(
        service.filterVisiblePresenceTargets('u1', [
          'blocked-by-me',
          'blocked-me',
          'ok',
        ]),
      ).resolves.toEqual(['ok']);
    });

    it('always allows the requester itself and short-circuits', async () => {
      await expect(
        service.filterVisiblePresenceTargets('u1', ['u1']),
      ).resolves.toEqual(['u1']);
      expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
    });

    it('returns nothing when the requester has no conversations', async () => {
      prisma.chatMember.findMany.mockResolvedValueOnce([]);
      await expect(
        service.filterVisiblePresenceTargets('u1', ['u2']),
      ).resolves.toEqual([]);
    });
  });

  describe('getOrCreateDirectConversation', () => {
    const peer = {
      id: 'u2',
      nickname: '对方',
      avatarUrl: null,
      status: 'ACTIVE',
    };
    const conversationRow = {
      id: 'conv-9',
      type: 'DIRECT',
      directKey: 'u1:u2',
      lastMessageAt: null,
      members: [
        {
          id: 'm1',
          userID: 'u1',
          leftAt: null,
          pinned: false,
          muted: false,
          lastReadHeight: 0,
        },
        {
          id: 'm2',
          userID: 'u2',
          leftAt: null,
          pinned: false,
          muted: false,
          lastReadHeight: 0,
        },
      ],
    };

    it('rejects self conversations', async () => {
      await expect(
        service.getOrCreateDirectConversation('u1', 'u1'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.SelfConversation },
      });
    });

    it('rejects missing or inactive peers', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).rejects.toThrow(NotFoundException);
      prisma.user.findUnique.mockResolvedValue({ ...peer, status: 'BANNED' });
      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects blocked pairs in either direction', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.Blocked },
      });
    });

    it('refuses to open a chat with a stranger who disallows stranger messages', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      prisma.friend.findFirst.mockResolvedValue(null);
      privacySettings.canReceiveStrangerMessage.mockResolvedValue(false);

      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.StrangerNotAllowed },
      });
      // 只查拉黑放行的话,这里已经建好会话并可以立刻 socket 发消息了。
      expect(prisma.chatConversation.create).not.toHaveBeenCalled();
    });

    it('lets accepted friends through regardless of the stranger switch', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      prisma.friend.findFirst.mockResolvedValue({ id: 'f1' });
      prisma.chatConversation.create.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue(null);

      await service.getOrCreateDirectConversation('u1', 'u2');
      expect(privacySettings.canReceiveStrangerMessage).toHaveBeenCalledWith(
        'u2',
        true,
      );
    });

    it('does not re-check the switch for an existing conversation', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue(null);

      await service.getOrCreateDirectConversation('u1', 'u2');
      // 事后关掉开关不该把既有会话锁死。
      expect(privacySettings.canReceiveStrangerMessage).not.toHaveBeenCalled();
    });

    it("joins both members' live sockets to the conversation room", async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      prisma.chatConversation.create.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue(null);

      await service.getOrCreateDirectConversation('u1', 'u2');
      // 不 join 的话首条消息的房广播会漏掉在线的对端,推送还会误判他离线。
      expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
        'u1',
        'conv-9',
      );
      expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
        'u2',
        'conv-9',
      );
    });

    it('still returns the conversation when joining a room fails', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      broadcast.joinUserToConversation.mockRejectedValue(
        new Error('no server'),
      );

      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).resolves.toMatchObject({ id: 'conv-9' });
    });

    // ─── 结算专用解析 ────────────────────────────────────────────────────
    //
    // 服务端签发的回执(转账卡 / 通话留痕 / 好友申请回放)走这条路解析会话。
    // 座位落库不会自动 join 房间,而 handleConnection 只在**连接那一刻**把当时
    // 已有的会话加进来 —— 所以刚建出来的会话,双方在线的 socket 都不在房里,
    // 紧接着的 insertServerMessage 广播会播进一个空房间、静默丢给双方。
    describe('ensureDirectConversationForSettlement', () => {
      it("joins both members' live sockets when it creates the conversation", async () => {
        prisma.chatConversation.findUnique.mockResolvedValue(null);
        prisma.chatConversation.create.mockResolvedValue({ id: 'conv-new' });

        const id = await service.ensureDirectConversationForSettlement(
          'u1',
          'u2',
        );

        expect(id).toBe('conv-new');
        expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
          'u1',
          'conv-new',
        );
        expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
          'u2',
          'conv-new',
        );
      });

      it('joins both members when it loses the create race', async () => {
        // 对手赢了插入,但它的 join 未必已经跑完 —— 而我们马上就要往这个房间里
        // 播一条回执。补一次幂等的 join 比赌时序便宜。
        prisma.chatConversation.findUnique
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'conv-raced' });
        prisma.chatConversation.create.mockRejectedValue({ code: 'P2002' });

        const id = await service.ensureDirectConversationForSettlement(
          'u1',
          'u2',
        );

        expect(id).toBe('conv-raced');
        expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
          'u1',
          'conv-raced',
        );
        expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
          'u2',
          'conv-raced',
        );
      });

      it('does not re-join when the conversation already existed', async () => {
        // 会话在连接之前就存在 → handleConnection 已经把双方加进房了
        // (DIRECT 座位的 leftAt 恒为 null,不会被那条过滤挡掉)。
        // 多播一次 join 是一次跨节点 fetchSockets,白花的。
        prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-9' });

        const id = await service.ensureDirectConversationForSettlement(
          'u1',
          'u2',
        );

        expect(id).toBe('conv-9');
        expect(broadcast.joinUserToConversation).not.toHaveBeenCalled();
      });

      it('still returns the conversation when joining fails', async () => {
        // 尽力而为:结算链路不能因为「房间没加上」而失败 —— 钱/通话已经发生了,
        // 客户端下次重连时 handleConnection 会补上。
        prisma.chatConversation.findUnique.mockResolvedValue(null);
        prisma.chatConversation.create.mockResolvedValue({ id: 'conv-new' });
        broadcast.joinUserToConversation.mockRejectedValue(
          new Error('no server'),
        );

        await expect(
          service.ensureDirectConversationForSettlement('u1', 'u2'),
        ).resolves.toBe('conv-new');
      });
    });

    it('returns the real last message for an existing conversation', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue({
        id: 'msg-7',
        conversationID: 'conv-9',
        height: 7,
        senderID: 'u1',
        type: 'text',
        content: { text: '在吗' },
        clientMessageId: 'd-7',
        replyToID: null,
        deleted: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const dto = await service.getOrCreateDirectConversation('u1', 'u2');
      // 恒 null 会把客户端缓存里的会话预览抹成空白。
      expect(dto.lastMessage).toMatchObject({ id: 'msg-7', height: 7 });
    });

    it('creates with a sorted directKey and both member rows', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      prisma.chatConversation.create.mockResolvedValue({
        id: 'conv-9',
        type: 'DIRECT',
        directKey: 'u1:u2',
        lastMessageAt: null,
        members: [
          {
            id: 'm1',
            userID: 'u1',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
          {
            id: 'm2',
            userID: 'u2',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
        ],
      });
      prisma.chatMessage.count.mockResolvedValue(0);

      const dto = await service.getOrCreateDirectConversation('u1', 'u2');

      expect(prisma.chatConversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ directKey: 'u1:u2' }),
        }),
      );
      expect(dto).toMatchObject({
        id: 'conv-9',
        type: 'DIRECT',
        peer: { id: 'u2' },
      });
    });

    it('recovers from a directKey unique race by refetching', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      const existing = {
        id: 'conv-9',
        type: 'DIRECT',
        directKey: 'u1:u2',
        lastMessageAt: null,
        members: [
          {
            id: 'm1',
            userID: 'u1',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
          {
            id: 'm2',
            userID: 'u2',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
        ],
      };
      prisma.chatConversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing);
      prisma.chatConversation.create.mockRejectedValue({ code: 'P2002' });
      prisma.chatMessage.count.mockResolvedValue(0);

      const dto = await service.getOrCreateDirectConversation('u1', 'u2');
      expect(dto.id).toBe('conv-9');
    });

    it('revives a membership the user previously left', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue({
        id: 'conv-9',
        type: 'DIRECT',
        directKey: 'u1:u2',
        lastMessageAt: null,
        members: [
          {
            id: 'm1',
            userID: 'u1',
            leftAt: new Date(),
            pinned: false,
            muted: false,
            lastReadHeight: 3,
          },
          {
            id: 'm2',
            userID: 'u2',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
        ],
      });
      prisma.chatMember.update.mockResolvedValue({});
      prisma.chatMessage.count.mockResolvedValue(0);

      await service.getOrCreateDirectConversation('u1', 'u2');
      expect(prisma.chatMember.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { leftAt: null },
      });
    });
  });

  describe('getHistory', () => {
    it('pages by height keyset and returns ascending pages', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([
        { ...createdRow, id: 'msg-5', height: 5 },
        { ...createdRow, id: 'msg-4', height: 4 },
      ]);

      const page = await service.getHistory('u1', 'conv-1', 6, 2);

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ height: { lt: 6 }, deleted: false }),
          orderBy: { height: 'desc' },
          take: 2,
        }),
      );
      expect(page.messages.map((m) => m.height)).toEqual([4, 5]);
      // 满页 → 还有更早的,游标 = 页内最低 height。
      expect(page.nextBeforeHeight).toBe(4);
    });

    it('signals exhaustion with a null cursor on a short page', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([createdRow]);
      const page = await service.getHistory('u1', 'conv-1', undefined, 50);
      expect(page.nextBeforeHeight).toBeNull();
    });

    // G-13 重连对账:断线窗口内的消息要能按 height 升序增量补拉。
    it('pulls forward incrementally with afterHeight and an ascending cursor', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([
        { ...createdRow, id: 'msg-7', height: 7 },
        { ...createdRow, id: 'msg-8', height: 8 },
      ]);

      const page = await service.getHistory('u1', 'conv-1', undefined, 2, {
        afterHeight: 6,
      });

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            height: { gt: 6 },
            deleted: false,
          }),
          orderBy: { height: 'asc' },
          take: 2,
        }),
      );
      expect(page.messages.map((m) => m.height)).toEqual([7, 8]);
      // 满页 → 可能还没追平,游标 = 页内最高 height;向旧翻页的游标不混用。
      expect(page.nextAfterHeight).toBe(8);
      expect(page.nextBeforeHeight).toBeNull();
    });

    it('signals caught-up with a null afterHeight cursor on a short page', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([
        { ...createdRow, id: 'msg-7', height: 7 },
      ]);

      const page = await service.getHistory('u1', 'conv-1', undefined, 50, {
        afterHeight: 6,
      });

      expect(page.nextAfterHeight).toBeNull();
    });

    it('rejects supplying both pagination cursors at once', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());

      await expect(
        service.getHistory('u1', 'conv-1', 9, 50, { afterHeight: 6 }),
      ).rejects.toThrow(BadRequestException);
    });

    // 按日期过滤同样写 createdAt。销毁截止若和它并在同一层,会被整个盖掉 ——
    // 客户端带上 date 就能翻出窗口之外的消息。两者必须同时成立。
    it('keeps the self-destruct cutoff when a date filter is also supplied', async () => {
      privacySettings.getSettings.mockResolvedValue({
        messageSelfDestructDays: 2,
      });
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([]);

      await service.getHistory('u1', 'conv-1', undefined, 50, {
        date: '2020-01-01',
        tzOffsetMinutes: 0,
      });

      const [[args]] = prisma.chatMessage.findMany.mock.calls as [
        [{ where: Record<string, any> }],
      ];
      // 日期过滤照常生效……
      expect(args.where.createdAt).toEqual({
        gte: new Date('2020-01-01T00:00:00.000Z'),
        lt: new Date('2020-01-02T00:00:00.000Z'),
      });
      // ……而销毁截止作为独立的 AND 条件仍然在,没有被它顶掉。
      expect(args.where.AND).toEqual([
        { createdAt: { gte: expect.any(Date) } },
      ]);
    });

    it('applies type/keyword/date filters onto the where clause', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([]);

      // 东八区(getTimezoneOffset = -480)的 2026-08-05:UTC 前一日 16:00 起算。
      await service.getHistory('u1', 'conv-1', undefined, 50, {
        types: ['image'],
        keyword: '合同',
        date: '2026-08-05',
        tzOffsetMinutes: -480,
      });

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: { in: ['image'] },
            content: { path: ['text'], string_contains: '合同' },
            createdAt: {
              gte: new Date('2026-08-04T16:00:00.000Z'),
              lt: new Date('2026-08-05T16:00:00.000Z'),
            },
          }),
        }),
      );
    });

    it('uses the next local-midnight offset on a DST transition day', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([]);

      await service.getHistory('u1', 'conv-1', undefined, 50, {
        date: '2026-03-08',
        tzOffsetMinutes: 480,
        tzEndOffsetMinutes: 420,
      });

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: {
              gte: new Date('2026-03-08T08:00:00.000Z'),
              lt: new Date('2026-03-09T07:00:00.000Z'),
            },
          }),
        }),
      );
    });

    it('denies non-members', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(null);
      await expect(service.getHistory('u1', 'conv-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('listMessageDays', () => {
    it('groups message timestamps into client-timezone days', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([
        // UTC 8/4 17:00 = 东八区 8/5 01:00;UTC 8/5 15:00 = 东八区 8/5 23:00。
        { createdAt: new Date('2026-08-04T17:00:00.000Z') },
        { createdAt: new Date('2026-08-05T15:00:00.000Z') },
        { createdAt: new Date('2026-08-05T17:00:00.000Z') }, // 东八区 8/6
      ]);

      const days = await service.listMessageDays('u1', 'conv-1', 2026, 7, -480);
      expect(days).toEqual(['2026-08-05', '2026-08-06']);
    });

    it('uses the IANA timezone for month boundaries and per-message days', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([
        { createdAt: new Date('2026-03-08T07:30:00.000Z') }, // 3/7 23:30 PST
        { createdAt: new Date('2026-03-08T08:30:00.000Z') }, // 3/8 00:30 PST
      ]);

      const days = await service.listMessageDays(
        'u1',
        'conv-1',
        2026,
        2,
        420,
        'America/Los_Angeles',
      );

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: {
              gte: new Date('2026-03-01T08:00:00.000Z'),
              lt: new Date('2026-04-01T07:00:00.000Z'),
            },
          }),
        }),
      );
      expect(days).toEqual(['2026-03-07', '2026-03-08']);
    });

    it('denies non-members', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(null);
      await expect(
        service.listMessageDays('u1', 'conv-1', 2026, 7, 0),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('listMembers', () => {
    it('rejects ordinary GROUP members before reading the directory', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            ...membership().conversation,
            circleID: 'circle-1',
          },
        }),
      );
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'MEMBER',
        status: 'ACTIVE',
      });

      await expect(service.listMembers('u1', 'conv-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
    });

    it('allows active GROUP administrators to read the directory', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            ...membership().conversation,
            circleID: 'circle-1',
          },
        }),
      );
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
      });
      prisma.chatMember.findMany.mockResolvedValue([{ userID: 'u1' }]);
      prisma.circleMember.findMany.mockResolvedValue([
        { userID: 'u1', role: 'ADMIN' },
      ]);

      await expect(service.listMembers('u1', 'conv-1')).resolves.toEqual([
        expect.objectContaining({ userId: 'u1', role: 'ADMIN' }),
      ]);
    });
  });

  describe('searchAllMessages', () => {
    it('returns empty for blank keywords without querying', async () => {
      await expect(service.searchAllMessages('u1', '  ')).resolves.toEqual([]);
      expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
    });

    // 搜索必须和 getHistory 用同一把尺子:自动销毁窗口之外的消息在历史里
    // 看不到、一搜就出来的话,这个设置等于形同虚设。
    it('applies the same self-destruct cutoff as history', async () => {
      privacySettings.getSettings.mockResolvedValue({
        messageSelfDestructDays: 2,
      });
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1' },
      ]);
      prisma.chatMessage.findMany.mockResolvedValue([]);

      await service.searchAllMessages('u1', 'hello');

      const [[args]] = prisma.chatMessage.findMany.mock.calls as [
        [{ where: { createdAt?: { gte: Date } } }],
      ];
      expect(args.where.createdAt?.gte).toBeInstanceOf(Date);
      const ageMs =
        Date.now() - (args.where.createdAt as { gte: Date }).gte.getTime();
      expect(ageMs).toBeGreaterThan(47 * 60 * 60 * 1000);
      expect(ageMs).toBeLessThan(49 * 60 * 60 * 1000);
    });

    it('scopes the search to conversations the user is seated in', async () => {
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1' },
        { conversationID: 'conv-2' },
      ]);
      prisma.chatMessage.findMany.mockResolvedValue([createdRow]);

      const rows = await service.searchAllMessages('u1', 'hello');

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            // 没清空过、没开焚毁的会话合成一支 IN;带水位/焚毁的各自展开。
            OR: [{ conversationID: { in: ['conv-1', 'conv-2'] } }],
            type: { in: ['text', 'quote'] },
            content: { path: ['text'], string_contains: 'hello' },
          }),
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('listConversations', () => {
    it('returns dtos with unread counts excluding own messages', async () => {
      prisma.chatMember.findMany
        .mockResolvedValueOnce([
          {
            ...membership(),
            conversation: {
              id: 'conv-1',
              type: 'DIRECT',
              directKey: 'u1:u2',
              circleID: null,
              tempChatID: null,
              lastMessageAt: new Date('2026-08-05T12:00:00Z'),
            },
          },
        ])
        // loadDirectPeers 的对端成员查询。
        .mockResolvedValueOnce([{ conversationID: 'conv-1', userID: 'u2' }]);
      // 末条消息与未读数各一次集合查询(不再每会话一次往返)。
      prisma.$queryRaw
        .mockResolvedValueOnce([createdRow])
        .mockResolvedValueOnce([
          { conversationID: 'conv-1', count: BigInt(2) },
        ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u1', nickname: '一波', avatarUrl: null },
        { id: 'u2', nickname: '对方', avatarUrl: null },
      ]);

      const list = await service.listConversations('u1');

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'conv-1',
        type: 'DIRECT',
        peer: { id: 'u2' },
        unreadCount: 2,
        lastMessage: { id: 'msg-1' },
      });
    });

    it('keeps the query count flat as the conversation list grows', async () => {
      const rows = Array.from({ length: 60 }, (_, i) => ({
        ...membership(),
        conversationID: `conv-${i}`,
        conversation: {
          id: `conv-${i}`,
          type: 'GROUP',
          directKey: null,
          circleID: null,
          tempChatID: null,
          lastMessageAt: new Date('2026-08-05T12:00:00Z'),
        },
      }));
      prisma.chatMember.findMany.mockResolvedValueOnce(rows);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.listConversations('u1');

      // 60 个会话 → 2 次集合查询(末条 + 未读),而不是 120 次往返。
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.chatMessage.findFirst).not.toHaveBeenCalled();
      expect(prisma.chatMessage.count).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreateCircleConversation', () => {
    it('rejects callers that are not ACTIVE circle members', async () => {
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'PENDING' });
      await expect(
        service.getOrCreateCircleConversation('u1', 'circle-1'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.NotMember },
      });
      expect(circleSync.ensureCircleConversation).not.toHaveBeenCalled();
    });

    it('syncs seats on access and returns the conversation dto', async () => {
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      circleSync.ensureCircleConversation.mockResolvedValue('conv-g');
      prisma.chatMember.findUnique.mockResolvedValue({
        ...membership(),
        conversationID: 'conv-g',
        conversation: {
          id: 'conv-g',
          type: 'GROUP',
          directKey: null,
          circleID: 'circle-1',
          tempChatID: null,
          lastMessageAt: null,
        },
      });
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      prisma.chatMessage.count.mockResolvedValue(0);

      const dto = await service.getOrCreateCircleConversation('u1', 'circle-1');

      expect(circleSync.ensureCircleConversation).toHaveBeenCalledWith(
        'circle-1',
      );
      expect(dto).toMatchObject({
        id: 'conv-g',
        type: 'GROUP',
        circleId: 'circle-1',
        unreadCount: 0,
      });
    });
  });

  describe('setConversationPreferences', () => {
    it('updates pinned/muted for the caller seat only', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMember.update.mockResolvedValue({});
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMember.findMany.mockResolvedValue([]);
      prisma.user.findMany.mockResolvedValue([]);

      await service.setConversationPreferences('u1', 'conv-1', {
        pinned: true,
      });

      expect(prisma.chatMember.update).toHaveBeenCalledWith({
        where: {
          conversationID_userID: { conversationID: 'conv-1', userID: 'u1' },
        },
        data: { pinned: true },
      });
    });

    it('maps hidden boolean onto the hiddenAt timestamp', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMember.update.mockResolvedValue({});
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMember.findMany.mockResolvedValue([]);
      prisma.user.findMany.mockResolvedValue([]);

      await service.setConversationPreferences('u1', 'conv-1', {
        hidden: true,
      });
      expect(prisma.chatMember.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { hiddenAt: expect.any(Date) } }),
      );

      await service.setConversationPreferences('u1', 'conv-1', {
        hidden: false,
      });
      expect(prisma.chatMember.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { hiddenAt: null } }),
      );
    });
  });

  it('a new message unhides the conversation for every member', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(membership());
    prisma.chatMessage.findUnique.mockResolvedValue(null);
    prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 3 } });
    prisma.chatMessage.create.mockResolvedValue(createdRow);
    prisma.chatConversation.update.mockResolvedValue({});
    prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });

    await service.sendMessage('u1', sendPayload());

    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
  });

  describe('revokeMessage(G-02)', () => {
    const revokableRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'm1',
      conversationID: 'conv-1',
      senderID: 'u1',
      type: 'image',
      content: { key: 'chat/u1/a.jpg', thumbKey: 'chat/u1/a.t.jpg' },
      height: 5,
      replyToID: null,
      clientMessageId: 'd1',
      deleted: false,
      revokedAt: null,
      revokedBy: null,
      createdAt: new Date(),
      ...overrides,
    });

    it('sender revokes within the window: clears content, deletes media, broadcasts', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(revokableRow());
      prisma.chatMessage.updateMany.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          revoked = { ...revokableRow(), ...data };
          return { count: 1 };
        },
      );
      let revoked: Record<string, unknown> = revokableRow();
      prisma.chatMessage.findUniqueOrThrow.mockImplementation(
        async () => revoked,
      );

      const dto = await service.revokeMessage('u1', 'conv-1', 'm1');

      // 条件更新(revokedAt: null)才是幂等的落点:并发双撤只有一个赢家。
      expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm1', revokedAt: null },
          data: expect.objectContaining({
            content: {},
            revokedBy: 'u1',
            revokedAt: expect.any(Date),
          }),
        }),
      );
      // 撤回即焚:对象存储里的媒体一并删,只清 DB 等于没撤。
      expect(media.deleteObjects).toHaveBeenCalledWith([
        'chat/u1/a.jpg',
        'chat/u1/a.t.jpg',
      ]);
      expect(broadcast.emitRevoke).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        messageId: 'm1',
        revokedBy: 'u1',
      });
      expect(dto.revokedBy).toBe('u1');
      expect(dto.content).toEqual({});
    });

    it('rejects the sender outside the two-minute window', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(
        revokableRow({ createdAt: new Date(Date.now() - 3 * 60_000) }),
      );

      await expect(
        service.revokeMessage('u1', 'conv-1', 'm1'),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_REVOKE_WINDOW_EXPIRED' },
      });
      expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
    });

    const circleConversation = {
      id: 'conv-1',
      type: 'GROUP',
      directKey: null,
      circleID: 'circle-1',
      tempChatID: null,
      lastMessageAt: null,
    };

    it('lets a circle owner/admin revoke others messages without a window', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({ userID: 'admin-1', conversation: circleConversation }),
      );
      prisma.chatMessage.findUnique.mockResolvedValue(
        revokableRow({ createdAt: new Date(Date.now() - 60 * 60_000) }),
      );
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'ADMIN',
        status: 'ACTIVE',
      });
      let revoked: Record<string, unknown> = revokableRow();
      prisma.chatMessage.updateMany.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          revoked = { ...revokableRow(), ...data };
          return { count: 1 };
        },
      );
      prisma.chatMessage.findUniqueOrThrow.mockImplementation(
        async () => revoked,
      );

      const dto = await service.revokeMessage('admin-1', 'conv-1', 'm1');
      expect(dto.revokedBy).toBe('admin-1');
    });

    it('rejects an unrelated member', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({ userID: 'u2', conversation: circleConversation }),
      );
      prisma.chatMessage.findUnique.mockResolvedValue(revokableRow());
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'MEMBER',
        status: 'ACTIVE',
      });

      await expect(
        service.revokeMessage('u2', 'conv-1', 'm1'),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_REVOKE_FORBIDDEN' },
      });
    });

    it('is idempotent for an already revoked message', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(
        revokableRow({
          content: {},
          revokedAt: new Date(),
          revokedBy: 'u1',
        }),
      );

      const dto = await service.revokeMessage('u1', 'conv-1', 'm1');
      expect(dto.revokedBy).toBe('u1');
      expect(prisma.chatMessage.update).not.toHaveBeenCalled();
      expect(broadcast.emitRevoke).not.toHaveBeenCalled();
    });
  });

  describe('markDelivered(G-07 送达水位)', () => {
    it('clamps to the conversation ceiling and only moves forward', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 9 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.markDelivered('u1', 'conv-1', 2_000_000);

      expect(result).toEqual({ advanced: true, height: 9 });
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
        where: {
          conversationID: 'conv-1',
          userID: 'u1',
          lastDeliveredHeight: { lt: 9 },
        },
        data: { lastDeliveredHeight: 9 },
      });
    });
  });

  describe('toggleReaction(G-07 表情回应)', () => {
    const reactableRow = {
      conversationID: 'conv-1',
      deleted: false,
      revokedAt: null,
    };

    it('rejects emojis outside the whitelist', async () => {
      await expect(
        service.toggleReaction('u1', 'conv-1', 'm1', '🦖', 'add'),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_INVALID_PAYLOAD' },
      });
    });

    it('adds once and treats duplicate adds as no-change', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(reactableRow);
      prisma.chatMessageReaction.create.mockResolvedValueOnce({});

      await expect(
        service.toggleReaction('u1', 'conv-1', 'm1', '👍', 'add'),
      ).resolves.toEqual({ changed: true });

      prisma.chatMessageReaction.create.mockRejectedValueOnce({
        code: 'P2002',
      });
      await expect(
        service.toggleReaction('u1', 'conv-1', 'm1', '👍', 'add'),
      ).resolves.toEqual({ changed: false });
    });

    it('silently ignores reactions on revoked messages', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue({
        ...reactableRow,
        revokedAt: new Date(),
      });
      await expect(
        service.toggleReaction('u1', 'conv-1', 'm1', '👍', 'add'),
      ).resolves.toEqual({ changed: false });
      expect(prisma.chatMessageReaction.create).not.toHaveBeenCalled();
    });

    it('removes an existing reaction', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(reactableRow);
      prisma.chatMessageReaction.deleteMany.mockResolvedValue({ count: 1 });
      await expect(
        service.toggleReaction('u1', 'conv-1', 'm1', '👍', 'remove'),
      ).resolves.toEqual({ changed: true });
    });
  });

  describe('editMessage(G-07 消息编辑)', () => {
    const editableRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'm1',
      conversationID: 'conv-1',
      senderID: 'u1',
      type: 'text',
      content: { text: 'old text' },
      height: 5,
      replyToID: null,
      clientMessageId: 'd1',
      deleted: false,
      revokedAt: null,
      revokedBy: null,
      editedAt: null,
      contentHistory: null,
      createdAt: new Date(),
      ...overrides,
    });

    it('lets the sender edit text within the window and keeps a history trail', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(editableRow());
      let edited: Record<string, unknown> = editableRow();
      prisma.chatMessage.updateMany.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => {
          edited = { ...editableRow(), ...data };
          return { count: 1 };
        },
      );
      prisma.chatMessage.findUniqueOrThrow.mockImplementation(
        async () => edited,
      );

      const dto = await service.editMessage('u1', 'conv-1', 'm1', {
        text: 'new text',
      });

      // 条件写:撤回/焚毁抢先落地时这次编辑必须落空,不能把正文塞回去。
      expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'm1', revokedAt: null, deleted: false },
          data: expect.objectContaining({
            content: expect.objectContaining({ text: 'new text' }),
            editedAt: expect.any(Date),
            contentHistory: [{ text: 'old text' }],
          }),
        }),
      );
      expect(dto.content['text']).toBe('new text');
      expect(dto.editedAt).toEqual(expect.any(String));
    });

    it('rejects a non-sender with CHAT_EDIT_FORBIDDEN', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({ userID: 'u2' }),
      );
      prisma.chatMessage.findUnique.mockResolvedValue(editableRow());
      await expect(
        service.editMessage('u2', 'conv-1', 'm1', { text: 'x' }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_EDIT_FORBIDDEN' },
      });
    });

    it('rejects outside the window with CHAT_EDIT_WINDOW_EXPIRED', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(
        editableRow({ createdAt: new Date(Date.now() - 3 * 60_000) }),
      );
      await expect(
        service.editMessage('u1', 'conv-1', 'm1', { text: 'x' }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_EDIT_WINDOW_EXPIRED' },
      });
    });

    it('runs the sensitive-word check on the new text', async () => {
      sensitiveWords.check.mockReturnValue({ blocked: true, word: '敏感' });
      await expect(
        service.editMessage('u1', 'conv-1', 'm1', { text: '有敏感词' }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_SENSITIVE_WORD_BLOCKED' },
      });
    });

    it('refuses to edit non-text types', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(
        editableRow({ type: 'image', content: { key: 'chat/u1/a.jpg' } }),
      );
      await expect(
        service.editMessage('u1', 'conv-1', 'm1', { text: 'x' }),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_EDIT_FORBIDDEN' },
      });
    });
  });

  describe('listMessageReaders(G-07 逐条已读)', () => {
    it('returns seated members whose read watermark covers the height, excluding the sender', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue({
        conversationID: 'conv-1',
        height: 5,
        senderID: 'u1',
        createdAt: new Date(),
      });
      prisma.chatMember.findMany.mockResolvedValue([
        { userID: 'u2' },
        { userID: 'u3' },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u2', nickname: 'B', avatarUrl: null },
        { id: 'u3', nickname: 'C', avatarUrl: null },
      ]);

      prisma.chatMember.count.mockResolvedValue(2);

      const result = await service.listMessageReaders('u1', 'conv-1', 'm1');

      expect(prisma.chatMember.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            lastReadHeight: { gte: 5 },
            userID: { not: 'u1' },
            leftAt: null,
            // 入群前的消息不算这位成员读过 —— 新座位的水位是按当前最高初始化的。
            joinedAt: { lte: expect.any(Date) },
          }),
        }),
      );
      expect(result.total).toBe(2);
      expect(result.readers.map((r) => r.nickname)).toEqual(['B', 'C']);
    });
  });

  describe('setBurnDuration(S-01 会话级阅后即焚)', () => {
    it('any DIRECT member sets it for both sides and a notice is left', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            id: 'conv-1',
            type: 'DIRECT',
            directKey: 'a:b',
            circleID: null,
            tempChatID: null,
            lastMessageAt: null,
            burnDurationSec: null,
          },
        }),
      );
      prisma.chatConversation.update.mockResolvedValue({
        id: 'conv-1',
        burnDurationSec: 3600,
      });

      const result = await service.setBurnDuration('u1', 'conv-1', 3600);

      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { burnDurationSec: 3600 },
      });
      // 开关变更必须留系统痕迹,防「对方偷偷开了焚毁」——
      // 而且要和设置更新在同一个事务里(emit 内部吞异常,await 它等于没做)。
      expect(systemMessage.insertSystemMessageInTx).toHaveBeenCalledWith(
        expect.anything(),
        'conv-1',
        { kind: 'burn-changed', seconds: 3600 },
      );
      // 广播在提交之后,否则事务回滚了客户端却已经收到那条提示。
      expect(systemMessage.broadcastSystemMessage).toHaveBeenCalled();
      expect(result.burnDurationSec).toBe(3600);
    });

    it('normalizes 0 to off(null)', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            id: 'conv-1',
            type: 'DIRECT',
            directKey: 'a:b',
            circleID: null,
            tempChatID: null,
            lastMessageAt: null,
            burnDurationSec: 3600,
          },
        }),
      );
      prisma.chatConversation.update.mockResolvedValue({
        id: 'conv-1',
        burnDurationSec: null,
      });

      // 关掉焚毁 = 放宽:先把旧策略下已过期的消息真删掉(分批,这里一批清完)。
      prisma.chatMessage.findMany.mockResolvedValue([]);

      const result = await service.setBurnDuration('u1', 'conv-1', 0);
      expect(prisma.chatConversation.update).toHaveBeenCalledWith({
        where: { id: 'conv-1' },
        data: { burnDurationSec: null },
      });
      expect(result.burnDurationSec).toBeNull();
      expect(systemMessage.insertSystemMessageInTx).toHaveBeenCalledWith(
        expect.anything(),
        'conv-1',
        { kind: 'burn-changed', seconds: 0 },
      );
    });

    it('GROUP requires a circle owner/admin', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            id: 'conv-1',
            type: 'GROUP',
            directKey: null,
            circleID: 'circle-1',
            tempChatID: null,
            lastMessageAt: null,
            burnDurationSec: null,
          },
        }),
      );
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'MEMBER',
        status: 'ACTIVE',
      });

      await expect(
        service.setBurnDuration('u1', 'conv-1', 3600),
      ).rejects.toMatchObject({
        response: { errorCode: 'GROUP_MANAGER_ONLY' },
      });
    });

    it('TEMP conversations reject the toggle (guest retention = room lifetime)', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            id: 'conv-1',
            type: 'TEMP',
            directKey: null,
            circleID: null,
            tempChatID: 'tc-1',
            lastMessageAt: null,
            burnDurationSec: null,
          },
        }),
      );
      await expect(
        service.setBurnDuration('u1', 'conv-1', 3600),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_INVALID_PAYLOAD' },
      });
    });
  });

  describe('clearHistory(G-14 清空聊天记录)', () => {
    it('advances the personal watermark and read floor to the current max height', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 42 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.clearHistory('u1', 'conv-1');

      expect(result.clearedBeforeHeight).toBe(42);
      // 只前进不后退:并发/重放不能把水位拉回去。
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
        where: {
          conversationID: 'conv-1',
          userID: 'u1',
          clearedBeforeHeight: { lt: 42 },
        },
        data: { clearedBeforeHeight: 42 },
      });
      // 清空即已读:未读同时归零,底数与水位一致。
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
        where: {
          conversationID: 'conv-1',
          userID: 'u1',
          lastReadHeight: { lt: 42 },
        },
        data: { lastReadHeight: 42 },
      });
    });

    it('is a no-op for an empty conversation', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({
        _max: { height: null },
      });

      const result = await service.clearHistory('u1', 'conv-1');
      expect(result.clearedBeforeHeight).toBe(0);
      expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getHistory 清空水位与会话级焚毁', () => {
    it('applies the personal cleared floor together with keyset cursors', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({ clearedBeforeHeight: 7 }),
      );
      prisma.chatMessage.findMany.mockResolvedValue([]);

      await service.getHistory('u1', 'conv-1', 20, 50);

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ height: { gt: 7, lt: 20 } }),
        }),
      );
    });

    it('tightens retention to the stricter of viewer setting and conversation burn', async () => {
      privacySettings.getSettings.mockResolvedValue({
        messageSelfDestructDays: 7,
      });
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            id: 'conv-1',
            type: 'DIRECT',
            directKey: 'a:b',
            circleID: null,
            tempChatID: null,
            lastMessageAt: null,
            burnDurationSec: 3600,
          },
        }),
      );
      prisma.chatMessage.findMany.mockResolvedValue([]);

      await service.getHistory('u1', 'conv-1', undefined, 50);

      const [[args]] = prisma.chatMessage.findMany.mock.calls as [
        [{ where: { AND?: Array<{ createdAt: { gte: Date } }> } }],
      ];
      const cutoff = args.where.AND?.[0]?.createdAt?.gte;
      expect(cutoff).toBeInstanceOf(Date);
      // 更严 = 更晚的截止:1 小时焚毁窗口应覆盖 7 天的查看者设置。
      expect(Date.now() - (cutoff as Date).getTime()).toBeLessThan(
        2 * 60 * 60 * 1000,
      );
    });
  });

  describe('getHistory replyTo(G-09 真引用)', () => {
    it('attaches reply snapshots in one batch and flags revoked originals', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      const original = {
        id: 'orig-1',
        conversationID: 'conv-1',
        senderID: 'u2',
        type: 'text',
        content: { text: '原始内容原始内容' },
        height: 3,
        replyToID: null,
        clientMessageId: null,
        deleted: false,
        revokedAt: null,
        revokedBy: null,
        createdAt: new Date(),
      };
      const revokedOriginal = {
        ...original,
        id: 'orig-2',
        height: 4,
        content: {},
        revokedAt: new Date(),
        revokedBy: 'u2',
      };
      const quote = {
        ...original,
        id: 'q-1',
        senderID: 'u1',
        type: 'quote',
        content: { text: '回帖', quotedText: '原始内容原始内容' },
        height: 5,
        replyToID: 'orig-1',
      };
      const quoteOfRevoked = {
        ...quote,
        id: 'q-2',
        height: 6,
        replyToID: 'orig-2',
      };
      prisma.chatMessage.findMany
        .mockResolvedValueOnce([quoteOfRevoked, quote])
        // 第二次 findMany = replyTo 批量取原消息
        .mockResolvedValueOnce([original, revokedOriginal]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u1', nickname: 'A', avatarUrl: null },
        { id: 'u2', nickname: 'B', avatarUrl: null },
      ]);

      const page = await service.getHistory('u1', 'conv-1', undefined, 50);

      const q1 = page.messages.find((m) => m.id === 'q-1');
      expect(q1?.replyTo).toEqual(
        expect.objectContaining({
          id: 'orig-1',
          height: 3,
          senderNickname: 'B',
          type: 'text',
          revoked: false,
        }),
      );
      expect(typeof q1?.replyTo?.preview).toBe('string');
      const q2 = page.messages.find((m) => m.id === 'q-2');
      expect(q2?.replyTo).toEqual(
        expect.objectContaining({ id: 'orig-2', revoked: true }),
      );
      // 只允许一次批量 IN,不得逐条 N+1
      expect(prisma.chatMessage.findMany).toHaveBeenCalledTimes(2);
      // 被引用消息已撤回 → 连客户端塞的 quotedText 文本快照也要抹掉,
      // 否则「撤回」只撤掉了原消息,原文还躺在每一条引用它的消息里。
      expect(q2?.content['quotedText']).toBe('');
      expect(q1?.content['quotedText']).toBe('原始内容原始内容');
    });

    it('never attaches a reply snapshot from another conversation', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      const foreign = {
        id: 'orig-x',
        conversationID: 'conv-OTHER',
        senderID: 'u2',
        type: 'text',
        content: { text: '别的会话里的秘密' },
        height: 3,
        replyToID: null,
        clientMessageId: null,
        deleted: false,
        revokedAt: null,
        revokedBy: null,
        createdAt: new Date(),
      };
      const quote = {
        ...foreign,
        id: 'q-x',
        conversationID: 'conv-1',
        senderID: 'u1',
        type: 'quote',
        content: { text: '回帖', quotedText: '别的会话里的秘密' },
        height: 5,
        replyToID: 'orig-x',
      };
      prisma.chatMessage.findMany
        .mockResolvedValueOnce([quote])
        .mockResolvedValueOnce([foreign]);

      const page = await service.getHistory('u1', 'conv-1', undefined, 50);

      expect(page.messages[0].replyTo).toBeUndefined();
      expect(page.messages[0].content['quotedText']).toBe('');
    });

    it('hides reply snapshots below the viewer clear watermark', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({ clearedBeforeHeight: 4 }),
      );
      const cleared = {
        id: 'orig-c',
        conversationID: 'conv-1',
        senderID: 'u2',
        type: 'text',
        content: { text: '清空之前的内容' },
        height: 3,
        replyToID: null,
        clientMessageId: null,
        deleted: false,
        revokedAt: null,
        revokedBy: null,
        createdAt: new Date(),
      };
      const quote = {
        ...cleared,
        id: 'q-c',
        senderID: 'u1',
        type: 'quote',
        content: { text: '回帖', quotedText: '清空之前的内容' },
        height: 9,
        replyToID: 'orig-c',
      };
      prisma.chatMessage.findMany
        .mockResolvedValueOnce([quote])
        .mockResolvedValueOnce([cleared]);

      const page = await service.getHistory('u1', 'conv-1', undefined, 50);

      // 清空过的段落不能靠引用块原样端回来。
      expect(page.messages[0].replyTo).toBeUndefined();
      expect(page.messages[0].content['quotedText']).toBe('');
    });
  });

  describe('引用归属校验(跨会话读)', () => {
    it('rejects a replyToId that belongs to another conversation', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue({
        conversationID: 'conv-OTHER',
        deleted: false,
      });

      await expect(
        service.sendMessage('u1', sendPayload({ replyToId: 'foreign-msg' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });

    it('degrades to no reference when the original is gone (not an attack)', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique
        .mockResolvedValueOnce(null) // resolveReplyTarget:原消息已被焚毁/清理
        .mockResolvedValueOnce(null); // 幂等查重
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 3 } });
      prisma.chatMessage.create.mockResolvedValue(createdRow);
      prisma.chatConversation.update.mockResolvedValue({});
      prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });

      await service.sendMessage('u1', sendPayload({ replyToId: 'gone' }));

      expect(prisma.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ replyToID: null }),
        }),
      );
    });

    it('still delivers when post-commit reply enrichment fails', async () => {
      // 事务已提交:装饰失败绝不能把这条消息变成「对所有人不存在」——
      // handleSend 会回错误 ack 且不广播,而客户端拿同一个 d 重发命中幂等分支,
      // 那条分支刻意不广播。
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(null);
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 3 } });
      prisma.chatMessage.create.mockResolvedValue({
        ...createdRow,
        replyToID: 'orig-1',
      });
      prisma.chatConversation.update.mockResolvedValue({});
      prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });
      prisma.chatMessage.findMany.mockRejectedValue(new Error('db blip'));

      const result = await service.sendMessage('u1', sendPayload());

      expect(result.message.id).toBe('msg-1');
      expect(result.message.replyTo).toBeUndefined();
    });
  });

  describe('单聊拉黑对「改动」路径的约束', () => {
    const directMembership = () =>
      membership({
        conversation: {
          id: 'conv-1',
          type: 'DIRECT',
          directKey: 'u1:u2',
          circleID: null,
          tempChatID: null,
          lastMessageAt: null,
          burnDurationSec: null,
        },
      });

    beforeEach(() => {
      prisma.chatMember.findUnique.mockResolvedValue(directMembership());
      // 任一方向拉黑。
      prisma.block.findFirst.mockResolvedValue({ id: 'b1' });
    });

    it('blocks burn-duration changes from a blocked peer', async () => {
      // 发不了消息的人,不该有把对方整段历史设成 30 秒后销毁的能力。
      await expect(
        service.setBurnDuration('u1', 'conv-1', 30),
      ).rejects.toMatchObject({ response: { errorCode: 'CHAT_BLOCKED' } });
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
    });

    it('blocks reactions from a blocked peer', async () => {
      await expect(
        service.toggleReaction('u1', 'conv-1', 'm1', '👍', 'add'),
      ).rejects.toMatchObject({ response: { errorCode: 'CHAT_BLOCKED' } });
      expect(prisma.chatMessageReaction.create).not.toHaveBeenCalled();
    });

    it('blocks edits from a blocked peer', async () => {
      await expect(
        service.editMessage('u1', 'conv-1', 'm1', { text: 'x' }),
      ).rejects.toMatchObject({ response: { errorCode: 'CHAT_BLOCKED' } });
      expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('系统消息不可撤回', () => {
    it('refuses a moderator revoking a server-authored notice', async () => {
      // 圈主开了阅后即焚,再把「对方开启了阅后即焚」这条唯一痕迹撤掉 ——
      // 留痕的意义正在于撤不掉。
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          userID: 'admin-1',
          conversation: {
            id: 'conv-1',
            type: 'GROUP',
            directKey: null,
            circleID: 'circle-1',
            tempChatID: null,
            lastMessageAt: null,
          },
        }),
      );
      prisma.chatMessage.findUnique.mockResolvedValue({
        id: 'sys-1',
        conversationID: 'conv-1',
        senderID: null,
        type: 'system',
        content: { kind: 'burn-changed', seconds: 30 },
        height: 7,
        deleted: false,
        revokedAt: null,
        createdAt: new Date(),
      });
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'OWNER',
        status: 'ACTIVE',
      });

      await expect(
        service.revokeMessage('admin-1', 'conv-1', 'sys-1'),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_REVOKE_FORBIDDEN' },
      });
      expect(prisma.chatMessage.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('放宽焚毁时长前先落地已过期的消息', () => {
    it('tombstones already-expired rows before relaxing the policy', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            id: 'conv-1',
            type: 'GROUP',
            directKey: null,
            circleID: 'circle-1',
            tempChatID: null,
            lastMessageAt: null,
            burnDurationSec: 60,
          },
        }),
      );
      prisma.circleMember.findUnique.mockResolvedValue({
        role: 'OWNER',
        status: 'ACTIVE',
      });
      prisma.chatMessage.findMany.mockResolvedValue([
        { id: 'old-1', type: 'image', content: { key: 'chat/u1/a.jpg' } },
      ]);
      prisma.chatMessage.updateMany.mockResolvedValue({ count: 1 });
      prisma.chatConversation.update.mockResolvedValue({
        id: 'conv-1',
        burnDurationSec: null,
      });

      await service.setBurnDuration('admin-1', 'conv-1', null);

      // 已到期、只是还没轮到 sweeper 的行必须先真删,否则关掉焚毁之后
      // 那些「已经烧掉」的消息连同新签名的媒体 URL 一起重新可读。
      expect(prisma.chatMessage.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deleted: true,
            content: {},
            contentHistory: [],
          }),
        }),
      );
      expect(media.deleteObjects).toHaveBeenCalledWith(['chat/u1/a.jpg']);
    });
  });

  describe('清空即已读要广播', () => {
    it('emits the same read event markRead would', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 9 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });

      await service.clearHistory('u1', 'conv-1');

      // 不播的话,对端的已读回执和本账号其他设备的红点会一直停在旧水位。
      expect(broadcast.emitRead).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        userId: 'u1',
        height: 9,
      });
    });
  });

  describe('listMutationsSince(离线撤回/编辑追平)', () => {
    const mutatedRow = (overrides: Record<string, unknown> = {}) => ({
      id: 'm-revoked',
      conversationID: 'conv-1',
      height: 2,
      senderID: 'u1',
      type: 'text',
      content: {},
      clientMessageId: null,
      replyToID: null,
      deleted: false,
      revokedAt: new Date(),
      revokedBy: 'u1',
      editedAt: null,
      createdAt: new Date(),
      mutatedAt: new Date(),
      ...overrides,
    });

    it('returns rows mutated after the cursor regardless of height', async () => {
      // 撤回不改 height,所以 afterHeight 补拉结构上永远看不到它。
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1', clearedBeforeHeight: 0 },
      ]);
      prisma.$queryRaw.mockResolvedValue([mutatedRow()]);

      const result = await service.listMutationsSince(
        'u1',
        new Date(Date.now() - 60_000),
      );

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].revokedAt).toEqual(expect.any(String));
      expect(typeof result.serverTime).toBe('string');
      // 没被截断,但游标**不能**贴到 serverTime:未提交的写会被跨过去。
      // 停在安全水位上(见 MUTATION_SAFETY_LAG_MS)。
      expect(result.hasMore).toBe(false);
      expect(Date.parse(result.nextSince)).toBeLessThan(
        Date.parse(result.serverTime),
      );
    });

    it('stops the cursor at the last returned mutation when truncated', async () => {
      // 截断了还回 serverTime 的话,没返回的那些变更被永久跳过 ——
      // 撤回的正文会一直留在对方屏幕上。
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1', clearedBeforeHeight: 0 },
      ]);
      // 时间取相对值:这一页必须整体落在安全水位**之下**,否则游标会被水位
      // 卡住(那是另一条用例在测的行为)。
      const boundary = new Date(Date.now() - 80 * 60_000);
      // 服务端多取一条用于判断「还有没有」:limit=2 时返回 3 条。
      prisma.$queryRaw.mockResolvedValue([
        mutatedRow({ id: 'm1', mutatedAt: new Date(Date.now() - 90 * 60_000) }),
        mutatedRow({ id: 'm2', mutatedAt: boundary }),
        mutatedRow({ id: 'm3', mutatedAt: new Date(Date.now() - 70 * 60_000) }),
      ]);

      const result = await service.listMutationsSince(
        'u1',
        new Date(Date.now() - 120 * 60_000),
        2,
      );

      expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
      expect(result.hasMore).toBe(true);
      expect(result.nextSince).toBe(boundary.toISOString());
      // id 必须一起带回去:毫秒精度下同刻并列很常见,只带时间戳的游标配
      // `> from` 会把剩下那些同刻的行永久跳过。
      expect(result.nextSinceId).toBe('m2');
    });

    it('never advances the cursor into the uncommitted-write window', async () => {
      // 时间戳在写语句构造时生成,行到 COMMIT 才可见:一次被锁住的撤回完全
      // 可以「时间戳很早、提交很晚」。同步把游标推到 serverTime 的话,它提交
      // 之后就永远落在游标后面 —— 那条撤回的正文会一直留在对方屏幕上。
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1', clearedBeforeHeight: 0 },
      ]);
      prisma.$queryRaw.mockResolvedValue([]);

      const since = new Date(Date.now() - 10 * 60_000);
      const result = await service.listMutationsSince('u1', since);

      const advanced = Date.parse(result.nextSince);
      // 空同步也一样:游标必须停在安全水位之下,不能贴到 serverTime。
      expect(advanced).toBeLessThanOrEqual(Date.now() - 59_000);
      expect(advanced).toBeGreaterThan(since.getTime());
    });

    it('does not rewind the cursor when the safety lag would push it backwards', async () => {
      // 客户端刚同步过(since 很新),安全水位比它还老 —— 这时既不能倒退,
      // 也不能谎报 hasMore 让它空转。
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1', clearedBeforeHeight: 0 },
      ]);
      prisma.$queryRaw.mockResolvedValue([]);

      const since = new Date(Date.now() - 1_000);
      const result = await service.listMutationsSince('u1', since);

      expect(result.nextSince).toBe(since.toISOString());
      expect(result.hasMore).toBe(false);
    });

    it('stops paging rather than spinning when the whole page is too fresh', async () => {
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1', clearedBeforeHeight: 0 },
      ]);
      const since = new Date(Date.now() - 2_000);
      // 整页都落在不安全窗口里:游标推不动。
      prisma.$queryRaw.mockResolvedValue([
        mutatedRow({ id: 'm1', mutatedAt: new Date(Date.now() - 1_500) }),
        mutatedRow({ id: 'm2', mutatedAt: new Date(Date.now() - 1_000) }),
        mutatedRow({ id: 'm3', mutatedAt: new Date(Date.now() - 500) }),
      ]);

      const result = await service.listMutationsSince('u1', since, 2);

      // 消息照常投递(用户马上就能看到撤回),但游标原地不动 + hasMore=false:
      // 谎报 hasMore 而游标不动会让客户端一直空转。
      expect(result.messages).toHaveLength(2);
      expect(result.nextSince).toBe(since.toISOString());
      expect(result.hasMore).toBe(false);
    });

    it('reports resetRequired instead of silently clamping an ancient cursor', async () => {
      // 默默把游标抬到窗口下沿的话,客户端以为自己追平了,而那段区间里被撤回的
      // 消息在它缓存里永远是原文(撤回不改 height,历史补拉够不着)。
      const result = await service.listMutationsSince(
        'u1',
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      );

      expect(result.resetRequired).toBe(true);
      expect(result.messages).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('pushes the clear watermark and burn cutoff into the query, not a post-filter', async () => {
      // 取回来再 filter 的话,被过滤掉的行照样占着 LIMIT 的名额:一页里真正
      // 该返回的变更变少了,而客户端游标照常前进。
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1', clearedBeforeHeight: 5 },
      ]);
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-1', burnDurationSec: 30 },
      ]);
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await service.listMutationsSince(
        'u1',
        new Date(Date.now() - 60_000),
      );

      expect(result.messages).toEqual([]);
      // 原始 SQL 的参数里带上了每会话的 height 下界与截止时间。
      const calls = prisma.$queryRaw.mock.calls as unknown[][];
      const params = calls[calls.length - 1].slice(1);
      expect(params).toContainEqual(['conv-1']);
      expect(params).toContainEqual([5]);
      const cutoffs = params.find(
        (p): p is (Date | null)[] =>
          Array.isArray(p) && p[0] instanceof Date && p.length === 1,
      );
      expect(cutoffs?.[0]).toBeInstanceOf(Date);
    });
  });

  describe('quote 兜底快照的内容审核', () => {
    it('rejects blocked words hidden in content.quotedText', async () => {
      // quotedText 是客户端塞的原文快照,会原样落库并广播。只检 text 的话:
      // text 无害 + replyToId 指向不存在的消息(引用被降级成 null)+ 违禁内容
      // 全塞进 quotedText —— 敏感词检查一个字都看不到。
      sensitiveWords.check.mockImplementation((value: string) => ({
        blocked: value.includes('违禁'),
      }));
      prisma.chatMember.findUnique.mockResolvedValue(membership());

      await expect(
        service.sendMessage(
          'u1',
          sendPayload({
            type: 'quote',
            content: { text: '你看这个', quotedText: '违禁内容' },
          }),
        ),
      ).rejects.toMatchObject({
        response: { errorCode: 'CHAT_SENSITIVE_WORD_BLOCKED' },
      });
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    });
  });

  describe('searchAllMessages 的清空水位', () => {
    it('excludes the cleared segment from global search', async () => {
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1', clearedBeforeHeight: 7 },
        { conversationID: 'conv-2', clearedBeforeHeight: 0 },
      ]);
      prisma.chatMessage.findMany.mockResolvedValue([]);

      await service.searchAllMessages('u1', 'hello');

      const [[args]] = prisma.chatMessage.findMany.mock.calls as [
        [{ where: { OR: unknown[] } }],
      ];
      // 清空过的会话单独一支带 height 下界;没清空过的仍走同一个 IN。
      expect(args.where.OR).toEqual([
        { conversationID: { in: ['conv-2'] } },
        { conversationID: 'conv-1', height: { gt: 7 } },
      ]);
    });
  });
});

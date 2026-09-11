import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from 'src/chat/chat.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CollectionService } from './collection.service';

describe('CollectionService', () => {
  let service: CollectionService;

  const prisma = {
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    userCollection: {
      findMany: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
      // #104 审查加的每用户上限检查
      count: jest.fn().mockResolvedValue(0),
    },
    // 收藏不再自己查消息:可见性判定整条交给 ChatService.requireVisibleMessage。
    // 留着这个桩就是为了下面那条「一次都不该调」的断言。
    chatMessage: { findFirst: jest.fn(), findUnique: jest.fn() },
  };

  const chat = { requireVisibleMessage: jest.fn() };

  /** requireVisibleMessage 的返回形状(消息行 + 会话 + 座位)。 */
  const visible = (
    row: Record<string, unknown> = {},
    conversation: Record<string, unknown> = {},
  ) => ({
    row: {
      id: 'msg-1',
      conversationID: 'conversation-1',
      senderID: 'peer-1',
      type: 'text',
      content: { text: 'verified text' },
      height: 9,
      createdAt: new Date('2026-09-08T08:00:00.000Z'),
      ...row,
    },
    conversation: {
      id: 'conversation-1',
      type: 'DIRECT',
      burnDurationSec: null,
      ...conversation,
    },
    member: { userID: 'user-1', clearedBeforeHeight: 0 },
  });

  const createdPayload = () =>
    prisma.userCollection.create.mock.calls[0][0].data.payload;
  const createdData = () => prisma.userCollection.create.mock.calls[0][0].data;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.userCollection.count.mockResolvedValue(0);
    prisma.userCollection.create.mockResolvedValue({ id: 'c-1' });
    chat.requireVisibleMessage.mockResolvedValue(visible());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionService,
        { provide: PrismaService, useValue: prisma },
        { provide: ChatService, useValue: chat },
      ],
    }).compile();

    service = module.get<CollectionService>(CollectionService);
  });

  it('lists the current user collections by type', async () => {
    prisma.userCollection.findMany.mockResolvedValue([
      {
        id: 'collection-1',
        userID: 'user-1',
        type: 'CHAT',
        title: '收藏聊天记录',
        summary: '一段重要聊天',
        sourceID: 'msg-1',
        payload: null,
        createdAt: new Date('2026-04-22T12:00:00.000Z'),
        updatedAt: new Date('2026-04-22T12:00:00.000Z'),
      },
    ]);

    const items = await service.list('user-1', 'CHAT');

    expect(items).toHaveLength(1);
    expect(prisma.userCollection.findMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', type: 'CHAT' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  });

  it('creates a non-message collection with the client title and summary', async () => {
    prisma.userCollection.create.mockResolvedValue({
      id: 'collection-1',
      userID: 'user-1',
      type: 'NOTE',
      title: '旅行笔记',
      summary: '收藏的笔记',
      sourceID: 'note-1',
      payload: { noteId: 'note-1' },
      createdAt: new Date('2026-04-22T12:00:00.000Z'),
      updatedAt: new Date('2026-04-22T12:00:00.000Z'),
    });

    const item = await service.create('user-1', {
      type: 'NOTE',
      title: '旅行笔记',
      summary: '收藏的笔记',
      sourceID: 'note-1',
      payload: { noteId: 'note-1' },
    });

    expect(item.title).toBe('旅行笔记');
    expect(prisma.userCollection.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-1',
        type: 'NOTE',
        title: '旅行笔记',
        summary: '收藏的笔记',
        sourceID: 'note-1',
        payload: { noteId: 'note-1' },
      },
    });
  });

  it('deletes only collections owned by the current user', async () => {
    prisma.userCollection.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.remove('user-1', 'collection-1')).rejects.toThrow(
      NotFoundException,
    );

    expect(prisma.userCollection.deleteMany).toHaveBeenCalledWith({
      where: { id: 'collection-1', userID: 'user-1' },
    });
  });

  it('rejects creating past the per-user cap with COLLECTION_LIMIT (#104)', async () => {
    prisma.userCollection.count.mockResolvedValueOnce(500);

    await expect(
      service.create('user-1', {
        type: 'NOTE' as never,
        title: 't',
        summary: 's',
        sourceID: 'x',
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: 'COLLECTION_LIMIT' }),
    });
    expect(prisma.userCollection.create).not.toHaveBeenCalled();
  });

  const messageCollection = (
    messageID: string,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      type: 'MESSAGE',
      title: '收藏消息',
      sourceID: messageID,
      payload: { kind: 'openim-message', messageID, ...extra },
    }) as never;

  const expectInvalidSource = async (promise: Promise<unknown>) => {
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'COLLECTION_INVALID_MESSAGE_SOURCE',
      }),
    });
    expect(prisma.userCollection.create).not.toHaveBeenCalled();
  };

  // 转发那条 CHAT_FORWARD_FORBIDDEN 的理由在这里一字不差地成立，但收藏走的是
  // 另一扇门：客户端拼好快照直接 POST，服务端从头到尾没看过那条消息，于是
  // chat.service 里那道闸完全够不着它。
  it('refuses to collect a peer message from a burn-after-reading conversation', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({ senderID: 'peer-1' }, { burnDurationSec: 60 }),
    );

    await expect(
      service.create('user-1', messageCollection('msg-1')),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'COLLECTION_EPHEMERAL_FORBIDDEN',
      }),
    });
    expect(prisma.userCollection.create).not.toHaveBeenCalled();
  });

  // 与转发口径一致：自己的内容重发一次效果完全一样，拦下来不保护任何人。
  it('still collects your own message from a burn conversation', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({ senderID: 'user-1' }, { burnDurationSec: 60 }),
    );

    await service.create('user-1', messageCollection('msg-1'));

    expect(prisma.userCollection.create).toHaveBeenCalled();
    expect(createdPayload()).not.toHaveProperty('senderID');
  });

  it('leaves ordinary conversations alone', async () => {
    await service.create('user-1', messageCollection('msg-1'));

    expect(chat.requireVisibleMessage).toHaveBeenCalledWith('user-1', 'msg-1');
    expect(prisma.userCollection.create).toHaveBeenCalled();
  });

  it('rejects a message collection without an authoritative message id', async () => {
    await expectInvalidSource(
      service.create('user-1', {
        type: 'MESSAGE',
        title: 'copied text',
        payload: { kind: 'openim-message', text: 'peer secret' },
      } as never),
    );
  });

  it('rejects other message-backed collection types without an authoritative message id', async () => {
    await expectInvalidSource(
      service.create('user-1', {
        type: 'VIDEO',
        title: 'copied video',
        payload: { url: 'https://attacker.invalid/video.mp4' },
      } as never),
    );
  });

  it('rejects a sourceID that disagrees with the payload message id', async () => {
    await expectInvalidSource(
      service.create('user-1', {
        type: 'MESSAGE',
        title: 'mismatched',
        sourceID: 'msg-2',
        payload: { kind: 'openim-message', messageID: 'msg-1' },
      } as never),
    );
  });

  // 可见性的每条拒绝路径都在 ChatService.requireVisibleMessage 上有用例
  // (删除/撤回/退群/清空水位/焚毁窗口)。收藏这边要钉的是:那两种拒绝都被翻译成
  // 收藏自己的错误码,不把 chat 的错误码漏成收藏接口的契约。
  it('maps an invisible message (404 from chat) to COLLECTION_INVALID_MESSAGE_SOURCE', async () => {
    chat.requireVisibleMessage.mockRejectedValue(
      new NotFoundException({
        message: '消息不存在',
        errorCode: 'CHAT_MESSAGE_NOT_FOUND',
      }),
    );

    await expectInvalidSource(
      service.create('user-1', messageCollection('missing-msg')),
    );
  });

  it('maps a non-member viewer (403 from chat) to COLLECTION_INVALID_MESSAGE_SOURCE', async () => {
    chat.requireVisibleMessage.mockRejectedValue(
      new ForbiddenException({
        message: '不是会话成员',
        errorCode: 'CHAT_NOT_MEMBER',
      }),
    );

    await expectInvalidSource(
      service.create('user-1', messageCollection('msg-1')),
    );
  });

  it('never queries chat messages directly any more', async () => {
    await service.create('user-1', messageCollection('msg-1'));

    expect(prisma.chatMessage.findFirst).not.toHaveBeenCalled();
    expect(prisma.chatMessage.findUnique).not.toHaveBeenCalled();
  });

  it('persists content-bearing message fields from the verified row, not the client snapshot', async () => {
    await service.create('user-1', {
      type: 'MESSAGE',
      title: '收藏消息',
      summary: 'client summary',
      sourceID: 'msg-1',
      payload: {
        kind: 'openim-message',
        messageID: 'msg-1',
        messageType: 'received',
        conversationID: 'forged-conversation',
        senderID: 'forged-sender',
        time: 'forged-time',
        text: 'peer secret from another message',
      },
    } as never);

    expect(createdPayload()).toEqual(
      expect.objectContaining({
        kind: 'openim-message',
        messageID: 'msg-1',
        messageType: 'received',
        conversationID: 'conversation-1',
        senderID: 'peer-1',
        time: '2026-09-08T08:00:00.000Z',
        text: 'verified text',
      }),
    );
  });

  // 这是本轮审查的核心洞:payload 改从库里重建之后,title/summary 仍然原样落库,
  // 而前端重发兜底(resolveCollectionSendPlan)在 payload.text 为空时读的正是
  // summary/title —— 收藏一条自己的普通消息、把对方焚毁消息的原文填进 summary,
  // 那段文字就永久留存、还能被重新发出去。
  it('ignores the client title and summary for message-sourced collections', async () => {
    await service.create('user-1', {
      type: 'MESSAGE',
      title: '看起来无害的标题',
      summary: '对方在焚毁会话里说的那句话',
      sourceID: 'msg-1',
      payload: { kind: 'openim-message', messageID: 'msg-1' },
    } as never);

    const data = createdData();
    expect(data.title).toBe('verified text');
    expect(data.summary).toBeUndefined();
    expect(JSON.stringify(data)).not.toContain('对方在焚毁会话里说的那句话');
    expect(JSON.stringify(data)).not.toContain('看起来无害的标题');
  });

  it('derives the title from the verified text and the summary from its longer form', async () => {
    const long = 'x'.repeat(300);
    chat.requireVisibleMessage.mockResolvedValue(
      visible({ content: { text: long } }),
    );

    await service.create('user-1', messageCollection('msg-1'));

    const data = createdData();
    // 标题走引用快照的 40 字截断(加省略号),摘要给到 DTO 的 240 上限。
    expect(data.title).toBe(`${'x'.repeat(40)}…`);
    expect(data.summary).toBe(`${'x'.repeat(240)}…`);
  });

  it('labels non-text collections by message type instead of client free text', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({ type: 'image', content: { key: 'chat/peer-1/image.jpg' } }),
    );

    await service.create('user-1', {
      type: 'MESSAGE',
      title: '伪造的标题',
      summary: '伪造的摘要',
      sourceID: 'msg-1',
      payload: { kind: 'openim-message', messageID: 'msg-1' },
    } as never);

    const data = createdData();
    expect(data.title).toBe('[图片]');
    expect(data.summary).toBeUndefined();
  });

  it('caps the display-only metadata the client is still allowed to supply', async () => {
    await service.create('user-1', {
      type: 'MESSAGE',
      title: 't',
      sourceID: 'msg-1',
      payload: {
        kind: 'openim-message',
        messageID: 'msg-1',
        conversationTitle: 'a'.repeat(200),
        senderName: 'b'.repeat(200),
        sourceID: 'c'.repeat(400),
        conversationType: 'not-a-conversation-type',
      },
    } as never);

    const payload = createdPayload();
    expect(payload.conversationTitle).toHaveLength(60);
    expect(payload.senderName).toHaveLength(60);
    expect(payload.sourceID).toHaveLength(120);
    // 枚举外的取值直接丢弃,而不是原样存一段自由文本。
    expect(payload).not.toHaveProperty('conversationType');
  });

  it('keeps the durable object key for image collections and drops the signed url', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({
        type: 'image',
        content: {
          key: 'chat/peer-1/image.jpg',
          url: 'https://signed.invalid/expires-soon',
          width: 100,
          height: 200,
        },
      }),
    );

    await service.create('user-1', messageCollection('msg-1'));

    expect(createdPayload().image).toEqual({
      key: 'chat/peer-1/image.jpg',
      width: 100,
      height: 200,
    });
  });

  it('mirrors the real voice content shape ({key, duration})', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({
        type: 'voice',
        content: { key: 'chat/peer-1/voice.m4a', duration: 4 },
      }),
    );

    await service.create('user-1', messageCollection('msg-1'));

    expect(createdPayload().voice).toEqual({
      key: 'chat/peer-1/voice.m4a',
      duration: 4,
    });
  });

  it('does not put undefined media fields into the Prisma JSON snapshot', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({ type: 'image', senderID: null, content: {} }),
    );

    await service.create('user-1', messageCollection('msg-image'));

    const payload = createdPayload();
    expect(payload).not.toHaveProperty('senderID');
    expect(payload.image).toEqual({});
  });

  // 卡片 content 由发送方构造、发送路径只校验字节数。整份照搬进收藏 = 给「从收藏
  // 重发」准备了一条绕过前端 sanitizeFriendCard 的通路。
  it('sanitizes friend-card content into an allow-listed shape', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({
        type: 'friend-card',
        content: {
          userID: 'peer-1',
          nickname: 'n'.repeat(200),
          faceURL: 'javascript:alert(1)',
          persona: 'p'.repeat(400),
          displayIcons: 'not-an-array',
          evil: { nested: true },
        },
      }),
    );

    await service.create('user-1', messageCollection('msg-1'));

    const card = createdPayload().friendCard;
    expect(
      Object.keys(card).sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(['displayIcons', 'faceURL', 'nickname', 'persona', 'userID']);
    expect(card.nickname).toHaveLength(60);
    expect(card.persona).toHaveLength(120);
    // 非 http(s) scheme 一律丢弃,不留给渲染层去判。
    expect(card.faceURL).toBe('');
    // 字符串形状的 displayIcons 曾让 `.slice(0,4).map` 在渲染时抛错。
    expect(card.displayIcons).toEqual([]);
  });

  it('caps friend-card display icons and keeps only the fields the UI reads', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({
        type: 'friend-card',
        content: {
          userID: 'peer-1',
          nickname: 'Peer',
          faceURL: 'https://cdn.example.com/a.png',
          displayIcons: Array.from({ length: 10 }, (_, index) => ({
            id: `icon-${index}`,
            type: 'CIRCLE',
            title: 'title',
            imageUrl: 'http://attacker.invalid/1x1.gif',
            fallbackIconName: 'star',
            sortOrder: index,
            secret: 'should not survive',
          })),
        },
      }),
    );

    await service.create('user-1', messageCollection('msg-1'));

    const icons = createdPayload().friendCard.displayIcons;
    expect(icons).toHaveLength(4);
    expect(
      Object.keys(icons[0]).sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual([
      'fallbackIconName',
      'id',
      'imageUrl',
      'sortOrder',
      'title',
      'type',
    ]);
    expect(JSON.stringify(icons)).not.toContain('should not survive');
  });

  it('sanitizes transfer-card content (bad amounts collapse to zero)', async () => {
    chat.requireVisibleMessage.mockResolvedValue(
      visible({
        type: 'transfer-card',
        content: {
          amount: '9999',
          message: 'm'.repeat(400),
          extra: 'dropped',
        },
      }),
    );

    await service.create('user-1', messageCollection('msg-1'));

    const card = createdPayload().transferCard;
    expect(
      Object.keys(card).sort((a: string, b: string) => a.localeCompare(b)),
    ).toEqual(['amount', 'message']);
    expect(card.amount).toBe(0);
    expect(card.message).toHaveLength(120);
  });

  // 笔记、纯文本片段等不带 messageID 的收藏不该产生一次多余查询。
  it('does not verify a message when the payload carries no message id', async () => {
    await service.create('user-1', { type: 'NOTE', title: 't' } as never);

    expect(chat.requireVisibleMessage).not.toHaveBeenCalled();
    expect(prisma.userCollection.create).toHaveBeenCalled();
  });
});

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
    chatMessage: { findFirst: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.userCollection.count.mockResolvedValue(0);
    prisma.chatMessage.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CollectionService,
        { provide: PrismaService, useValue: prisma },
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

  it('creates a collection owned by the current user', async () => {
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

  const messageCollection = (messageID: string) =>
    ({
      type: 'MESSAGE',
      title: '收藏消息',
      sourceID: messageID,
      payload: { kind: 'openim-message', messageID },
    }) as never;

  // 转发那条 CHAT_FORWARD_FORBIDDEN 的理由在这里一字不差地成立，但收藏走的是
  // 另一扇门：客户端拼好快照直接 POST，服务端从头到尾没看过那条消息，于是
  // chat.service 里那道闸完全够不着它。
  it('refuses to collect a peer message from a burn-after-reading conversation', async () => {
    prisma.chatMessage.findFirst.mockResolvedValue({
      id: 'msg-1',
      conversationID: 'conversation-1',
      senderID: 'peer-1',
      type: 'text',
      content: { text: 'peer text' },
      createdAt: new Date('2026-09-08T08:00:00.000Z'),
      conversation: { burnDurationSec: 60 },
    });

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
    prisma.chatMessage.findFirst.mockResolvedValue({
      id: 'msg-1',
      conversationID: 'conversation-1',
      senderID: 'user-1',
      type: 'text',
      content: { text: 'my text' },
      createdAt: new Date('2026-09-08T08:00:00.000Z'),
      conversation: { burnDurationSec: 60 },
    });
    prisma.userCollection.create.mockResolvedValue({ id: 'c-1' });

    await service.create('user-1', messageCollection('msg-1'));

    expect(prisma.userCollection.create).toHaveBeenCalled();
    const payload = prisma.userCollection.create.mock.calls[0][0].data.payload;
    expect(payload).not.toHaveProperty('senderID');
  });

  it('leaves ordinary conversations alone', async () => {
    prisma.chatMessage.findFirst.mockResolvedValue({
      id: 'msg-1',
      conversationID: 'conversation-1',
      senderID: 'peer-1',
      type: 'text',
      content: { text: 'ordinary text' },
      createdAt: new Date('2026-09-08T08:00:00.000Z'),
      conversation: { burnDurationSec: null },
    });
    prisma.userCollection.create.mockResolvedValue({ id: 'c-1' });

    await service.create('user-1', messageCollection('msg-1'));

    expect(prisma.userCollection.create).toHaveBeenCalled();
  });

  it('rejects a message collection without an authoritative message id', async () => {
    await expect(
      service.create('user-1', {
        type: 'MESSAGE',
        title: 'copied text',
        payload: { kind: 'openim-message', text: 'peer secret' },
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'COLLECTION_INVALID_MESSAGE_SOURCE',
      }),
    });
    expect(prisma.userCollection.create).not.toHaveBeenCalled();
  });

  it('rejects other message-backed collection types without an authoritative message id', async () => {
    await expect(
      service.create('user-1', {
        type: 'VIDEO',
        title: 'copied video',
        payload: { url: 'https://attacker.invalid/video.mp4' },
      } as never),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'COLLECTION_INVALID_MESSAGE_SOURCE',
      }),
    });
    expect(prisma.userCollection.create).not.toHaveBeenCalled();
  });

  it('rejects a message collection whose message cannot be verified for this user', async () => {
    await expect(
      service.create('user-1', messageCollection('missing-msg')),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'COLLECTION_INVALID_MESSAGE_SOURCE',
      }),
    });
    expect(prisma.userCollection.create).not.toHaveBeenCalled();
  });

  it('persists content-bearing message fields from the verified row, not the client snapshot', async () => {
    prisma.chatMessage.findFirst.mockResolvedValue({
      id: 'msg-1',
      conversationID: 'conversation-1',
      senderID: 'peer-1',
      type: 'text',
      content: { text: 'verified text' },
      createdAt: new Date('2026-09-08T08:00:00.000Z'),
      conversation: { burnDurationSec: null },
    });
    prisma.userCollection.create.mockResolvedValue({ id: 'c-1' });

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

    expect(prisma.userCollection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sourceID: 'msg-1',
        payload: expect.objectContaining({
          kind: 'openim-message',
          messageID: 'msg-1',
          messageType: 'received',
          conversationID: 'conversation-1',
          senderID: 'peer-1',
          time: '2026-09-08T08:00:00.000Z',
          text: 'verified text',
        }),
      }),
    });
  });

  it('does not put undefined media fields into the Prisma JSON snapshot', async () => {
    prisma.chatMessage.findFirst.mockResolvedValue({
      id: 'msg-image',
      conversationID: 'conversation-1',
      senderID: null,
      type: 'image',
      content: { key: 'chat/peer-1/image.jpg' },
      createdAt: new Date('2026-09-08T08:00:00.000Z'),
      conversation: { burnDurationSec: null },
    });
    prisma.userCollection.create.mockResolvedValue({ id: 'c-1' });

    await service.create('user-1', {
      type: 'MESSAGE',
      title: '图片消息',
      sourceID: 'msg-image',
      payload: {
        kind: 'openim-message',
        messageID: 'msg-image',
        messageType: 'image',
      },
    } as never);

    const data = prisma.userCollection.create.mock.calls[0][0].data;
    expect(data.payload).not.toHaveProperty('senderID');
    expect(data.payload.image).toEqual({});
  });

  // 笔记、纯文本片段等不带 messageID 的收藏不该产生一次多余查询。
  it('does not query chat messages when the payload carries no message id', async () => {
    prisma.userCollection.create.mockResolvedValue({ id: 'c-1' });

    await service.create('user-1', { type: 'NOTE', title: 't' } as never);

    expect(prisma.chatMessage.findFirst).not.toHaveBeenCalled();
    expect(prisma.userCollection.create).toHaveBeenCalled();
  });
});

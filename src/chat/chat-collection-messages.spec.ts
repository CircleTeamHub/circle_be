import { ChatMediaService } from './chat-media.service';
import { ChatService } from './chat.service';

describe('collection message resolution', () => {
  const prisma = {
    chatMessage: { findMany: jest.fn(), findUnique: jest.fn() },
    chatMember: { findMany: jest.fn(), findUnique: jest.fn() },
    user: { findMany: jest.fn() },
    tempChatGuest: { findMany: jest.fn() },
  };
  const media = { attachMediaUrls: jest.fn() };
  const makeService = (mediaService: unknown = media) =>
    new ChatService(
      prisma as never,
      {} as never,
      {} as never,
      mediaService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  const service = makeService();
  const resolve = (ids: string[], chat = service) =>
    chat.resolveCollectionMessages('user-1', ids);
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'msg-1',
    conversationID: 'conversation-1',
    senderID: 'peer-1',
    height: 37,
    revision: 49,
    type: 'text',
    content: { text: 'saved text' },
    deleted: false,
    revokedAt: null,
    revokedBy: null,
    replyToID: null,
    clientMessageId: 'peer-device-id',
    burnDurationSec: null,
    burnExpiresAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });
  const membership = (overrides: Record<string, unknown> = {}) => ({
    conversationID: 'conversation-1',
    userID: 'user-1',
    clearedBeforeHeight: 0,
    leftAt: null,
    conversation: { id: 'conversation-1', clearedBeforeHeight: 0 },
    ...overrides,
  });

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.chatMessage.findMany.mockResolvedValue([row()]);
    prisma.chatMember.findMany.mockImplementation((args: any) =>
      Promise.resolve(args.include ? [membership()] : []),
    );
    prisma.user.findMany.mockResolvedValue([
      { id: 'peer-1', nickname: 'Peer', avatarUrl: null },
      { id: 'user-1', nickname: 'Me', avatarUrl: null },
    ]);
    prisma.tempChatGuest.findMany.mockResolvedValue([]);
    media.attachMediaUrls.mockResolvedValue(undefined);
  });

  it('returns authoritative text, real height, sender and viewer-safe delivery id', async () => {
    const messages = await resolve(['msg-1']);

    expect(messages.get('msg-1')).toMatchObject({
      id: 'msg-1',
      conversationId: 'conversation-1',
      height: 37,
      revision: 49,
      content: { text: 'saved text' },
      sender: { id: 'peer-1', nickname: 'Peer' },
      d: null,
    });
  });

  it('batch queries source messages and memberships once for 100 favorites', async () => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      row({
        id: `msg-${index}`,
        conversationID: `conversation-${index}`,
      }),
    );
    prisma.chatMessage.findMany.mockResolvedValue(rows);
    prisma.chatMember.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        args.include
          ? rows.map((message) =>
              membership({
                conversationID: message.conversationID,
                conversation: {
                  id: message.conversationID,
                  clearedBeforeHeight: 0,
                },
              }),
            )
          : [],
      ),
    );

    const messages = await resolve([
      ...rows.map((message) => message.id),
      'msg-0',
    ]);

    expect(messages.size).toBe(100);
    expect(prisma.chatMessage.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.chatMessage.findMany).toHaveBeenCalledWith({
      where: { id: { in: rows.map((message) => message.id) } },
      omit: { contentHistory: true, sourceNoteID: true },
    });
    expect(
      prisma.chatMember.findMany.mock.calls.filter(([args]) => args.include),
    ).toHaveLength(1);
    expect(prisma.chatMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userID: 'user-1',
          leftAt: null,
          conversationID: { in: rows.map((message) => message.conversationID) },
        },
        include: { conversation: true },
      }),
    );
    expect(prisma.chatMessage.findUnique).not.toHaveBeenCalled();
    expect(prisma.chatMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(media.attachMediaUrls).toHaveBeenCalledTimes(1);
  });

  it('does no database work for no source ids', async () => {
    expect((await resolve([])).size).toBe(0);
    expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
  });

  it('keeps missing and inaccessible sources out without losing an available source', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([
      row(),
      row({ id: 'private', conversationID: 'private-conversation' }),
    ]);

    expect([
      ...(await resolve(['msg-1', 'missing', 'private'])).keys(),
    ]).toEqual(['msg-1']);
    expect(
      media.attachMediaUrls.mock.calls[0][0].map((message) => message.id),
    ).toEqual(['msg-1']);
  });

  it.each([
    ['deleted', { deleted: true }],
    ['revoked', { revokedAt: new Date() }],
    [
      'expired',
      { senderID: 'user-1', burnExpiresAt: new Date(Date.now() - 1) },
    ],
    ['peer pending burn', { burnDurationSec: 60 }],
    ['peer active burn', { burnExpiresAt: new Date(Date.now() + 60_000) }],
  ])('does not resolve or sign a %s source', async (_label, overrides) => {
    prisma.chatMessage.findMany.mockResolvedValue([row(overrides)]);

    expect((await resolve(['msg-1'])).size).toBe(0);
    expect(media.attachMediaUrls).not.toHaveBeenCalled();
  });

  it('allows the sender own unexpired ephemeral message', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([
      row({
        senderID: 'user-1',
        burnDurationSec: 60,
        burnExpiresAt: new Date(Date.now() + 60_000),
      }),
    ]);

    expect((await resolve(['msg-1'])).get('msg-1')).toMatchObject({
      burnDurationSec: 60,
      d: 'peer-device-id',
    });
  });

  it.each([
    { clearedBeforeHeight: 37 },
    {
      clearedBeforeHeight: 0,
      conversation: { id: 'conversation-1', clearedBeforeHeight: 40 },
    },
    { leftAt: new Date() },
  ])(
    'does not resolve sources outside current membership visibility: %j',
    async (overrides) => {
      prisma.chatMember.findMany.mockResolvedValue([membership(overrides)]);

      expect((await resolve(['msg-1'])).size).toBe(0);
      expect(media.attachMediaUrls).not.toHaveBeenCalled();
    },
  );

  it('propagates database failures instead of interpreting them as access denial', async () => {
    const failure = new Error('connection unavailable');
    prisma.chatMember.findMany.mockRejectedValue(failure);

    await expect(resolve(['msg-1'])).rejects.toBe(failure);
  });

  it('redacts an unavailable quote using the conversation clear watermark', async () => {
    prisma.chatMember.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        args.include ? [membership({ clearedBeforeHeight: 20 })] : [],
      ),
    );
    prisma.chatMessage.findMany
      .mockResolvedValueOnce([
        row({
          type: 'quote',
          content: { text: 'reply', quotedText: 'old secret' },
          replyToID: 'old',
        }),
      ])
      .mockResolvedValueOnce([
        row({ id: 'old', height: 10, content: { text: 'old secret' } }),
      ]);

    const message = (await resolve(['msg-1'])).get('msg-1');

    expect(message.content).toEqual({ text: 'reply', quotedText: '' });
    expect(message.replyTo).toBeUndefined();
  });

  it('signs canonical image/video keys afresh without changing stored content', async () => {
    const image = row({
      type: 'image',
      content: {
        key: 'chat/peer-1/image.jpg',
        thumbKey: 'chat/peer-1/image-thumb.jpg',
        url: 'https://expired/image',
        thumbUrl: 'https://expired/image-thumb',
      },
    });
    const video = row({
      id: 'video',
      type: 'video',
      content: {
        key: 'chat/peer-1/video.mp4',
        thumbKey: 'chat/peer-1/video-thumb.jpg',
        duration: 12,
      },
    });
    prisma.chatMessage.findMany.mockResolvedValue([image, video]);
    const stored = JSON.stringify([image, video]);
    const upload = {
      createPresignedGetUrl: jest.fn((key: string) =>
        Promise.resolve({ url: `https://fresh/${key}` }),
      ),
    };
    const signer = new ChatMediaService(upload as never, prisma as never);
    try {
      const messages = await resolve(['msg-1', 'video'], makeService(signer));

      expect(messages.get('msg-1').content.url).toBe(
        'https://fresh/chat/peer-1/image.jpg',
      );
      expect(messages.get('msg-1').content.thumbUrl).toBe(
        'https://fresh/chat/peer-1/image-thumb.jpg',
      );
      expect(messages.get('video').content.url).toBe(
        'https://fresh/chat/peer-1/video.mp4',
      );
      expect(messages.get('video').content.thumbUrl).toBe(
        'https://fresh/chat/peer-1/video-thumb.jpg',
      );
      expect(upload.createPresignedGetUrl).toHaveBeenCalledTimes(4);
      expect(JSON.stringify([image, video])).toBe(stored);
    } finally {
      signer.onModuleDestroy();
    }
  });
});

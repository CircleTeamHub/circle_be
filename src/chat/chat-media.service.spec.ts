import { ChatMediaService } from './chat-media.service';
import type { ChatMessageDto } from './chat.types';

function dto(overrides: Partial<ChatMessageDto>): ChatMessageDto {
  return {
    id: 'm1',
    conversationId: 'c1',
    height: 1,
    type: 'text',
    content: {},
    sender: null,
    replyToId: null,
    d: null,
    createdAt: '2026-08-05T12:00:00.000Z',
    ...overrides,
  };
}

describe('ChatMediaService', () => {
  const uploadService = {
    createPresignedGetUrl: jest.fn(),
    deleteObjectByKey: jest.fn(),
  };
  const prisma = {
    chatMediaDeletion: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
  const service = new ChatMediaService(uploadService as never, prisma as never);

  afterAll(() => service.onModuleDestroy());

  beforeEach(() => {
    jest.clearAllMocks();
    uploadService.createPresignedGetUrl.mockImplementation((key: string) =>
      Promise.resolve({ url: `https://signed/${key}`, expiresAt: new Date() }),
    );
    uploadService.deleteObjectByKey.mockResolvedValue(undefined);
    prisma.chatMediaDeletion.upsert.mockResolvedValue({});
    prisma.chatMediaDeletion.findMany.mockResolvedValue([]);
    prisma.chatMediaDeletion.update.mockResolvedValue({});
    prisma.chatMediaDeletion.delete.mockResolvedValue({});
  });

  it('persists a failed deletion instead of losing the key on restart', async () => {
    // 消息 content 在撤回那一刻已经清空:key 只存在于这条待办里,
    // 内存队列一重启就等于把那张图永久留在桶里。
    uploadService.deleteObjectByKey.mockRejectedValueOnce(
      new Error('minio down'),
    );

    await service.deleteObjects(['chat/u1/a.jpg']);

    expect(prisma.chatMediaDeletion.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { objectKey: 'chat/u1/a.jpg' } }),
    );
  });

  it('keeps dead-lettered rows instead of dropping the key', async () => {
    prisma.chatMediaDeletion.findMany.mockResolvedValue([
      { id: 'd1', objectKey: 'chat/u1/a.jpg', attempts: 7 },
    ]);
    uploadService.deleteObjectByKey.mockRejectedValue(new Error('still down'));

    await service.drainPendingDeletions();

    // 次数用尽只是停止自动重试,行必须留着 —— 删了就再也无从得知这个 key。
    expect(prisma.chatMediaDeletion.delete).not.toHaveBeenCalled();
    expect(prisma.chatMediaDeletion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1' },
        data: expect.objectContaining({ attempts: 8 }),
      }),
    );
  });

  it('clears the row once storage confirms the deletion', async () => {
    prisma.chatMediaDeletion.findMany.mockResolvedValue([
      { id: 'd1', objectKey: 'chat/u1/a.jpg', attempts: 2 },
    ]);

    await service.drainPendingDeletions();

    expect(prisma.chatMediaDeletion.delete).toHaveBeenCalledWith({
      where: { id: 'd1' },
    });
  });

  it('signs image, video, and voice object keys onto the dto content', async () => {
    const image = dto({
      type: 'image',
      content: { key: 'chat/a.jpg', thumbKey: 'chat/a-thumb.jpg', width: 100 },
    });
    const voice = dto({
      id: 'm2',
      type: 'voice',
      content: { key: 'chat/b.m4a', duration: 3 },
    });
    const video = dto({
      id: 'm3',
      type: 'video',
      content: { key: 'chat/c.mp4', duration: 8 },
    });

    await service.attachMediaUrls([image, voice, video]);

    expect(image.content).toMatchObject({
      key: 'chat/a.jpg',
      url: 'https://signed/chat/a.jpg',
      thumbUrl: 'https://signed/chat/a-thumb.jpg',
      width: 100,
    });
    expect(voice.content).toMatchObject({ url: 'https://signed/chat/b.m4a' });
    expect(video.content).toMatchObject({ url: 'https://signed/chat/c.mp4' });
  });

  it('signs each distinct key once across a page of messages', async () => {
    const a = dto({ type: 'image', content: { key: 'chat/same.jpg' } });
    const b = dto({
      id: 'm2',
      type: 'image',
      content: { key: 'chat/same.jpg' },
    });
    await service.attachMediaUrls([a, b]);
    expect(uploadService.createPresignedGetUrl).toHaveBeenCalledTimes(1);
    expect(a.content.url).toBe('https://signed/chat/same.jpg');
    expect(b.content.url).toBe('https://signed/chat/same.jpg');
  });

  it('leaves non-media messages untouched and skips presign entirely', async () => {
    const text = dto({ type: 'text', content: { text: 'hi' } });
    const original = text.content;
    await service.attachMediaUrls([text]);
    expect(uploadService.createPresignedGetUrl).not.toHaveBeenCalled();
    expect(text.content).toBe(original);
  });

  it('degrades on presign failure: keeps the key, adds no url, never throws', async () => {
    uploadService.createPresignedGetUrl.mockRejectedValue(
      new Error('storage down'),
    );
    const image = dto({ type: 'image', content: { key: 'chat/a.jpg' } });
    await expect(service.attachMediaUrls([image])).resolves.toBeUndefined();
    expect(image.content).toMatchObject({ key: 'chat/a.jpg' });
    expect(image.content.url).toBeUndefined();
  });

  it('never signs keys outside the chat/ prefix', async () => {
    // 第二道防线:历史行里混进别的目录也不会被读路径签成可分发 URL。
    const foreign = dto({
      type: 'image',
      content: { key: 'notes/u2/private.jpg' },
    });
    await service.attachMediaUrls([foreign]);
    expect(uploadService.createPresignedGetUrl).not.toHaveBeenCalled();
    expect(foreign.content.url).toBeUndefined();
  });

  it('patches content immutably (new object, original untouched)', async () => {
    const original = { key: 'chat/a.jpg' };
    const image = dto({ type: 'image', content: original });
    await service.attachMediaUrls([image]);
    expect(image.content).not.toBe(original);
    expect(original).toEqual({ key: 'chat/a.jpg' });
  });
});

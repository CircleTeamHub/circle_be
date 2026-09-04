import { Logger } from '@nestjs/common';
import { ChatMediaService } from './chat-media.service';
import {
  CHAT_MEDIA_DELETE_CLAIM_REASON,
  CHAT_NOTE_IMPORT_RESERVATION_REASON,
} from './chat.constants';
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
    copyObjectToKey: jest.fn(),
    deleteObjectByKey: jest.fn(),
  };
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    chatMediaDeletion: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    chatMediaReference: {
      count: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
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
    uploadService.copyObjectToKey.mockResolvedValue(undefined);
    prisma.chatMediaDeletion.upsert.mockResolvedValue({});
    prisma.chatMediaDeletion.findMany.mockResolvedValue([]);
    prisma.chatMediaDeletion.update.mockResolvedValue({});
    prisma.chatMediaDeletion.updateMany.mockResolvedValue({ count: 1 });
    prisma.chatMediaDeletion.delete.mockResolvedValue({});
    prisma.chatMediaDeletion.deleteMany.mockResolvedValue({ count: 1 });
    prisma.chatMediaDeletion.findUnique.mockResolvedValue(null);
    prisma.chatMediaReference.count.mockResolvedValue(0);
    prisma.chatMediaReference.createMany.mockResolvedValue({ count: 1 });
    prisma.chatMediaReference.deleteMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([]);
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
    const due = {
      id: 'd1',
      objectKey: 'chat/u1/a.jpg',
      attempts: 7,
      nextAttemptAt: new Date(0),
    };
    prisma.chatMediaDeletion.findMany.mockResolvedValue([due]);
    prisma.chatMediaDeletion.findUnique.mockResolvedValue(due);
    uploadService.deleteObjectByKey.mockRejectedValue(new Error('still down'));

    await service.drainPendingDeletions();

    // 次数用尽只是停止自动重试,行必须留着 —— 删了就再也无从得知这个 key。
    expect(prisma.chatMediaDeletion.delete).not.toHaveBeenCalled();
    expect(prisma.chatMediaDeletion.deleteMany).not.toHaveBeenCalled();
    // 失败结果写在事务外,用条件 updateMany:行被并发销掉时应无操作而非抛 P2025。
    // 条件还要认准「仍是自己的认领」:同一对 (认领标记, 租约到期时间)。
    const lease = prisma.chatMediaDeletion.update.mock.calls[0][0].data
      .nextAttemptAt as Date;
    expect(prisma.chatMediaDeletion.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'd1',
          nextAttemptAt: lease,
          lastError: CHAT_MEDIA_DELETE_CLAIM_REASON,
        },
        data: expect.objectContaining({ attempts: 8 }),
      }),
    );
  });

  it('clears the row once storage confirms the deletion', async () => {
    const due = {
      id: 'd1',
      objectKey: 'chat/u1/a.jpg',
      attempts: 2,
      nextAttemptAt: new Date(0),
    };
    prisma.chatMediaDeletion.findMany.mockResolvedValue([due]);
    prisma.chatMediaDeletion.findUnique.mockResolvedValue(due);

    await service.drainPendingDeletions();

    expect(prisma.chatMediaDeletion.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'd1',
        nextAttemptAt: expect.any(Date),
        lastError: CHAT_MEDIA_DELETE_CLAIM_REASON,
      },
    });
  });

  it('marks the claim with a lease and only clears a row that still carries it', async () => {
    // 认领事务提交后 advisory lock 就放掉了,对象删除却还在飞。同一个确定性
    // note-import key 的导入重试此刻可以重新预留这一行:预留路径靠这个
    // 「删除中」标记 + 未到期租约拒绝复用;worker 这边的写回只认同一对值。
    const due = {
      id: 'd1',
      objectKey: 'chat/u1/note-import/shared.jpg',
      attempts: 0,
      nextAttemptAt: new Date(0),
    };
    prisma.chatMediaDeletion.findMany.mockResolvedValue([due]);
    prisma.chatMediaDeletion.findUnique.mockResolvedValue(due);

    await service.drainPendingDeletions();

    expect(prisma.chatMediaDeletion.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: {
        nextAttemptAt: expect.any(Date),
        lastError: CHAT_MEDIA_DELETE_CLAIM_REASON,
      },
    });
    const lease = prisma.chatMediaDeletion.update.mock.calls[0][0].data
      .nextAttemptAt as Date;
    expect(lease.getTime()).toBeGreaterThan(Date.now());
    expect(prisma.chatMediaDeletion.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'd1',
        nextAttemptAt: lease,
        lastError: CHAT_MEDIA_DELETE_CLAIM_REASON,
      },
    });
  });

  it('leaves a row alone once a retried import turned it into a live reservation', async () => {
    // 复现 P0 竞态:认领提交 → 导入重试拿到锁、把同一行改写成活的预留并开始
    // 复制 → worker 的删除返回。此时 worker 绝不能再无条件 deleteMany 把新预留
    // 抹掉,否则随后的发消息会撞上「Note media import has expired」。
    type Row = {
      id: string;
      objectKey: string;
      attempts: number;
      nextAttemptAt: Date;
      lastError: string | null;
    };
    const due: Row = {
      id: 'd1',
      objectKey: 'chat/u1/note-import/shared.jpg',
      attempts: 0,
      nextAttemptAt: new Date(0),
      lastError: 'last note import reference removed',
    };
    let row: Row | null = { ...due };
    const matches = (where: Record<string, unknown>) =>
      row !== null &&
      Object.entries(where).every(([field, value]) => {
        const actual = (row as Row)[field as keyof Row];
        return value instanceof Date && actual instanceof Date
          ? value.getTime() === actual.getTime()
          : actual === value;
      });
    prisma.chatMediaDeletion.findMany.mockResolvedValue([due]);
    prisma.chatMediaDeletion.findUnique.mockResolvedValue(due);
    prisma.chatMediaDeletion.update.mockImplementation(
      async ({ data }: { data: Partial<Row> }) => {
        row = { ...(row as Row), ...data };
        return row;
      },
    );
    uploadService.deleteObjectByKey.mockImplementation(async () => {
      // 删除飞行期间:导入重试的 upsert 落地,这行成了活的预留。
      row = {
        ...(row as Row),
        attempts: 0,
        lastError: CHAT_NOTE_IMPORT_RESERVATION_REASON,
        nextAttemptAt: new Date(Date.now() + 15 * 60_000),
      };
    });
    prisma.chatMediaDeletion.deleteMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if (!matches(where)) return { count: 0 };
        row = null;
        return { count: 1 };
      },
    );
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      await service.drainPendingDeletions();

      expect(row).not.toBeNull();
      expect(row!.lastError).toBe(CHAT_NOTE_IMPORT_RESERVATION_REASON);
      expect(prisma.chatMediaDeletion.updateMany).not.toHaveBeenCalled();
      // 条件写回一行都没命中要留痕(有界:每个受影响的 key 一条)。
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'chat_media_claim_lost',
          objectKey: due.objectKey,
          outcome: 'deleted',
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('records a failed attempt only against its own claim', async () => {
    const due = {
      id: 'd1',
      objectKey: 'chat/u1/note-import/shared.jpg',
      attempts: 1,
      nextAttemptAt: new Date(0),
    };
    prisma.chatMediaDeletion.findMany.mockResolvedValue([due]);
    prisma.chatMediaDeletion.findUnique.mockResolvedValue(due);
    uploadService.deleteObjectByKey.mockRejectedValue(new Error('minio down'));
    // 失败写回没命中:这行已被导入重试改写成预留,退避状态不能盖到预留上。
    prisma.chatMediaDeletion.updateMany.mockResolvedValue({ count: 0 });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    try {
      await service.drainPendingDeletions();

      const lease = prisma.chatMediaDeletion.update.mock.calls[0][0].data
        .nextAttemptAt as Date;
      expect(prisma.chatMediaDeletion.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'd1',
            nextAttemptAt: lease,
            lastError: CHAT_MEDIA_DELETE_CLAIM_REASON,
          },
        }),
      );
      expect(prisma.chatMediaDeletion.deleteMany).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'chat_media_claim_lost',
          outcome: 'failed',
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('deletes from the object store outside the claiming transaction', async () => {
    // Prisma 交互事务默认只有几秒超时。把对象存储删除放进事务里,一次慢的
    // MinIO/S3 调用就会让事务超时回滚:行既没删掉、也没记下重试状态,
    // 而且整段外部调用期间还白占着一个数据库连接和 advisory lock。
    const due = {
      id: 'd1',
      objectKey: 'chat/u1/a.jpg',
      attempts: 0,
      nextAttemptAt: new Date(0),
    };
    prisma.chatMediaDeletion.findMany.mockResolvedValue([due]);
    prisma.chatMediaDeletion.findUnique.mockResolvedValue(due);

    let insideTransaction = false;
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => {
        insideTransaction = true;
        try {
          return await callback(prisma);
        } finally {
          insideTransaction = false;
        }
      },
    );
    const observed: boolean[] = [];
    uploadService.deleteObjectByKey.mockImplementation(async () => {
      observed.push(insideTransaction);
    });

    await service.drainPendingDeletions();

    expect(observed).toEqual([false]);
    // 事务里只做认领:把 nextAttemptAt 推后一个租约占住这一条,
    // 让并发 sweeper 的 due 查询(nextAttemptAt <= now)看不到它。
    expect(prisma.chatMediaDeletion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'd1' },
        data: expect.objectContaining({ nextAttemptAt: expect.any(Date) }),
      }),
    );
    expect(
      prisma.chatMediaDeletion.update.mock.invocationCallOrder[0],
    ).toBeLessThan(uploadService.deleteObjectByKey.mock.invocationCallOrder[0]);
  });

  it('cancels a stale deletion without touching an object that is still referenced', async () => {
    const due = {
      id: 'd1',
      objectKey: 'chat/u1/note-import/shared.jpg',
      attempts: 0,
      nextAttemptAt: new Date(0),
    };
    prisma.chatMediaDeletion.findMany.mockResolvedValue([due]);
    prisma.chatMediaDeletion.findUnique.mockResolvedValue(due);
    prisma.chatMediaReference.count.mockResolvedValue(1);

    await service.drainPendingDeletions();

    expect(uploadService.deleteObjectByKey).not.toHaveBeenCalled();
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

  it('copies every media object into the forwarding user namespace', async () => {
    const result = await service.copyForForward(
      'image',
      {
        key: 'chat/u2/source.jpg',
        thumbKey: 'chat/u2/source-thumb.jpg',
        width: 640,
        url: 'https://expired.example/source.jpg',
      },
      'u1',
    );

    expect(uploadService.copyObjectToKey).toHaveBeenCalledTimes(2);
    expect(uploadService.copyObjectToKey).toHaveBeenNthCalledWith(
      1,
      'chat/u2/source.jpg',
      expect.stringMatching(/^chat\/u1\/[0-9a-f-]+\.jpg$/),
    );
    expect(result.content).toMatchObject({
      key: expect.stringMatching(/^chat\/u1\/[0-9a-f-]+\.jpg$/),
      thumbKey: expect.stringMatching(/^chat\/u1\/[0-9a-f-]+\.jpg$/),
      width: 640,
    });
    expect(result.content).not.toHaveProperty('url');
    expect(result.copiedKeys).toHaveLength(2);
    expect(prisma.chatMediaDeletion.upsert).toHaveBeenCalledTimes(2);
    const lastReservation = Math.max(
      ...prisma.chatMediaDeletion.upsert.mock.invocationCallOrder,
    );
    const firstCopy = uploadService.copyObjectToKey.mock.invocationCallOrder[0];
    expect(lastReservation).toBeLessThan(firstCopy);
  });

  it('cleans up earlier copies when a later media object copy fails', async () => {
    uploadService.copyObjectToKey
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('copy failed'));

    await expect(
      service.copyForForward(
        'image',
        {
          key: 'chat/u2/source.jpg',
          thumbKey: 'chat/u2/source-thumb.jpg',
        },
        'u1',
      ),
    ).rejects.toThrow('copy failed');

    expect(uploadService.deleteObjectByKey).toHaveBeenCalledTimes(2);
  });

  it('refuses to copy non-chat object keys', async () => {
    await expect(
      service.copyForForward('image', { key: 'notes/u2/private.jpg' }, 'u1'),
    ).rejects.toThrow();
    expect(uploadService.copyObjectToKey).not.toHaveBeenCalled();
  });
});

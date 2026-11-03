import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { StickerService } from './sticker.service';
import { ChatMediaService } from 'src/chat/chat-media.service';
import { UploadController } from 'src/upload/upload.controller';
import { UploadLimitService } from 'src/upload/upload-limit.service';

describe('StickerService', () => {
  function harness() {
    const rows: any[] = [];
    const stickers = {
      findMany: jest.fn(async ({ where, take }) =>
        rows.filter((r) => r.userID === where.userID).slice(0, take),
      ),
      findFirst: jest.fn(
        async ({ where }) =>
          rows.find((r) =>
            Object.entries(where).every(([k, v]) => r[k] === v),
          ) ?? null,
      ),
      count: jest.fn(
        async ({ where }) =>
          rows.filter((r) => r.userID === where.userID).length,
      ),
      create: jest.fn(async ({ data }) => {
        const row = { id: `s${rows.length}`, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const index = rows.findIndex(
          (r) => r.id === where.id && r.userID === where.userID,
        );
        if (index < 0) return { count: 0 };
        rows.splice(index, 1);
        return { count: 1 };
      }),
    };
    const prisma: any = {
      customSticker: stickers,
      $queryRaw: jest.fn(),
      chatMediaDeletion: { create: jest.fn() },
    };
    // Serialize transactions like the per-user Postgres advisory lock does.
    let turn = Promise.resolve();
    prisma.$transaction = jest.fn((work) => {
      const task = turn.then(() => work(prisma));
      turn = task.catch(() => undefined);
      return task;
    });
    const upload = {
      presign: jest.fn().mockResolvedValue({ uploadUrl: 'signed:upload' }),
      headObject: jest
        .fn()
        .mockResolvedValue({ contentType: 'image/png', size: 1024 }),
      copyObjectToKey: jest.fn().mockResolvedValue(undefined),
      createPresignedGetUrl: jest.fn(async (key) => ({
        url: `signed:${key}`,
        expiresAt: new Date(),
      })),
    };
    const chat = {
      requireVisibleMessage: jest.fn().mockResolvedValue({
        row: {
          id: 'm1',
          type: 'image',
          content: { key: 'chat/sender/photo.png', width: 80, height: 90 },
          burnDurationSec: null,
          burnExpiresAt: null,
        },
      }),
    };
    const uploadLimit = new UploadLimitService();
    return {
      service: new StickerService(
        prisma,
        upload as never,
        chat as never,
        uploadLimit,
      ),
      controller: new UploadController(upload as never, uploadLimit),
      rows,
      stickers,
      prisma,
      upload,
      chat,
    };
  }

  it('reads the same durable collection independently on two devices and signs fresh URLs', async () => {
    const h = harness();
    await h.service.create('alice', {
      objectKey: 'stickers/alice/a.png',
      width: 80,
      height: 90,
    });
    const first = await h.service.list('alice');
    const second = await h.service.list('alice');
    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({
      id: 's0',
      width: 80,
      height: 90,
      url: 'signed:stickers/alice/a.png',
    });
    expect(await h.service.list('bob')).toEqual([]);
    expect(h.stickers.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userID: 'bob' }, take: 200 }),
    );
    expect(h.rows[0]).not.toHaveProperty('url');
  });

  it.each([{}, { objectKey: 'stickers/alice/a.png', messageId: 'm1' }])(
    'rejects missing or ambiguous sticker sources %o',
    async (source) => {
      const h = harness();
      await expect(h.service.create('alice', source)).rejects.toThrow();
      expect(h.upload.headObject).not.toHaveBeenCalled();
      expect(h.chat.requireVisibleMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    'stickers/bob/a.png',
    'https://evil.test/a.png',
    'stickers/alice/../bob/a.png',
    'chat/alice/a.png',
  ])(
    'rejects unowned or unsafe uploaded key %s before storage access',
    async (objectKey) => {
      const h = harness();
      await expect(h.service.create('alice', { objectKey })).rejects.toThrow();
      expect(h.upload.headObject).not.toHaveBeenCalled();
      expect(h.rows).toHaveLength(0);
    },
  );

  it.each([
    { contentType: 'video/mp4', size: 20 },
    { contentType: 'image/png', size: 5 * 1024 * 1024 + 1 },
  ])('rejects invalid uploaded object metadata %o', async (metadata) => {
    const h = harness();
    h.upload.headObject.mockResolvedValue(metadata);
    await expect(
      h.service.create('alice', { objectKey: 'stickers/alice/a.png' }),
    ).rejects.toThrow();
    expect(h.rows).toHaveLength(0);
  });

  it('does not persist a sticker when uploaded object verification fails', async () => {
    const h = harness();
    h.upload.headObject.mockRejectedValue(new Error('missing'));
    await expect(
      h.service.create('alice', { objectKey: 'stickers/alice/a.png' }),
    ).rejects.toThrow('missing');
    expect(h.rows).toHaveLength(0);
  });

  it('copies authorized chat images to independent private keys and deduplicates concurrent saves', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      h.service.create('alice', { messageId: 'm1' }),
      h.service.create('alice', { messageId: 'm1' }),
    ]);
    expect(a.id).toBe(b.id);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].objectKey).toMatch(/^stickers\/alice\/[a-f0-9]+\.png$/);
    expect(h.rows[0].sourceMessageID).toBe('m1');
    expect(h.upload.copyObjectToKey).toHaveBeenCalledWith(
      'chat/sender/photo.png',
      h.rows[0].objectKey,
    );
  });

  it('enforces source-message visibility and burning-message denial', async () => {
    const h = harness();
    h.chat.requireVisibleMessage.mockRejectedValueOnce(
      new ForbiddenException(),
    );
    await expect(
      h.service.create('alice', { messageId: 'other' }),
    ).rejects.toThrow(ForbiddenException);
    h.chat.requireVisibleMessage.mockResolvedValueOnce({
      row: {
        type: 'image',
        content: { key: 'chat/bob/a.png' },
        burnDurationSec: 30,
      },
    });
    await expect(
      h.service.create('alice', { messageId: 'burn' }),
    ).rejects.toThrow(ForbiddenException);
    expect(h.upload.copyObjectToKey).not.toHaveBeenCalled();
  });

  it('does not create a permanent entry on failed source copy', async () => {
    const h = harness();
    h.upload.copyObjectToKey.mockRejectedValueOnce(new Error('storage down'));
    await expect(
      h.service.create('alice', { messageId: 'm1' }),
    ).rejects.toThrow('storage down');
    expect(h.rows).toHaveLength(0);
  });

  it('deduplicates uploads and caps the collection at 200', async () => {
    const h = harness();
    await h.service.create('alice', { objectKey: 'stickers/alice/a.png' });
    await h.service.create('alice', { objectKey: 'stickers/alice/a.png' });
    expect(h.rows).toHaveLength(1);
    h.stickers.count.mockResolvedValueOnce(200);
    await expect(
      h.service.create('alice', { objectKey: 'stickers/alice/b.png' }),
    ).rejects.toThrow();
    expect(h.rows).toHaveLength(1);
  });

  it('cannot remove or send a different account sticker', async () => {
    const h = harness();
    await h.service.create('alice', { objectKey: 'stickers/alice/a.png' });
    h.upload.headObject.mockClear();
    await expect(h.service.prepareMessage('bob', 's0')).rejects.toThrow(
      NotFoundException,
    );
    await expect(h.service.remove('bob', 's0')).rejects.toThrow(
      NotFoundException,
    );
    expect(h.rows).toHaveLength(1);
    expect(h.upload.headObject).not.toHaveBeenCalled();
    expect(h.upload.copyObjectToKey).not.toHaveBeenCalled();
  });

  it('limits repeated sticker copies to the daily upload byte budget across minute windows', async () => {
    const h = harness();
    await h.service.create('alice', { objectKey: 'stickers/alice/a.png' });
    h.upload.headObject.mockResolvedValue({
      contentType: 'image/png',
      size: 5 * 1024 * 1024,
    });
    let now = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (let index = 0; index < 204; index += 1) {
        if (index > 0 && index % 20 === 0) now += 60_000;
        await h.service.prepareMessage('alice', 's0');
      }
      await expect(
        h.service.prepareMessage('alice', 's0'),
      ).rejects.toMatchObject({
        status: 429,
      });
      expect(h.upload.copyObjectToKey).toHaveBeenCalledTimes(204);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('shares the byte budget with ordinary uploads without consuming another account budget', async () => {
    const h = harness();
    await h.service.create('alice', { objectKey: 'stickers/alice/a.png' });
    await h.service.create('bob', { objectKey: 'stickers/bob/b.png' });
    h.upload.headObject.mockResolvedValue({
      contentType: 'image/png',
      size: 5 * 1024 * 1024,
    });
    const dto = {
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 100 * 1024 * 1024,
      folder: 'chat',
    } as const;
    const req = { user: { userId: 'alice' } } as never;
    for (let index = 0; index < 10; index += 1) {
      await h.controller.presign(dto, req);
    }
    for (let index = 0; index < 4; index += 1) {
      await h.service.prepareMessage('alice', 's0');
    }
    await expect(h.service.prepareMessage('alice', 's0')).rejects.toMatchObject(
      {
        status: 429,
      },
    );
    await expect(
      h.controller.presign({ ...dto, sizeBytes: 5 * 1024 * 1024 }, req),
    ).rejects.toMatchObject({ status: 429 });
    await expect(h.service.prepareMessage('bob', 's1')).resolves.toMatchObject({
      key: expect.stringMatching(/^chat\/bob\//),
    });
    expect(h.upload.copyObjectToKey).toHaveBeenCalledTimes(5);
    expect(h.upload.presign).toHaveBeenCalledTimes(10);
  });

  it('does not copy when current sticker metadata cannot be read', async () => {
    const h = harness();
    await h.service.create('alice', { objectKey: 'stickers/alice/a.png' });
    h.upload.headObject.mockRejectedValueOnce(new Error('missing'));
    await expect(h.service.prepareMessage('alice', 's0')).rejects.toThrow(
      'missing',
    );
    expect(h.upload.copyObjectToKey).not.toHaveBeenCalled();
  });

  it('prepares a separate ordinary image accepted by the real chat media send validator; removal preserves that copy', async () => {
    const h = harness();
    await h.service.create('alice', {
      objectKey: 'stickers/alice/a.png',
      width: 80,
      height: 90,
    });
    const content = await h.service.prepareMessage('alice', 's0');
    expect(content).toMatchObject({
      key: expect.stringMatching(/^chat\/alice\/.+\.png$/),
      width: 80,
      height: 90,
    });
    h.prisma.chatMediaDeletion.findFirst = jest.fn(async () =>
      h.prisma.chatMediaDeletion.create.mock.calls.length
        ? { id: 'pending' }
        : null,
    );
    const media = new ChatMediaService(h.upload as never, h.prisma);
    try {
      await expect(
        media.lockOwnedKeysForSend(h.prisma, 'image', content),
      ).resolves.toBeUndefined();
      expect(h.prisma.chatMediaDeletion.create).not.toHaveBeenCalled();
    } finally {
      media.onModuleDestroy();
    }
    expect(h.upload.copyObjectToKey).toHaveBeenCalledWith(
      'stickers/alice/a.png',
      content.key,
    );
    await h.service.remove('alice', 's0');
    expect(h.rows).toHaveLength(0);
  });
});

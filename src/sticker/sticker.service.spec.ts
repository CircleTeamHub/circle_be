import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { StickerService } from './sticker.service';
import { ChatMediaService } from 'src/chat/chat-media.service';
import { UploadController } from 'src/upload/upload.controller';
import { UploadLimitService } from 'src/upload/upload-limit.service';
import * as errorAggregation from 'src/logging/error-aggregation.service';

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
      deleteObjectByKey: jest.fn().mockResolvedValue(undefined),
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
      uploadLimit,
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
    expect(h.rows[0].objectKey).toMatch(
      /^stickers\/alice\/[a-f0-9-]{36}\.png$/,
    );
    expect(h.rows[0].sourceMessageID).toBe('m1');
    expect(h.upload.copyObjectToKey).toHaveBeenCalledWith(
      'chat/sender/photo.png',
      h.rows[0].objectKey,
    );
    const copiedKeys = h.upload.copyObjectToKey.mock.calls.map(
      ([, key]) => key,
    );
    expect(new Set(copiedKeys).size).toBe(2);
    expect(h.upload.deleteObjectByKey).toHaveBeenCalledTimes(1);
    expect(h.upload.deleteObjectByKey).toHaveBeenCalledWith(
      copiedKeys.find((key) => key !== h.rows[0].objectKey),
    );
    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalledWith(
      h.rows[0].objectKey,
    );
  });

  it('rejects a full collection before copying or consuming upload allowance', async () => {
    const h = harness();
    h.stickers.count.mockResolvedValue(200);
    const limit = jest.spyOn(h.uploadLimit, 'check');
    await expect(
      h.service.create('alice', { messageId: 'overflow' }),
    ).rejects.toMatchObject({
      response: { errorCode: 'STICKER_LIMIT_REACHED' },
    });
    expect(h.upload.copyObjectToKey).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });

  it('returns an existing chat sticker without copying or charging it again', async () => {
    const h = harness();
    const limit = jest.spyOn(h.uploadLimit, 'check');
    const first = await h.service.create('alice', { messageId: 'm1' });
    expect(await h.service.create('alice', { messageId: 'm1' })).toEqual(first);
    expect(h.upload.copyObjectToKey).toHaveBeenCalledTimes(1);
    expect(h.upload.headObject).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it('charges chat sticker imports to the same byte budget as ordinary uploads before copying', async () => {
    const h = harness();
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
      await h.service.create('alice', { messageId: `m${index}` });
    }
    await expect(
      h.service.create('alice', { messageId: 'over-budget' }),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      h.controller.presign({ ...dto, sizeBytes: 5 * 1024 * 1024 }, req),
    ).rejects.toMatchObject({ status: 429 });
    expect(h.upload.copyObjectToKey).toHaveBeenCalledTimes(4);
    expect(h.rows).toHaveLength(4);
  });

  it.each([false, true])(
    'compensates a failed sticker write and preserves its error when cleanup fails=%s',
    async (cleanupFails) => {
      const h = harness();
      const writeError = new Error('database write failed');
      const cleanupError = new Error('storage delete failed');
      h.stickers.create.mockRejectedValueOnce(writeError);
      if (cleanupFails)
        h.upload.deleteObjectByKey.mockRejectedValueOnce(cleanupError);
      const report = jest
        .spyOn(errorAggregation, 'reportOperationalError')
        .mockImplementation(() => undefined);
      try {
        await expect(
          h.service.create('alice', { messageId: 'm1' }),
        ).rejects.toBe(writeError);
        expect(h.upload.deleteObjectByKey).toHaveBeenCalledWith(
          h.upload.copyObjectToKey.mock.calls[0][1],
        );
        expect(h.rows).toHaveLength(0);
        if (cleanupFails) {
          expect(report).toHaveBeenCalledWith(cleanupError, {
            component: 'StickerService',
            operation: 'cleanupCopiedSticker',
          });
        }
      } finally {
        report.mockRestore();
      }
    },
  );

  it('does not delete an existing album upload when its sticker write fails', async () => {
    const h = harness();
    const writeError = new Error('database write failed');
    h.stickers.create.mockRejectedValueOnce(writeError);
    await expect(
      h.service.create('alice', { objectKey: 'stickers/alice/a.png' }),
    ).rejects.toBe(writeError);
    expect(h.upload.copyObjectToKey).not.toHaveBeenCalled();
    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
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

import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from 'src/generated/prisma';
import type { PrismaService } from 'src/prisma/prisma.service';
import { uploadMetrics } from 'src/metrics/upload-metrics';
import type { UploadService } from './upload.service';
import { UploadIntentService } from './upload-intent.service';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const EXPIRED = new Date('2026-11-17T11:00:00.000Z');

type Intent = {
  id: string;
  objectKey: string;
  fileUrl: string;
  userID: string;
  purpose:
    | 'PROFILE_AVATAR'
    | 'CIRCLE_AVATAR'
    | 'PLAZA_POST'
    | 'MOMENT'
    | 'MOMENT_COMMENT';
  folder: string;
  sizeBytes: number;
  status: 'PENDING' | 'DELETING' | 'CLAIMED' | 'DELETED';
  expiresAt: Date;
  claimedAt: Date | null;
  deleteLeaseUntil: Date | null;
  deletedAt: Date | null;
  deleteAttempts: number;
  lastDeleteError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function intent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 'intent-1',
    objectKey: 'posts/user-1/file.jpg',
    fileUrl: 'https://cdn.example/posts/user-1/file.jpg',
    userID: 'user-1',
    purpose: 'MOMENT',
    folder: 'posts',
    sizeBytes: 1024,
    status: 'PENDING',
    expiresAt: EXPIRED,
    claimedAt: null,
    deleteLeaseUntil: null,
    deletedAt: null,
    deleteAttempts: 0,
    lastDeleteError: null,
    createdAt: new Date('2026-11-16T11:00:00.000Z'),
    updatedAt: EXPIRED,
    ...overrides,
  };
}

function harness(mode: 'report' | 'delete' = 'delete') {
  const prisma = {
    uploadIntent: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    circle: { findMany: jest.fn().mockResolvedValue([]) },
    circlePost: { findMany: jest.fn().mockResolvedValue([]) },
    trace: { findMany: jest.fn().mockResolvedValue([]) },
    traceComment: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const upload = {
    objectKeyFromPublicUrl: jest.fn((value: string | null | undefined) => {
      for (const prefix of [
        'https://cdn.example/',
        'https://legacy-cdn.example/',
      ]) {
        if (value?.startsWith(prefix)) {
          return value.slice(prefix.length).split('?')[0];
        }
      }
      return null;
    }),
    deleteObjectByKey: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'UPLOAD_INTENT_GC_MODE' ? mode : undefined,
    ),
  };
  const service = new UploadIntentService(
    prisma as unknown as PrismaService,
    upload as unknown as UploadService,
    config as unknown as ConfigService,
  );
  return { service, prisma, upload };
}

describe('UploadIntentService.track', () => {
  it('creates a 24-hour pending intent for an explicit compatible purpose', async () => {
    const h = harness();
    h.prisma.uploadIntent.create.mockResolvedValue(intent());

    await h.service.track(
      {
        objectKey: 'posts/user-1/file.jpg',
        fileUrl: 'https://cdn.example/posts/user-1/file.jpg',
        userID: 'user-1',
        purpose: 'MOMENT',
        folder: 'posts',
        sizeBytes: 1024,
      },
      NOW,
    );

    expect(h.prisma.uploadIntent.create).toHaveBeenCalledWith({
      data: {
        objectKey: 'posts/user-1/file.jpg',
        fileUrl: 'https://cdn.example/posts/user-1/file.jpg',
        userID: 'user-1',
        purpose: 'MOMENT',
        folder: 'posts',
        sizeBytes: 1024,
        status: 'PENDING',
        expiresAt: new Date('2026-11-18T12:00:00.000Z'),
      },
    });
  });

  it.each([
    [{ purpose: undefined, folder: 'posts' }, 'missing purpose'],
    [{ purpose: 'MOMENT', folder: 'avatars' }, 'mismatched folder'],
    [{ purpose: 'UNKNOWN', folder: 'posts' }, 'unknown purpose'],
  ] as const)('does not track %s (%s)', async (override, _description) => {
    const h = harness();
    await h.service.track({
      objectKey: 'posts/user-1/file.jpg',
      fileUrl: 'https://cdn.example/posts/user-1/file.jpg',
      userID: 'user-1',
      purpose: override.purpose as never,
      folder: override.folder as never,
      sizeBytes: 1024,
    });
    expect(h.prisma.uploadIntent.create).not.toHaveBeenCalled();
  });
});

describe('UploadIntentService.claim', () => {
  function txWith(row: Intent | null) {
    return {
      uploadIntent: {
        findUnique: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
  }

  it('claims an owned pending intent in the caller transaction', async () => {
    const h = harness();
    const tx = txWith(intent());

    await h.service.claim(
      tx as unknown as Prisma.TransactionClient,
      'user-1',
      'MOMENT',
      ['https://cdn.example/posts/user-1/file.jpg'],
      NOW,
    );

    expect(tx.uploadIntent.updateMany).toHaveBeenCalledWith({
      where: { id: 'intent-1', status: 'PENDING' },
      data: {
        status: 'CLAIMED',
        claimedAt: NOW,
        deleteLeaseUntil: null,
        lastDeleteError: null,
      },
    });
  });

  it('allows legacy keys with no intent', async () => {
    const h = harness();
    const tx = txWith(null);
    await h.service.claim(
      tx as unknown as Prisma.TransactionClient,
      'user-1',
      'MOMENT',
      ['posts/user-1/legacy.jpg'],
    );
    expect(tx.uploadIntent.updateMany).not.toHaveBeenCalled();
  });

  it('keeps already claimed rows compatible even for another uploader and purpose', async () => {
    const h = harness();
    const tx = txWith(
      intent({
        status: 'CLAIMED',
        userID: 'someone-else',
        purpose: 'PLAZA_POST',
      }),
    );
    await expect(
      h.service.claim(
        tx as unknown as Prisma.TransactionClient,
        'user-1',
        'MOMENT',
        ['posts/user-1/file.jpg'],
      ),
    ).resolves.toBeUndefined();
  });

  it.each([
    [intent({ userID: 'someone-else' }), 'different uploader'],
    [intent({ purpose: 'PLAZA_POST' }), 'different purpose'],
  ])('rejects a pending intent owned by a %s', async (row) => {
    const h = harness();
    const tx = txWith(row);
    await expect(
      h.service.claim(
        tx as unknown as Prisma.TransactionClient,
        'user-1',
        'MOMENT',
        ['posts/user-1/file.jpg'],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.uploadIntent.updateMany).not.toHaveBeenCalled();
  });

  it.each(['DELETING', 'DELETED'] as const)(
    'rejects an owned %s intent as expired',
    async (status) => {
      const h = harness();
      const tx = txWith(intent({ status }));
      await expect(
        h.service.claim(
          tx as unknown as Prisma.TransactionClient,
          'user-1',
          'MOMENT',
          ['posts/user-1/file.jpg'],
        ),
      ).rejects.toThrow('上传已过期，请重新选择');
    },
  );

  it('scans each purpose once with cursor pagination and reconciles every due key', async () => {
    const h = harness();
    const imageIntent = intent({
      id: 'image-intent',
      objectKey: 'posts/user-1/image.jpg',
      fileUrl: 'https://cdn.example/posts/user-1/image.jpg',
    });
    const attachmentIntent = intent({
      id: 'attachment-intent',
      objectKey: 'posts/user-1/attachment.mp4',
      fileUrl: 'https://cdn.example/posts/user-1/attachment.mp4',
    });
    const posterIntent = intent({
      id: 'poster-intent',
      objectKey: 'posts/user-1/poster.jpg',
      fileUrl: 'https://cdn.example/posts/user-1/poster.jpg',
    });
    h.prisma.uploadIntent.findMany.mockResolvedValue([
      imageIntent,
      attachmentIntent,
      posterIntent,
    ]);
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `trace-${String(index).padStart(3, '0')}`,
      images:
        index === 0
          ? ['https://legacy-cdn.example/posts/user-1/image.jpg?variant=small']
          : [],
      attachments:
        index === 1 ? [{ key: 'posts/user-1/attachment.mp4' }] : null,
    }));
    h.prisma.trace.findMany
      .mockResolvedValueOnce(firstPage as never)
      .mockResolvedValueOnce([
        {
          id: 'trace-100',
          images: [],
          attachments: [{ posterKey: 'posts/user-1/poster.jpg' }],
        },
      ] as never);

    await h.service.reclaim(new Set(), NOW);

    expect(h.prisma.trace.findMany).toHaveBeenCalledTimes(2);
    expect(h.prisma.trace.findMany).toHaveBeenNthCalledWith(1, {
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true, images: true, attachments: true },
    });
    expect(h.prisma.trace.findMany).toHaveBeenNthCalledWith(2, {
      orderBy: { id: 'asc' },
      take: 100,
      cursor: { id: 'trace-099' },
      skip: 1,
      select: { id: true, images: true, attachments: true },
    });
    expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledTimes(3);
    for (const id of ['image-intent', 'attachment-intent', 'poster-intent']) {
      expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id, status: 'PENDING' },
          data: expect.objectContaining({ status: 'CLAIMED' }),
        }),
      );
    }
    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('normalizes local URLs and ignores raw keys outside the purpose folder', async () => {
    const h = harness();
    const tx = txWith(null);
    await h.service.claim(
      tx as unknown as Prisma.TransactionClient,
      'user-1',
      'MOMENT',
      [
        'https://cdn.example/posts/user-1/file.jpg?token=ignored',
        'avatars/user-1/wrong.jpg',
        'https://external.example/posts/user-1/nope.jpg',
      ],
    );
    expect(tx.uploadIntent.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.uploadIntent.findUnique).toHaveBeenCalledWith({
      where: { objectKey: 'posts/user-1/file.jpg' },
    });
  });

  it('rejects when GC wins the lease race before the conditional claim', async () => {
    const h = harness();
    const tx = txWith(intent());
    tx.uploadIntent.updateMany.mockResolvedValue({ count: 0 });
    tx.uploadIntent.findUnique
      .mockResolvedValueOnce(intent())
      .mockResolvedValueOnce(
        intent({
          status: 'DELETING',
          deleteLeaseUntil: new Date(NOW.getTime() + 60_000),
        }),
      );

    await expect(
      h.service.claim(
        tx as unknown as Prisma.TransactionClient,
        'user-1',
        'MOMENT',
        ['posts/user-1/file.jpg'],
      ),
    ).rejects.toThrow('上传已过期，请重新选择');
  });

  it('allows when another claim wins the conditional update race', async () => {
    const h = harness();
    const tx = txWith(intent());
    tx.uploadIntent.updateMany.mockResolvedValue({ count: 0 });
    tx.uploadIntent.findUnique
      .mockResolvedValueOnce(intent())
      .mockResolvedValueOnce(intent({ status: 'CLAIMED', userID: 'other' }));

    await expect(
      h.service.claim(
        tx as unknown as Prisma.TransactionClient,
        'user-1',
        'MOMENT',
        ['posts/user-1/file.jpg'],
      ),
    ).resolves.toBeUndefined();
  });
});

describe('UploadIntentService.reclaim', () => {
  it('reports due intents and pending gauges without changing state or deleting', async () => {
    const h = harness('report');
    h.prisma.uploadIntent.findMany.mockResolvedValue([intent()]);
    h.prisma.uploadIntent.groupBy.mockResolvedValue([
      { folder: 'posts', _count: { _all: 2 }, _sum: { sizeBytes: 3072 } },
    ]);

    await h.service.reclaim(new Set(), NOW);

    expect(h.prisma.uploadIntent.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.uploadIntent.deleteMany).not.toHaveBeenCalled();
    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('classifies report candidates without any database mutation or object deletion', async () => {
    const h = harness('report');
    const snapshot = intent({
      id: 'snapshot',
      objectKey: 'posts/user-1/snapshot.jpg',
    });
    const fresh = intent({
      id: 'fresh',
      objectKey: 'posts/user-1/fresh.jpg',
    });
    const abandoned = intent({
      id: 'abandoned',
      objectKey: 'posts/user-1/abandoned.jpg',
    });
    h.prisma.uploadIntent.findMany.mockResolvedValue([
      snapshot,
      fresh,
      abandoned,
    ]);
    h.prisma.trace.findMany.mockResolvedValue([
      {
        id: 'trace-1',
        images: ['https://legacy-cdn.example/posts/user-1/fresh.jpg'],
        attachments: null,
      },
    ]);
    h.prisma.uploadIntent.count.mockResolvedValue(3);
    const eventSpy = jest.spyOn(uploadMetrics, 'recordIntentEvent');
    const backlogSpy = jest.spyOn(uploadMetrics, 'setIntentBacklog');

    await h.service.reclaim(new Set(['posts/user-1/snapshot.jpg']), NOW);

    expect(h.prisma.trace.findMany).toHaveBeenCalledTimes(1);
    expect(eventSpy).toHaveBeenCalledWith('posts', 'would_rescue', 'report');
    expect(eventSpy).toHaveBeenCalledWith('posts', 'would_delete', 'report');
    expect(
      eventSpy.mock.calls.filter(([, event]) => event === 'would_rescue'),
    ).toHaveLength(2);
    expect(backlogSpy).toHaveBeenCalledWith('report', 0);
    expect(h.prisma.uploadIntent.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.uploadIntent.deleteMany).not.toHaveBeenCalled();
    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
    eventSpy.mockRestore();
    backlogSpy.mockRestore();
  });

  it('uses an immutable id keyset when every lease in the first page is lost', async () => {
    const h = harness();
    const rows = Array.from({ length: 101 }, (_, index) =>
      intent({
        id: `intent-${String(index).padStart(3, '0')}`,
        objectKey: `posts/user-1/${index}.jpg`,
      }),
    );
    h.prisma.uploadIntent.findMany
      .mockResolvedValueOnce(rows.slice(0, 100))
      .mockResolvedValueOnce(rows.slice(100));
    h.prisma.uploadIntent.updateMany.mockResolvedValue({ count: 0 });
    h.prisma.uploadIntent.findUnique.mockResolvedValue(
      intent({ status: 'CLAIMED' }),
    );

    await h.service.reclaim(new Set(), NOW);

    expect(h.prisma.uploadIntent.findMany).toHaveBeenCalledTimes(2);
    expect(h.prisma.uploadIntent.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          AND: [
            expect.objectContaining({ OR: expect.any(Array) }),
            {
              id: { gt: 'intent-099' },
            },
          ],
        },
        orderBy: { id: 'asc' },
        take: 100,
      }),
    );
    expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledTimes(101);
    expect(h.prisma.trace.findMany).toHaveBeenCalledTimes(1);
    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('classifies one bounded report run and scans one purpose only once', async () => {
    const h = harness('report');
    const pages = Array.from({ length: 5 }, (_, page) =>
      Array.from({ length: 100 }, (_, offset) => {
        const index = page * 100 + offset;
        return intent({
          id: `intent-${String(index).padStart(3, '0')}`,
          objectKey: `posts/user-1/${index}.jpg`,
        });
      }),
    );
    for (const page of pages) {
      h.prisma.uploadIntent.findMany.mockResolvedValueOnce(page);
    }
    h.prisma.uploadIntent.findMany.mockResolvedValueOnce([
      intent({ id: 'intent-500', objectKey: 'posts/user-1/500.jpg' }),
    ]);
    const firstReferencePage = Array.from({ length: 100 }, (_, index) => ({
      id: `trace-${String(index).padStart(3, '0')}`,
      images: index === 0 ? ['https://cdn.example/posts/user-1/0.jpg'] : [],
      attachments: null,
    }));
    h.prisma.trace.findMany
      .mockResolvedValueOnce(firstReferencePage as never)
      .mockResolvedValueOnce([
        {
          id: 'trace-100',
          images: ['https://cdn.example/posts/user-1/500.jpg'],
          attachments: null,
        },
      ] as never);
    h.prisma.uploadIntent.count.mockResolvedValue(501);
    const backlogSpy = jest.spyOn(uploadMetrics, 'setIntentBacklog');
    const eventSpy = jest.spyOn(uploadMetrics, 'recordIntentEvent');

    await h.service.reclaim(new Set(), NOW);

    expect(h.prisma.uploadIntent.findMany).toHaveBeenCalledTimes(5);
    expect(h.prisma.uploadIntent.findMany).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        where: {
          AND: [
            expect.objectContaining({ OR: expect.any(Array) }),
            {
              id: { gt: 'intent-399' },
            },
          ],
        },
        orderBy: { id: 'asc' },
        take: 100,
      }),
    );
    expect(h.prisma.trace.findMany).toHaveBeenCalledTimes(2);
    expect(
      eventSpy.mock.calls.filter(([, event]) => event === 'would_rescue'),
    ).toHaveLength(1);
    expect(
      eventSpy.mock.calls.filter(([, event]) => event === 'would_delete'),
    ).toHaveLength(499);
    expect(backlogSpy).toHaveBeenCalledWith('report', 1);
    expect(h.prisma.uploadIntent.updateMany).not.toHaveBeenCalled();
    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
    backlogSpy.mockRestore();
    eventSpy.mockRestore();
  });

  it('durably rescues a snapshot-referenced intent before fresh checks', async () => {
    const h = harness();
    h.prisma.uploadIntent.findMany.mockResolvedValue([intent()]);

    await h.service.reclaim(new Set(['posts/user-1/file.jpg']), NOW);

    expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledWith({
      where: { id: 'intent-1', status: 'PENDING' },
      data: {
        status: 'CLAIMED',
        claimedAt: NOW,
        deleteLeaseUntil: null,
        lastDeleteError: null,
      },
    });
    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it.each([
    [
      'PROFILE_AVATAR',
      'avatars/user-1/avatar.jpg',
      'https://cdn.example/avatars/user-1/avatar.jpg?size=small',
      'user',
      { avatarUrl: 'https://cdn.example/avatars/user-1/avatar.jpg?size=small' },
    ],
    [
      'CIRCLE_AVATAR',
      'avatars/user-1/circle.jpg',
      'https://cdn.example/avatars/user-1/circle.jpg',
      'circle',
      { avatarUrl: 'https://cdn.example/avatars/user-1/circle.jpg' },
    ],
    [
      'PLAZA_POST',
      'posts/user-1/plaza.jpg',
      'https://cdn.example/posts/user-1/plaza.jpg',
      'circlePost',
      { images: [], videos: ['https://cdn.example/posts/user-1/plaza.jpg'] },
    ],
    [
      'MOMENT',
      'posts/user-1/poster.jpg',
      'https://cdn.example/posts/user-1/poster.jpg',
      'trace',
      {
        images: [],
        attachments: [{ key: 'other', posterKey: 'posts/user-1/poster.jpg' }],
      },
    ],
    [
      'MOMENT_COMMENT',
      'posts/user-1/comment.jpg',
      'https://cdn.example/posts/user-1/comment.jpg',
      'traceComment',
      { images: ['https://cdn.example/posts/user-1/comment.jpg'] },
    ],
  ] as const)(
    'persists a fresh %s reference as claimed',
    async (purpose, objectKey, fileUrl, delegate, candidate) => {
      const h = harness();
      h.prisma.uploadIntent.findMany.mockResolvedValue([
        intent({
          purpose,
          objectKey,
          fileUrl,
          folder: objectKey.split('/')[0],
        }),
      ]);
      h.prisma[delegate].findMany.mockResolvedValue([candidate] as never);

      await h.service.reclaim(new Set(), NOW);

      expect(h.prisma[delegate].findMany).toHaveBeenCalledTimes(1);
      expect(h.prisma[delegate].findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { id: 'asc' },
          take: 100,
        }),
      );
      expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'intent-1',
            status: 'PENDING',
          },
          data: expect.objectContaining({ status: 'CLAIMED', claimedAt: NOW }),
        }),
      );
      expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
    },
  );

  it('leases and deletes an unreferenced intent with lease-owned write-back', async () => {
    const h = harness();
    h.prisma.uploadIntent.findMany.mockResolvedValue([intent()]);

    await h.service.reclaim(new Set(), NOW);

    expect(h.upload.deleteObjectByKey).toHaveBeenCalledWith(
      'posts/user-1/file.jpg',
    );
    const leaseWrite = h.prisma.uploadIntent.updateMany.mock.calls.find(
      ([call]) => call.data.status === 'DELETING',
    )?.[0];
    expect(leaseWrite).toEqual({
      where: { id: 'intent-1', status: 'PENDING', expiresAt: { lte: NOW } },
      data: {
        status: 'DELETING',
        deleteLeaseUntil: expect.any(Date),
        lastDeleteError: null,
      },
    });
    const lease = leaseWrite.data.deleteLeaseUntil;
    expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'intent-1',
        status: 'DELETING',
        deleteLeaseUntil: lease,
      },
      data: {
        status: 'DELETED',
        deletedAt: NOW,
        deleteLeaseUntil: null,
        lastDeleteError: null,
      },
    });
  });

  it('returns a failed deletion to pending with exponential backoff', async () => {
    const h = harness();
    h.prisma.uploadIntent.findMany.mockResolvedValue([
      intent({ deleteAttempts: 2 }),
    ]);
    h.upload.deleteObjectByKey.mockRejectedValue(
      new Error('storage unavailable'),
    );

    await h.service.reclaim(new Set(), NOW);

    const leaseWrite = h.prisma.uploadIntent.updateMany.mock.calls.find(
      ([call]) => call.data.status === 'DELETING',
    )?.[0];
    expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'intent-1',
        status: 'DELETING',
        deleteLeaseUntil: leaseWrite.data.deleteLeaseUntil,
      },
      data: {
        status: 'PENDING',
        deleteAttempts: 3,
        lastDeleteError: 'storage unavailable',
        expiresAt: new Date('2026-11-17T12:04:00.000Z'),
        deleteLeaseUntil: null,
      },
    });
  });

  it('does not delete when a concurrent claim wins before the lease', async () => {
    const h = harness();
    h.prisma.uploadIntent.findMany.mockResolvedValue([intent()]);
    h.prisma.uploadIntent.updateMany.mockResolvedValueOnce({ count: 0 });
    h.prisma.uploadIntent.findUnique.mockResolvedValue(
      intent({ status: 'CLAIMED', claimedAt: NOW }),
    );

    await h.service.reclaim(new Set(), NOW);

    expect(h.upload.deleteObjectByKey).not.toHaveBeenCalled();
  });

  it('retries an expired deleting lease using the observed lease value', async () => {
    const h = harness();
    const oldLease = new Date('2026-11-17T11:59:00.000Z');
    h.prisma.uploadIntent.findMany.mockResolvedValue([
      intent({ status: 'DELETING', deleteLeaseUntil: oldLease }),
    ]);

    await h.service.reclaim(new Set(), NOW);

    expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'intent-1',
        status: 'DELETING',
        deleteLeaseUntil: oldLease,
      },
      data: {
        status: 'DELETING',
        deleteLeaseUntil: expect.any(Date),
        lastDeleteError: null,
      },
    });
    expect(h.upload.deleteObjectByKey).toHaveBeenCalledTimes(1);
  });

  it('rescues an expired deleting row only while it still owns the observed lease', async () => {
    const h = harness();
    const oldLease = new Date('2026-11-17T11:59:00.000Z');
    h.prisma.uploadIntent.findMany.mockResolvedValue([
      intent({ status: 'DELETING', deleteLeaseUntil: oldLease }),
    ]);

    await h.service.reclaim(new Set(['posts/user-1/file.jpg']), NOW);

    expect(h.prisma.uploadIntent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'intent-1',
        status: 'DELETING',
        deleteLeaseUntil: oldLease,
      },
      data: expect.objectContaining({ status: 'CLAIMED' }),
    });
  });

  it('leaves a successful delete leased when write-back fails so expiry can retry it', async () => {
    const h = harness();
    const first = intent();
    const expiredLease = new Date('2026-11-17T11:59:00.000Z');
    h.prisma.uploadIntent.findMany
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([
        intent({ status: 'DELETING', deleteLeaseUntil: expiredLease }),
      ]);
    h.prisma.uploadIntent.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ count: 1 });

    await expect(h.service.reclaim(new Set(), NOW)).resolves.toBeUndefined();
    await expect(
      h.service.reclaim(new Set(), new Date('2026-11-17T12:30:00.000Z')),
    ).resolves.toBeUndefined();

    expect(h.upload.deleteObjectByKey).toHaveBeenCalledTimes(2);
  });

  it('continues after one deletion fails and prunes 30-day terminal rows', async () => {
    const h = harness();
    h.prisma.uploadIntent.findMany.mockResolvedValue([
      intent({ id: 'failed', objectKey: 'posts/user-1/failed.jpg' }),
      intent({ id: 'success', objectKey: 'posts/user-1/success.jpg' }),
    ]);
    h.upload.deleteObjectByKey
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);

    await h.service.reclaim(new Set(), NOW);

    expect(h.upload.deleteObjectByKey).toHaveBeenCalledTimes(2);
    expect(h.prisma.uploadIntent.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            status: 'CLAIMED',
            claimedAt: { lte: new Date('2026-10-18T12:00:00.000Z') },
          },
          {
            status: 'DELETED',
            deletedAt: { lte: new Date('2026-10-18T12:00:00.000Z') },
          },
        ],
      },
    });
  });

  it('continues after recording a deletion failure also loses the database write', async () => {
    const h = harness();
    h.prisma.uploadIntent.findMany.mockResolvedValue([
      intent({ id: 'failed', objectKey: 'posts/user-1/failed.jpg' }),
      intent({ id: 'success', objectKey: 'posts/user-1/success.jpg' }),
    ]);
    h.upload.deleteObjectByKey
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);
    h.prisma.uploadIntent.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ count: 1 });

    await expect(h.service.reclaim(new Set(), NOW)).resolves.toBeUndefined();
    expect(h.upload.deleteObjectByKey).toHaveBeenCalledTimes(2);
  });
});

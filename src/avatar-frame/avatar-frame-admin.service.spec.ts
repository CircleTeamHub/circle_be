import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AvatarFrameErrorCode } from 'src/common/app-error-codes';
import { encodeFeedCursor } from 'src/utils/feed-cursor';
import { AvatarFrameAdminService } from './avatar-frame-admin.service';

describe('AvatarFrameAdminService', () => {
  const operatorId = '10000000-0000-4000-8000-000000000001';
  const otherOperatorId = '10000000-0000-4000-8000-000000000002';
  const targetId = '20000000-0000-4000-8000-000000000001';
  const otherTargetId = '20000000-0000-4000-8000-000000000002';
  const frameId = '30000000-0000-4000-8000-000000000001';
  const otherFrameId = '30000000-0000-4000-8000-000000000002';
  const grantId = '40000000-0000-4000-8000-000000000001';
  const idempotencyKey = '50000000-0000-4000-8000-000000000001';
  const now = new Date('2026-07-29T12:00:00.000Z');
  const finiteExpiry = new Date('2026-08-29T12:00:00.000Z');

  const frame = {
    id: frameId,
    key: 'membership-diamond',
    name: 'Diamond',
    description: 'Diamond frame',
    imageUrl: null,
    minimumVipLevel: 3,
    isActive: true,
    sortOrder: 10,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  const grant = (overrides: Record<string, unknown> = {}) => ({
    id: grantId,
    userID: targetId,
    frameID: frameId,
    operatorUserID: operatorId,
    idempotencyKey,
    reason: 'support case approved',
    expiresAt: null,
    revokedAt: null,
    revokedByUserID: null,
    revokeReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  function buildHarness() {
    const tx = {
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: operatorId }, { id: targetId }]),
      },
      avatarFrameAsset: {
        findUnique: jest.fn().mockResolvedValue(frame),
      },
      userAvatarFrameGrant: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve(
            grant({
              ...data,
              createdAt: now,
              updatedAt: now,
            }),
          ),
        ),
        update: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve(
            grant({
              ...data,
              updatedAt: now,
            }),
          ),
        ),
      },
      adminAuditLog: { create: jest.fn() },
    };
    const prisma = {
      avatarFrameAsset: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      userAvatarFrameGrant: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const avatarFrames = {
      getInventory: jest.fn().mockResolvedValue({
        equippedFrameId: null,
        items: [],
      }),
      recomputeSelectionContinuityInTransaction: jest
        .fn()
        .mockResolvedValue(undefined),
      publishAppearanceChanged: jest.fn().mockResolvedValue(undefined),
    };
    const audit = {
      recordStrict: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AvatarFrameAdminService(
      prisma as never,
      avatarFrames as never,
      audit as never,
    );
    return { service, prisma, tx, avatarFrames, audit };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now.getTime());
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('lists only active catalog assets in stable selector order and with bounded fields', async () => {
    const { service, prisma } = buildHarness();
    prisma.avatarFrameAsset.findMany.mockResolvedValue([frame]);

    await expect(service.listAssets()).resolves.toEqual([
      {
        id: frameId,
        key: 'membership-diamond',
        name: 'Diamond',
        description: 'Diamond frame',
        imageUrl: null,
        minimumVipLevel: 3,
        sortOrder: 10,
      },
    ]);
    expect(prisma.avatarFrameAsset.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        imageUrl: true,
        minimumVipLevel: true,
        sortOrder: true,
      },
    });
  });

  it('returns effective inventory plus every admin grant without sensitive user fields', async () => {
    const { service, prisma, avatarFrames } = buildHarness();
    const expired = grant({
      id: '40000000-0000-4000-8000-000000000002',
      expiresAt: new Date('2026-07-28T12:00:00.000Z'),
    });
    const revoked = grant({
      id: '40000000-0000-4000-8000-000000000003',
      revokedAt: new Date('2026-07-27T12:00:00.000Z'),
      revokedByUserID: otherOperatorId,
      revokeReason: 'issued in error',
    });
    avatarFrames.getInventory.mockResolvedValue({
      equippedFrameId: frameId,
      items: [
        {
          ...frame,
          ownedSources: [
            {
              type: 'MEMBERSHIP',
              minimumVipLevel: 3,
              expiresAt: finiteExpiry,
            },
          ],
          availableUntil: finiteExpiry,
          equipped: true,
        },
      ],
    });
    prisma.userAvatarFrameGrant.findMany.mockResolvedValue([
      grant(),
      expired,
      revoked,
    ]);

    const result = await service.getUserInventory(targetId);

    expect(result.userId).toBe(targetId);
    expect(result.equippedFrameId).toBe(frameId);
    expect(result.items[0].ownedSources[0].type).toBe('MEMBERSHIP');
    expect(
      result.grants.items.map((item: { status: string }) => item.status),
    ).toEqual(['ACTIVE', 'EXPIRED', 'REVOKED']);
    expect(result.grants.items[2]).toMatchObject({
      operatorUserId: operatorId,
      revokedByUserId: otherOperatorId,
      reason: 'support case approved',
      revokeReason: 'issued in error',
    });
    expect(result.grants).toMatchObject({
      limit: 50,
      hasMore: false,
      nextCursor: null,
    });
    expect(prisma.userAvatarFrameGrant.findMany).toHaveBeenCalledWith({
      where: { userID: targetId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
      select: expect.not.objectContaining({
        user: expect.anything(),
        operatorUser: expect.anything(),
        revokedByUser: expect.anything(),
      }),
    });
  });

  it('traverses equal-timestamp grant pages without duplicates and returns an opaque cursor', async () => {
    const { service, prisma } = buildHarness();
    const sharedCreatedAt = new Date('2026-07-29T11:00:00.000Z');
    const third = grant({
      id: '40000000-0000-4000-8000-000000000003',
      createdAt: sharedCreatedAt,
    });
    const second = grant({
      id: '40000000-0000-4000-8000-000000000002',
      createdAt: sharedCreatedAt,
    });
    const first = grant({
      id: '40000000-0000-4000-8000-000000000001',
      createdAt: new Date('2026-07-29T10:00:00.000Z'),
    });
    prisma.userAvatarFrameGrant.findMany
      .mockResolvedValueOnce([third, second, first])
      .mockResolvedValueOnce([first]);

    const pageOne = await service.getUserInventory(targetId, { limit: 2 });
    const pageTwo = await service.getUserInventory(targetId, {
      limit: 2,
      cursor: pageOne.grants.nextCursor as string,
    });

    expect(pageOne.grants.items.map(({ id }: { id: string }) => id)).toEqual([
      third.id,
      second.id,
    ]);
    expect(pageOne.grants.nextCursor).toBe(
      encodeFeedCursor(sharedCreatedAt, second.id),
    );
    expect(pageOne.grants.nextCursor).not.toContain(second.id);
    expect(pageOne.grants.hasMore).toBe(true);
    expect(pageTwo.grants.items.map(({ id }: { id: string }) => id)).toEqual([
      first.id,
    ]);
    expect(pageTwo.grants.nextCursor).toBeNull();
    expect(
      new Set(
        [...pageOne.grants.items, ...pageTwo.grants.items].map(
          ({ id }: { id: string }) => id,
        ),
      ).size,
    ).toBe(3);
    expect(prisma.userAvatarFrameGrant.findMany.mock.calls[1][0]).toEqual({
      where: {
        userID: targetId,
        OR: [
          { createdAt: { lt: sharedCreatedAt } },
          { createdAt: sharedCreatedAt, id: { lt: second.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
      select: expect.any(Object),
    });
  });

  it('rejects a malformed grant-history cursor before querying inventory', async () => {
    const { service, prisma, avatarFrames } = buildHarness();

    await expect(
      service.getUserInventory(targetId, {
        cursor: 'not-a-valid-cursor',
        limit: 50,
      }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: { errorCode: AvatarFrameErrorCode.InvalidCursor },
    });
    expect(avatarFrames.getInventory).not.toHaveBeenCalled();
    expect(prisma.userAvatarFrameGrant.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, null],
    [null, null],
    [finiteExpiry.toISOString(), finiteExpiry],
  ])(
    'creates a permanent or finite grant in a serializable transaction (expiresAt=%s)',
    async (expiresAt, expectedExpiry) => {
      const { service, prisma, tx, audit, avatarFrames } = buildHarness();

      const result = await service.grant(
        operatorId,
        targetId,
        {
          frameId,
          expiresAt,
          reason: ' support case approved ',
          idempotencyKey,
        },
        { ip: '127.0.0.1', userAgent: 'admin-console' },
      );

      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: 'Serializable' }),
      );
      expect(tx.userAvatarFrameGrant.create).toHaveBeenCalledWith({
        data: {
          userID: targetId,
          frameID: frameId,
          operatorUserID: operatorId,
          idempotencyKey,
          reason: 'support case approved',
          expiresAt: expectedExpiry,
        },
      });
      expect(audit.recordStrict).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          actorID: operatorId,
          action: 'avatar_frame_grant_created',
          entityType: 'UserAvatarFrameGrant',
          entityID: grantId,
          before: null,
          reason: 'support case approved',
          ip: '127.0.0.1',
          userAgent: 'admin-console',
        }),
      );
      expect(
        avatarFrames.recomputeSelectionContinuityInTransaction,
      ).toHaveBeenCalledWith(tx, targetId, now);
      expect(avatarFrames.publishAppearanceChanged).toHaveBeenCalledWith(
        targetId,
      );
      expect(result).toMatchObject({
        replayed: false,
        grant: {
          id: grantId,
          userId: targetId,
          frameId,
          expiresAt: expectedExpiry,
          status: 'ACTIVE',
        },
      });
    },
  );

  it('rejects a non-future expiry with a stable error code', async () => {
    const { service } = buildHarness();

    await expect(
      service.grant(operatorId, targetId, {
        frameId,
        expiresAt: now.toISOString(),
        reason: 'support case approved',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      response: { errorCode: AvatarFrameErrorCode.InvalidExpiry },
    });
  });

  it.each([
    ['target', [{ id: operatorId }], AvatarFrameErrorCode.UserNotFound],
    ['operator', [{ id: targetId }], AvatarFrameErrorCode.OperatorNotFound],
  ])(
    'rejects a missing %s before creating a grant',
    async (_label, users, errorCode) => {
      const { service, tx } = buildHarness();
      tx.user.findMany.mockResolvedValue(users);

      await expect(
        service.grant(operatorId, targetId, {
          frameId,
          reason: 'support case approved',
          idempotencyKey,
        }),
      ).rejects.toMatchObject({
        constructor: NotFoundException,
        response: { errorCode },
      });
      expect(tx.userAvatarFrameGrant.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    [null, AvatarFrameErrorCode.AssetNotFound, NotFoundException],
    [
      { ...frame, isActive: false },
      AvatarFrameErrorCode.AssetInactive,
      ConflictException,
    ],
  ])(
    'rejects a missing or inactive asset',
    async (asset, errorCode, exception) => {
      const { service, tx } = buildHarness();
      tx.avatarFrameAsset.findUnique.mockResolvedValue(asset);

      await expect(
        service.grant(operatorId, targetId, {
          frameId,
          reason: 'support case approved',
          idempotencyKey,
        }),
      ).rejects.toMatchObject({
        constructor: exception,
        response: { errorCode },
      });
      expect(tx.userAvatarFrameGrant.create).not.toHaveBeenCalled();
    },
  );

  it('returns the original result with replayed=true for an exact idempotent replay', async () => {
    const { service, tx, avatarFrames, audit } = buildHarness();
    tx.userAvatarFrameGrant.findUnique.mockResolvedValue(grant());

    await expect(
      service.grant(operatorId, targetId, {
        frameId,
        reason: ' support case approved ',
        idempotencyKey,
      }),
    ).resolves.toMatchObject({
      replayed: true,
      grant: { id: grantId, status: 'ACTIVE' },
    });
    expect(tx.userAvatarFrameGrant.create).not.toHaveBeenCalled();
    expect(audit.recordStrict).not.toHaveBeenCalled();
    expect(avatarFrames.publishAppearanceChanged).not.toHaveBeenCalled();
  });

  it.each([
    [otherOperatorId, targetId, frameId, null, 'support case approved'],
    [operatorId, otherTargetId, frameId, null, 'support case approved'],
    [operatorId, targetId, otherFrameId, null, 'support case approved'],
    [
      operatorId,
      targetId,
      frameId,
      finiteExpiry.toISOString(),
      'support case approved',
    ],
    [operatorId, targetId, frameId, null, 'different reason'],
  ])(
    'rejects idempotency-key reuse for a different canonical request',
    async (actor, target, selectedFrame, expiresAt, reason) => {
      const { service, tx } = buildHarness();
      tx.userAvatarFrameGrant.findUnique.mockResolvedValue(grant());

      await expect(
        service.grant(actor, target, {
          frameId: selectedFrame,
          expiresAt,
          reason,
          idempotencyKey,
        }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: { errorCode: AvatarFrameErrorCode.IdempotencyConflict },
      });
    },
  );

  it('resolves a P2002 create race as an exact replay and rejects a conflicting winner', async () => {
    const exactHarness = buildHarness();
    exactHarness.prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    exactHarness.prisma.userAvatarFrameGrant.findUnique.mockResolvedValue(
      grant(),
    );

    await expect(
      exactHarness.service.grant(operatorId, targetId, {
        frameId,
        reason: 'support case approved',
        idempotencyKey,
      }),
    ).resolves.toMatchObject({ replayed: true, grant: { id: grantId } });

    const conflictHarness = buildHarness();
    conflictHarness.prisma.$transaction.mockRejectedValue({ code: 'P2002' });
    conflictHarness.prisma.userAvatarFrameGrant.findUnique.mockResolvedValue(
      grant({ reason: 'other request won' }),
    );
    await expect(
      conflictHarness.service.grant(operatorId, targetId, {
        frameId,
        reason: 'support case approved',
        idempotencyKey,
      }),
    ).rejects.toMatchObject({
      response: { errorCode: AvatarFrameErrorCode.IdempotencyConflict },
    });
  });

  it('rolls back grant creation when strict audit fails and skips post-commit work', async () => {
    const { service, audit, avatarFrames } = buildHarness();
    audit.recordStrict.mockRejectedValue(new Error('audit unavailable'));

    await expect(
      service.grant(operatorId, targetId, {
        frameId,
        reason: 'support case approved',
        idempotencyKey,
      }),
    ).rejects.toThrow('audit unavailable');
    expect(avatarFrames.publishAppearanceChanged).not.toHaveBeenCalled();
  });

  it('revokes inside the transaction, strictly audits, and recomputes selected-frame continuity', async () => {
    const { service, tx, audit, avatarFrames } = buildHarness();
    tx.userAvatarFrameGrant.findUnique.mockResolvedValue(grant());

    const result = await service.revoke(
      operatorId,
      grantId,
      {
        reason: ' issued in error ',
      },
      { ip: '127.0.0.1', userAgent: 'admin-console' },
    );

    expect(tx.userAvatarFrameGrant.update).toHaveBeenCalledWith({
      where: { id: grantId },
      data: {
        revokedAt: now,
        revokedByUserID: operatorId,
        revokeReason: 'issued in error',
      },
    });
    expect(audit.recordStrict).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        actorID: operatorId,
        action: 'avatar_frame_grant_revoked',
        entityType: 'UserAvatarFrameGrant',
        entityID: grantId,
        reason: 'issued in error',
        ip: '127.0.0.1',
        userAgent: 'admin-console',
        before: expect.objectContaining({ revokedAt: null }),
        after: expect.objectContaining({
          revokedAt: now.toISOString(),
          revokedByUserId: operatorId,
        }),
      }),
    );
    expect(
      avatarFrames.recomputeSelectionContinuityInTransaction,
    ).toHaveBeenCalledWith(tx, targetId, now);
    expect(avatarFrames.publishAppearanceChanged).toHaveBeenCalledWith(
      targetId,
    );
    expect(result).toMatchObject({
      replayed: false,
      grant: {
        id: grantId,
        status: 'REVOKED',
        revokedByUserId: operatorId,
        revokeReason: 'issued in error',
      },
    });
  });

  it('lets continuity recomputation preserve another source, clear the final source, or tighten the deadline', async () => {
    const { service, tx, avatarFrames } = buildHarness();
    tx.userAvatarFrameGrant.findUnique.mockResolvedValue(grant());

    await service.revoke(operatorId, grantId, { reason: 'issued in error' });

    expect(
      avatarFrames.recomputeSelectionContinuityInTransaction,
    ).toHaveBeenCalledTimes(1);
    expect(
      avatarFrames.recomputeSelectionContinuityInTransaction,
    ).toHaveBeenCalledWith(tx, targetId, now);
  });

  it('returns the same result for a same-operator/same-reason revoke replay', async () => {
    const { service, tx, audit, avatarFrames } = buildHarness();
    tx.userAvatarFrameGrant.findUnique.mockResolvedValue(
      grant({
        revokedAt: now,
        revokedByUserID: operatorId,
        revokeReason: 'issued in error',
      }),
    );

    await expect(
      service.revoke(operatorId, grantId, { reason: ' issued in error ' }),
    ).resolves.toMatchObject({
      replayed: true,
      grant: { id: grantId, status: 'REVOKED' },
    });
    expect(tx.userAvatarFrameGrant.update).not.toHaveBeenCalled();
    expect(audit.recordStrict).not.toHaveBeenCalled();
    expect(
      avatarFrames.recomputeSelectionContinuityInTransaction,
    ).not.toHaveBeenCalled();
  });

  it.each([
    [otherOperatorId, 'issued in error'],
    [operatorId, 'different revoke reason'],
  ])(
    'rejects a different already-revoked request with a stable conflict',
    async (actor, reason) => {
      const { service, tx } = buildHarness();
      tx.userAvatarFrameGrant.findUnique.mockResolvedValue(
        grant({
          revokedAt: now,
          revokedByUserID: operatorId,
          revokeReason: 'issued in error',
        }),
      );

      await expect(
        service.revoke(actor, grantId, { reason }),
      ).rejects.toMatchObject({
        constructor: ConflictException,
        response: { errorCode: AvatarFrameErrorCode.AlreadyRevoked },
      });
    },
  );

  it('rejects a missing grant with a stable not-found code', async () => {
    const { service } = buildHarness();

    await expect(
      service.revoke(operatorId, grantId, { reason: 'issued in error' }),
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      response: { errorCode: AvatarFrameErrorCode.GrantNotFound },
    });
  });
});

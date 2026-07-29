import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AvatarFrameErrorCode } from 'src/common/app-error-codes';
import { AvatarFrameService } from './avatar-frame.service';

describe('AvatarFrameService', () => {
  const now = new Date('2027-07-29T12:00:00.000Z');
  const userId = 'user-1';
  const diamondId = '10000000-0000-4000-8000-000000000001';
  const superId = '10000000-0000-4000-8000-000000000002';

  const prisma = {
    $transaction: jest.fn(),
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    avatarFrameAsset: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
    userAvatarFrameGrant: {
      findMany: jest.fn(),
    },
  };
  const realtime = {
    invalidateUserHotCache: jest.fn(),
    broadcastUserProfileSummary: jest.fn(),
  };
  let service: AvatarFrameService;

  const asset = (
    id: string,
    minimumVipLevel: number | null,
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    key: id === diamondId ? 'membership-diamond' : 'membership-super',
    name: id === diamondId ? 'Diamond frame' : 'Super frame',
    description: 'Frame description',
    imageUrl: null,
    minimumVipLevel,
    isActive: true,
    sortOrder: id === diamondId ? 10 : 20,
    grants: [],
    ...overrides,
  });

  const user = (overrides: Record<string, unknown> = {}) => ({
    id: userId,
    vipLevel: 0,
    vipExpiresAt: null,
    selectedAvatarFrameID: null,
    selectedAvatarFrameExpiresAt: null,
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now.getTime());
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
    );
    prisma.user.findUnique.mockResolvedValue(user());
    prisma.avatarFrameAsset.findMany.mockResolvedValue([]);
    prisma.userAvatarFrameGrant.findMany.mockResolvedValue([]);
    realtime.invalidateUserHotCache.mockResolvedValue(true);
    realtime.broadcastUserProfileSummary.mockResolvedValue(undefined);
    service = new AvatarFrameService(prisma as never, realtime as never);
  });

  afterEach(() => jest.useRealTimers());

  describe('public appearance resolution', () => {
    it('maps an active selected frame when its membership source is current', () => {
      const state = {
        ...user({
          vipLevel: 3,
          vipExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
          selectedAvatarFrameID: diamondId,
          selectedAvatarFrameExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
        }),
        selectedAvatarFrame: asset(diamondId, 3),
        avatarFrameGrants: [],
      };

      expect(service.toPublicAppearance(state, now)).toEqual({
        id: diamondId,
        key: 'membership-diamond',
        name: 'Diamond frame',
        imageUrl: null,
      });
    });

    it.each([
      [
        'inactive asset',
        {
          selectedAvatarFrame: asset(diamondId, 3, { isActive: false }),
        },
      ],
      [
        'expired selection deadline',
        {
          selectedAvatarFrameExpiresAt: new Date('2027-07-29T11:59:59.999Z'),
        },
      ],
      [
        'expired membership source',
        {
          vipExpiresAt: new Date('2027-07-29T11:59:59.999Z'),
        },
      ],
    ])('maps %s to null', (_label, overrides) => {
      const state = {
        ...user({
          vipLevel: 3,
          vipExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
          selectedAvatarFrameID: diamondId,
          selectedAvatarFrameExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
        }),
        selectedAvatarFrame: asset(diamondId, 3),
        avatarFrameGrants: [],
        ...overrides,
      };

      expect(service.toPublicAppearance(state, now)).toBeNull();
    });

    it('resolves a batch in one bounded user query and includes null appearances', async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          ...user({
            id: 'user-active',
            vipLevel: 3,
            vipExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
            selectedAvatarFrameID: diamondId,
            selectedAvatarFrameExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
          }),
          selectedAvatarFrame: asset(diamondId, 3),
          avatarFrameGrants: [],
        },
        {
          ...user({
            id: 'user-expired',
            vipLevel: 3,
            vipExpiresAt: new Date('2027-07-29T11:59:59.999Z'),
          }),
          selectedAvatarFrame: null,
          avatarFrameGrants: [],
        },
      ]);

      await expect(
        service.resolvePublicAppearances(
          ['user-active', 'user-expired', 'user-active'],
          now,
        ),
      ).resolves.toEqual(
        new Map([
          [
            'user-active',
            {
              vipLevel: 3,
              avatarFrame: {
                id: diamondId,
                key: 'membership-diamond',
                name: 'Diamond frame',
                imageUrl: null,
              },
            },
          ],
          ['user-expired', { vipLevel: 0, avatarFrame: null }],
        ]),
      );
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['user-active', 'user-expired'] } },
        }),
      );
    });

    it('short-circuits an empty appearance batch', async () => {
      await expect(service.resolvePublicAppearances([], now)).resolves.toEqual(
        new Map(),
      );
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('chunks more than 200 unique ids and merges every result in input order', async () => {
      const ids = Array.from(
        { length: 205 },
        (_, index) => `user-${String(index).padStart(3, '0')}`,
      );
      prisma.user.findMany.mockImplementation(
        ({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(
            where.id.in.map((id) => ({
              ...user({ id }),
              selectedAvatarFrame: null,
              avatarFrameGrants: [],
            })),
          ),
      );

      const result = await service.resolvePublicAppearances(
        [...ids, ids[0]],
        now,
      );

      expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
      for (const [query] of prisma.user.findMany.mock.calls) {
        expect(query.where.id.in.length).toBeLessThanOrEqual(200);
      }
      expect([...result.keys()]).toEqual(ids);
      expect(result.size).toBe(205);
      expect(result.get(ids[204])).toEqual({
        vipLevel: 0,
        avatarFrame: null,
      });
    });

    it('loads only grants for selected user/frame pairs outside the user relation', async () => {
      const selectedByGrant = 'user-selected-grant';
      const unrelatedOnly = 'user-unrelated-grant';
      const unrelatedGrants = Array.from({ length: 500 }, (_, index) => ({
        id: `unrelated-${index}`,
        userID: selectedByGrant,
        frameID: superId,
        expiresAt: null,
        revokedAt: null,
      }));
      prisma.user.findMany.mockResolvedValue([
        {
          ...user({
            id: selectedByGrant,
            selectedAvatarFrameID: diamondId,
          }),
          selectedAvatarFrame: asset(diamondId, null),
        },
        {
          ...user({
            id: unrelatedOnly,
            selectedAvatarFrameID: superId,
          }),
          selectedAvatarFrame: asset(superId, null),
        },
      ]);
      prisma.userAvatarFrameGrant.findMany.mockResolvedValue([
        {
          id: 'selected-pair',
          userID: selectedByGrant,
          frameID: diamondId,
          expiresAt: null,
          revokedAt: null,
        },
        {
          id: 'other-user-pair',
          userID: 'different-user',
          frameID: diamondId,
          expiresAt: null,
          revokedAt: null,
        },
        ...unrelatedGrants,
      ]);

      const result = await service.resolvePublicAppearances(
        [selectedByGrant, unrelatedOnly],
        now,
      );

      const userQuery = prisma.user.findMany.mock.calls[0][0];
      expect(userQuery.select.avatarFrameGrants).toBeUndefined();
      expect(prisma.userAvatarFrameGrant.findMany).toHaveBeenCalledWith({
        where: {
          revokedAt: null,
          AND: [
            {
              OR: [
                { userID: selectedByGrant, frameID: diamondId },
                { userID: unrelatedOnly, frameID: superId },
              ],
            },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          ],
        },
        select: {
          id: true,
          userID: true,
          frameID: true,
          expiresAt: true,
          revokedAt: true,
        },
      });
      expect(result.get(selectedByGrant)?.avatarFrame).toMatchObject({
        id: diamondId,
      });
      expect(result.get(unrelatedOnly)?.avatarFrame).toBeNull();
    });
  });

  it('cumulatively unlocks all active membership frames at or below the effective level', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({
        vipLevel: 4,
        selectedAvatarFrameID: superId,
      }),
    );
    prisma.avatarFrameAsset.findMany.mockResolvedValue([
      asset(diamondId, 3),
      asset(superId, 4),
    ]);

    await expect(service.getInventory(userId, now)).resolves.toEqual({
      equippedFrameId: superId,
      items: [
        expect.objectContaining({
          id: diamondId,
          ownedSources: [
            {
              type: 'MEMBERSHIP',
              minimumVipLevel: 3,
              expiresAt: null,
            },
          ],
          availableUntil: null,
          equipped: false,
        }),
        expect.objectContaining({
          id: superId,
          ownedSources: [
            {
              type: 'MEMBERSHIP',
              minimumVipLevel: 4,
              expiresAt: null,
            },
          ],
          availableUntil: null,
          equipped: true,
        }),
      ],
    });
  });

  it('uses existing membership expiry semantics and omits expired membership sources', async () => {
    const expiredAt = new Date('2027-07-29T11:59:59.999Z');
    prisma.user.findUnique.mockResolvedValue(
      user({ vipLevel: 3, vipExpiresAt: expiredAt }),
    );
    prisma.avatarFrameAsset.findMany.mockResolvedValue([]);

    const result = await service.getInventory(userId, now);

    expect(result).toEqual({ equippedFrameId: null, items: [] });
    expect(prisma.avatarFrameAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  it('treats super membership as lifetime even if a stale expiry remains stored', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({
        vipLevel: 4,
        vipExpiresAt: new Date('2027-07-29T11:59:59.999Z'),
      }),
    );
    prisma.avatarFrameAsset.findMany.mockResolvedValue([asset(superId, 4)]);

    const result = await service.getInventory(userId, now);

    expect(result.items[0]).toMatchObject({
      ownedSources: [
        {
          type: 'MEMBERSHIP',
          minimumVipLevel: 4,
          expiresAt: null,
        },
      ],
      availableUntil: null,
    });
  });

  it('merges finite and permanent active admin grants for one frame', async () => {
    prisma.avatarFrameAsset.findMany.mockResolvedValue([
      asset(diamondId, 3, {
        grants: [
          {
            id: 'grant-finite',
            expiresAt: new Date('2027-08-01T00:00:00.000Z'),
          },
          { id: 'grant-permanent', expiresAt: null },
        ],
      }),
    ]);

    const result = await service.getInventory(userId, now);

    expect(result.items[0]).toMatchObject({
      ownedSources: [
        {
          type: 'ADMIN',
          grantId: 'grant-finite',
          expiresAt: new Date('2027-08-01T00:00:00.000Z'),
        },
        {
          type: 'ADMIN',
          grantId: 'grant-permanent',
          expiresAt: null,
        },
      ],
      availableUntil: null,
    });
  });

  it('uses the latest expiry when every ownership source is finite', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({
        vipLevel: 3,
        vipExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
      }),
    );
    prisma.avatarFrameAsset.findMany.mockResolvedValue([
      asset(diamondId, 3, {
        grants: [
          {
            id: 'grant-later',
            expiresAt: new Date('2027-09-01T00:00:00.000Z'),
          },
        ],
      }),
    ]);

    const result = await service.getInventory(userId, now);

    expect(result.items[0].availableUntil).toEqual(
      new Date('2027-09-01T00:00:00.000Z'),
    );
  });

  it('never reactivates an expired stored selection when entitlement later exists again', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({
        vipLevel: 4,
        selectedAvatarFrameID: superId,
        selectedAvatarFrameExpiresAt: new Date('2027-07-29T11:59:59.999Z'),
      }),
    );
    prisma.avatarFrameAsset.findMany.mockResolvedValue([asset(superId, 4)]);

    const result = await service.getInventory(userId, now);

    expect(result.equippedFrameId).toBeNull();
    expect(result.items[0].equipped).toBe(false);
  });

  it('does not return inactive assets even if a data adapter returns one', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ vipLevel: 4 }));
    prisma.avatarFrameAsset.findMany.mockResolvedValue([
      asset(superId, 4, { isActive: false }),
    ]);

    await expect(service.getInventory(userId, now)).resolves.toEqual({
      equippedFrameId: null,
      items: [],
    });
  });

  it('resolves inventory without per-asset or per-grant queries', async () => {
    prisma.user.findUnique.mockResolvedValue(user({ vipLevel: 4 }));
    prisma.avatarFrameAsset.findMany.mockResolvedValue([
      asset(diamondId, 3),
      asset(superId, 4),
    ]);

    await service.getInventory(userId, now);

    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.avatarFrameAsset.findMany).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing frame with a stable not-found code', async () => {
    prisma.avatarFrameAsset.findUnique.mockResolvedValue(null);

    await expect(
      service.setEquipped(userId, diamondId, now),
    ).rejects.toMatchObject({
      constructor: NotFoundException,
      response: { errorCode: AvatarFrameErrorCode.AssetNotFound },
    });
  });

  it('rejects an inactive frame with a stable conflict code', async () => {
    prisma.avatarFrameAsset.findUnique.mockResolvedValue(
      asset(diamondId, 3, { isActive: false }),
    );

    await expect(
      service.setEquipped(userId, diamondId, now),
    ).rejects.toMatchObject({
      constructor: ConflictException,
      response: { errorCode: AvatarFrameErrorCode.AssetInactive },
    });
  });

  it('rejects an active but unowned frame with a stable forbidden code', async () => {
    prisma.avatarFrameAsset.findUnique.mockResolvedValue(asset(diamondId, 3));

    await expect(
      service.setEquipped(userId, diamondId, now),
    ).rejects.toMatchObject({
      constructor: ForbiddenException,
      response: { errorCode: AvatarFrameErrorCode.NotOwned },
    });
  });

  it('equips an owned frame with its aggregate current entitlement horizon', async () => {
    const later = new Date('2027-09-01T00:00:00.000Z');
    prisma.user.findUnique
      .mockResolvedValueOnce(
        user({
          vipLevel: 3,
          vipExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
        }),
      )
      .mockResolvedValueOnce(
        user({
          vipLevel: 3,
          vipExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
          selectedAvatarFrameID: diamondId,
          selectedAvatarFrameExpiresAt: later,
        }),
      );
    prisma.avatarFrameAsset.findUnique.mockResolvedValue(
      asset(diamondId, 3, {
        grants: [{ id: 'grant-later', expiresAt: later }],
      }),
    );
    prisma.avatarFrameAsset.findMany.mockResolvedValue([
      asset(diamondId, 3, {
        grants: [{ id: 'grant-later', expiresAt: later }],
      }),
    ]);

    const result = await service.setEquipped(userId, diamondId, now);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: {
        selectedAvatarFrameID: diamondId,
        selectedAvatarFrameExpiresAt: later,
      },
    });
    expect(result.equippedFrameId).toBe(diamondId);
  });

  it('clears both stored selection fields and publishes a profile refresh', async () => {
    prisma.user.findUnique.mockResolvedValue(
      user({ selectedAvatarFrameID: diamondId }),
    );

    const result = await service.setEquipped(userId, null, now);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: {
        selectedAvatarFrameID: null,
        selectedAvatarFrameExpiresAt: null,
      },
    });
    expect(realtime.invalidateUserHotCache).toHaveBeenCalledWith(userId);
    expect(realtime.broadcastUserProfileSummary).toHaveBeenCalledWith(userId);
    expect(result).toEqual({ equippedFrameId: null, items: [] });
  });

  it('retries a soft cache-invalidation failure before broadcasting', async () => {
    realtime.invalidateUserHotCache
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      service.publishAppearanceChanged(userId),
    ).resolves.toBeUndefined();

    expect(realtime.invalidateUserHotCache).toHaveBeenCalledTimes(2);
    expect(realtime.broadcastUserProfileSummary).toHaveBeenCalledWith(userId);
  });

  it('still broadcasts when cache invalidation throws after commit', async () => {
    realtime.invalidateUserHotCache.mockRejectedValue(
      new Error('redis unavailable'),
    );

    await expect(
      service.publishAppearanceChanged(userId),
    ).resolves.toBeUndefined();

    expect(realtime.broadcastUserProfileSummary).toHaveBeenCalledWith(userId);
  });

  it('does not fail the committed selection when profile broadcast throws', async () => {
    realtime.broadcastUserProfileSummary.mockRejectedValue(
      new Error('realtime unavailable'),
    );

    await expect(
      service.publishAppearanceChanged(userId),
    ).resolves.toBeUndefined();
  });

  it('extends an effective selection deadline during a membership upgrade', async () => {
    const oldExpiry = new Date('2027-08-01T00:00:00.000Z');
    const newExpiry = new Date('2028-08-01T00:00:00.000Z');
    const tx = { user: { update: jest.fn() } };
    const state = {
      ...user({
        vipLevel: 3,
        vipExpiresAt: oldExpiry,
        selectedAvatarFrameID: diamondId,
        selectedAvatarFrameExpiresAt: oldExpiry,
      }),
      selectedAvatarFrame: asset(diamondId, 3),
      avatarFrameGrants: [],
    };

    await service.extendSelectionContinuityForMembershipChange(
      tx as never,
      state,
      { vipLevel: 3, vipExpiresAt: newExpiry },
      now,
    );

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { selectedAvatarFrameExpiresAt: newExpiry },
    });
  });

  it('does not revive an already expired selection during a membership upgrade', async () => {
    const tx = { user: { update: jest.fn() } };
    const state = {
      ...user({
        vipLevel: 3,
        vipExpiresAt: new Date('2027-07-29T11:59:59.999Z'),
        selectedAvatarFrameID: diamondId,
        selectedAvatarFrameExpiresAt: new Date('2027-07-29T11:59:59.999Z'),
      }),
      selectedAvatarFrame: asset(diamondId, 3),
      avatarFrameGrants: [],
    };

    await service.extendSelectionContinuityForMembershipChange(
      tx as never,
      state,
      { vipLevel: 4, vipExpiresAt: null },
      now,
    );

    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('recomputes a selected frame to the remaining source after source removal', async () => {
    const remainingExpiry = new Date('2027-08-15T00:00:00.000Z');
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          ...user({
            selectedAvatarFrameID: diamondId,
            selectedAvatarFrameExpiresAt: null,
          }),
          selectedAvatarFrame: asset(diamondId, null),
          avatarFrameGrants: [
            {
              id: 'grant-remaining',
              frameID: diamondId,
              expiresAt: remainingExpiry,
              revokedAt: null,
            },
          ],
        }),
        update: jest.fn(),
      },
    };

    await service.recomputeSelectionContinuityInTransaction(
      tx as never,
      userId,
      now,
    );

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: { selectedAvatarFrameExpiresAt: remainingExpiry },
    });
  });

  it('clears the stored selection when recomputation finds no active source', async () => {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          ...user({ selectedAvatarFrameID: diamondId }),
          selectedAvatarFrame: asset(diamondId, null),
          avatarFrameGrants: [],
        }),
        update: jest.fn(),
      },
    };

    await service.recomputeSelectionContinuityInTransaction(
      tx as never,
      userId,
      now,
    );

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: userId },
      data: {
        selectedAvatarFrameID: null,
        selectedAvatarFrameExpiresAt: null,
      },
    });
  });
});

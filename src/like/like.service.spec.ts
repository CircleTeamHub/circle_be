import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LikeService } from './like.service';

describe('LikeService', () => {
  const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    userLike: {
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  };
  const iconService = { invalidateDisplayIconCacheFor: jest.fn() };

  const service = new LikeService(prisma as any, iconService as any);

  // tx is prisma itself, so tx.* delegates to the same mocks.
  const runTx = async (cb: (tx: typeof prisma) => unknown) => cb(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(runTx as any);
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.user.update.mockResolvedValue({});
    prisma.userLike.create.mockResolvedValue({});
  });

  describe('like', () => {
    it('rejects liking yourself before any DB work', async () => {
      await expect(service.like('u1', 'u1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFound when the target does not exist', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      await expect(service.like('u1', 'ghost')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFound when the target is not ACTIVE (banned/deleted)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ status: 'BANNED' });
      await expect(service.like('u1', 'banned')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.userLike.create).not.toHaveBeenCalled();
    });

    it('creates the like, increments the counter, and invalidates the badge cache', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ status: 'ACTIVE' }) // target check
        .mockResolvedValueOnce({ receivedLikeCount: 1 }); // getStatus
      prisma.userLike.findUnique
        .mockResolvedValueOnce(null) // not liked yet today
        .mockResolvedValueOnce({ id: 'like-1' }); // getStatus: liked now
      prisma.userLike.count.mockResolvedValue(0);

      const result = await service.like('u1', 'u2');

      expect(prisma.userLike.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ fromUserID: 'u1', toUserID: 'u2' }),
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'u2' },
        data: { receivedLikeCount: { increment: 1 } },
      });
      expect(iconService.invalidateDisplayIconCacheFor).toHaveBeenCalledWith(
        'u2',
      );
      expect(result).toEqual({ likeCount: 1, likedByMeToday: true });
    });

    it('is idempotent when already liked today (no quota spent, no tx)', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ status: 'ACTIVE' })
        .mockResolvedValueOnce({ receivedLikeCount: 7 });
      prisma.userLike.findUnique
        .mockResolvedValueOnce({ id: 'existing' }) // already liked today
        .mockResolvedValueOnce({ id: 'existing' }); // getStatus

      const result = await service.like('u1', 'u2');

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.userLike.create).not.toHaveBeenCalled();
      expect(result).toEqual({ likeCount: 7, likedByMeToday: true });
    });

    it('enforces the daily quota atomically (rolls back, no counter bump)', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ status: 'ACTIVE' });
      prisma.userLike.findUnique.mockResolvedValueOnce(null);
      prisma.userLike.count.mockResolvedValue(5); // at the limit

      await expect(service.like('u1', 'u2')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.userLike.create).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(iconService.invalidateDisplayIconCacheFor).not.toHaveBeenCalled();
    });

    it('treats a concurrent same-target unique conflict (P2002) as idempotent', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce({ status: 'ACTIVE' })
        .mockResolvedValueOnce({ receivedLikeCount: 1 });
      prisma.userLike.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'like-1' });
      prisma.userLike.count.mockResolvedValue(0);
      prisma.userLike.create.mockRejectedValueOnce({ code: 'P2002' });

      const result = await service.like('u1', 'u2');

      expect(result).toEqual({ likeCount: 1, likedByMeToday: true });
    });
  });

  describe('unlike', () => {
    it('deletes the like and decrements the counter atomically (floored at 0)', async () => {
      prisma.userLike.deleteMany.mockResolvedValue({ count: 1 });
      prisma.user.findUnique.mockResolvedValueOnce({ receivedLikeCount: 0 });
      prisma.userLike.findUnique.mockResolvedValueOnce(null);

      const result = await service.unlike('u1', 'u2');

      expect(prisma.userLike.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ fromUserID: 'u1', toUserID: 'u2' }),
      });
      expect(prisma.$executeRaw).toHaveBeenCalled(); // GREATEST(...-1, 0)
      expect(iconService.invalidateDisplayIconCacheFor).toHaveBeenCalledWith(
        'u2',
      );
      expect(result).toEqual({ likeCount: 0, likedByMeToday: false });
    });

    it('does not decrement or invalidate when nothing was removed', async () => {
      prisma.userLike.deleteMany.mockResolvedValue({ count: 0 });
      prisma.user.findUnique.mockResolvedValueOnce({ receivedLikeCount: 3 });
      prisma.userLike.findUnique.mockResolvedValueOnce(null);

      const result = await service.unlike('u1', 'u2');

      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(iconService.invalidateDisplayIconCacheFor).not.toHaveBeenCalled();
      expect(result).toEqual({ likeCount: 3, likedByMeToday: false });
    });
  });

  describe('getStatus', () => {
    it('never reports likedByMeToday for a self-view and skips the like lookup', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({ receivedLikeCount: 9 });

      const result = await service.getStatus('me', 'me');

      expect(prisma.userLike.findUnique).not.toHaveBeenCalled();
      expect(result).toEqual({ likeCount: 9, likedByMeToday: false });
    });
  });
});

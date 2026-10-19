import { AdminImService } from './admin-im.service';

describe('admin message display expiry', () => {
  const now = new Date('2026-10-19T00:00:00Z');
  const expiry = new Date(now.getTime() + 60_000);
  let prisma: any;
  let service: AdminImService;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now.getTime());
    prisma = {
      $queryRaw: jest.fn(),
      user: {
        findUnique: jest.fn().mockResolvedValue({
          role: 'ADMIN',
          status: 'ACTIVE',
          adminAccess: { role: 'SUPER_ADMIN' },
        }),
      },
      chatConversation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'c1',
          type: 'DIRECT',
          clearedBeforeHeight: 0,
          burnDurationSec: 3600,
          burnStartedAt: null,
        }),
      },
      chatMessage: { findMany: jest.fn() },
      chatBurnArchive: { findMany: jest.fn() },
      adminAuditLog: { create: jest.fn() },
    };
    prisma.$transaction = async (fn: any) => fn(prisma);
    service = new AdminImService(prisma, {} as never, {} as never, {} as never);
  });
  afterEach(() => jest.useRealTimers());
  const row = (overrides = {}) => ({
    id: 'm1',
    height: 1,
    senderID: 'u1',
    type: 'text',
    content: { text: 'secret' },
    createdAt: now,
    burnDurationSec: 60,
    burnExpiresAt: expiry,
    ...overrides,
  });
  it('uses message expiry rather than the retired conversation window', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([row()]);
    const result = await service.messages('admin', 'c1', {
      reason: 'test access',
      limit: 30,
    });
    expect(result.items[0].visibleUntil).toBe(expiry.toISOString());
  });
  it('does not release already expired content even if returned by the database', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([
      row({ burnExpiresAt: now }),
    ]);
    expect(
      (
        await service.messages('admin', 'c1', {
          reason: 'test access',
          limit: 30,
        })
      ).items,
    ).toEqual([]);
  });
  it('bounds display of unread messages to one burn window from the locked snapshot', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([
      row({ burnExpiresAt: null, createdAt: new Date(0) }),
    ]);
    expect(
      (
        await service.messages('admin', 'c1', {
          reason: 'test access',
          limit: 30,
        })
      ).items[0].visibleUntil,
    ).toBe(expiry.toISOString());
  });
  it('keeps ordinary messages without expiry despite a legacy conversation setting', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([
      row({ burnExpiresAt: null, burnDurationSec: null }),
    ]);
    expect(
      (
        await service.messages('admin', 'c1', {
          reason: 'test access',
          limit: 30,
        })
      ).items[0].visibleUntil,
    ).toBeNull();
  });
  it('requires the separate archive permission even for an active admin', async () => {
    prisma.user.findUnique.mockResolvedValue({
      role: 'ADMIN',
      status: 'ACTIVE',
      adminAccess: { role: 'SUPPORT' },
    });
    await expect(
      service.messages('admin', 'c1', { reason: 'review', limit: 30 }, true),
    ).rejects.toThrow('无权限');
    expect(prisma.chatBurnArchive.findMany).not.toHaveBeenCalled();
  });
  it('audits retained content and uses its 180-day deadline, ignoring user clear floors', async () => {
    const retainUntil = new Date(now.getTime() + 180 * 86400_000);
    prisma.chatBurnArchive.findMany.mockResolvedValue([
      { ...row({ burnExpiresAt: now }), retainUntil },
    ]);
    const result = await service.messages(
      'admin',
      'c1',
      { reason: 'review', limit: 30 },
      true,
    );
    expect(result.items[0].content).toEqual({ text: 'secret' });
    expect(result.items[0].visibleUntil).toBe(retainUntil.toISOString());
    expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'IM_BURN_ARCHIVE_READ' }),
      }),
    );
    expect(prisma.chatBurnArchive.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationID: 'c1', retainUntil: { gt: expect.any(Date) } },
      }),
    );
  });
  it('does not release archival content if the audit write fails', async () => {
    prisma.chatBurnArchive.findMany.mockResolvedValue([
      { ...row(), retainUntil: expiry },
    ]);
    prisma.adminAuditLog.create.mockRejectedValue(
      new Error('audit unavailable'),
    );
    await expect(
      service.messages('admin', 'c1', { reason: 'review', limit: 30 }, true),
    ).rejects.toThrow('audit unavailable');
  });
});

import { TempChatStatus } from 'src/generated/prisma';
import { TempChatCleanup } from './temp-chat.cleanup';

describe('TempChatCleanup', () => {
  const prisma = { tempChat: { findMany: jest.fn() } };
  const service = { teardown: jest.fn() };
  const job = new TempChatCleanup(prisma as any, service as any);

  beforeEach(() => jest.clearAllMocks());

  it('tears down every ACTIVE expired room', async () => {
    prisma.tempChat.findMany.mockResolvedValue([
      { id: 'a', groupId: 'tmpA' },
      { id: 'b', groupId: 'tmpB' },
    ]);
    await job.sweep();
    expect(prisma.tempChat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
      }),
    );
    expect(service.teardown).toHaveBeenCalledTimes(2);
    expect(service.teardown).toHaveBeenCalledWith(
      { id: 'a', groupId: 'tmpA' },
      TempChatStatus.EXPIRED,
    );
  });

  it('one failing room does not block the others', async () => {
    prisma.tempChat.findMany.mockResolvedValue([
      { id: 'a', groupId: 'tmpA' },
      { id: 'b', groupId: 'tmpB' },
    ]);
    service.teardown.mockRejectedValueOnce(new Error('boom'));
    await job.sweep();
    expect(service.teardown).toHaveBeenCalledTimes(2);
  });

  // 房间上限是按主机算的、TTL 又普遍相同,一次大批量到期会把无界 findMany
  // 变成一次超长 sweep。分批 + 按 expiresAt 升序:最老的房间一定先被清掉,
  // 不会出现「每轮都在处理同一批、排在后面的永远轮不到」。
  it('claims bounded, oldest-first batches instead of loading every due room', async () => {
    prisma.tempChat.findMany.mockResolvedValue([]);
    await job.sweep();
    expect(prisma.tempChat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { expiresAt: 'asc' },
        take: expect.any(Number),
      }),
    );
    const [[args]] = prisma.tempChat.findMany.mock.calls as [
      [{ take: number }],
    ];
    expect(args.take).toBeGreaterThan(0);
  });

  it('keeps draining while batches come back full', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`,
      groupId: `tmp${i}`,
    }));
    prisma.tempChat.findMany
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: 'last', groupId: 'tmpLast' }]);

    await job.sweep();

    expect(prisma.tempChat.findMany).toHaveBeenCalledTimes(2);
    expect(service.teardown).toHaveBeenCalledTimes(201);
  });

  // @Cron 到点就调,不等上一次返回。没有重入闸的话,一次跑超过一分钟的 sweep
  // 会被下一次叠上来,两轮各做一遍全表扫描、互相抢同一批房间的租约。
  it('does not start a second sweep while one is still running', async () => {
    let release!: () => void;
    prisma.tempChat.findMany.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );

    const first = job.sweep();
    await job.sweep(); // 重入:必须直接返回,不发起任何查询
    expect(prisma.tempChat.findMany).toHaveBeenCalledTimes(1);

    release();
    await first;
  });
});

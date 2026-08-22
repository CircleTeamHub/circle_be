import { ConflictException, NotFoundException } from '@nestjs/common';
import { QrLoginService } from '../qr-login.service';
import type { AuthService } from '../auth.service';
import type { PrismaService } from 'src/prisma/prisma.service';

describe('QrLoginService', () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 1_000);

  function build(overrides?: {
    session?: Record<string, unknown> | null;
    consumeCount?: number;
    approveCount?: number;
    issueError?: Error;
  }) {
    const prisma = {
      qrLoginSession: {
        create: jest.fn().mockResolvedValue({
          qrToken: 'q'.repeat(32),
          pollKey: 'p'.repeat(32),
          requestDevice: 'Chrome · macOS',
          expiresAt: future,
        }),
        findUnique: jest.fn().mockResolvedValue(overrides?.session ?? null),
        updateMany: jest.fn().mockImplementation(({ data }) =>
          Promise.resolve({
            count:
              data.status === 'CONSUMED'
                ? (overrides?.consumeCount ?? 1)
                : (overrides?.approveCount ?? 1),
          }),
        ),
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
    } as unknown as PrismaService;
    const authService = {
      assertQrLoginEligible: jest.fn().mockResolvedValue(undefined),
      issueQrLoginTokens: overrides?.issueError
        ? jest.fn().mockRejectedValue(overrides.issueError)
        : jest.fn().mockResolvedValue({
            accessToken: 'at',
            refreshToken: 'rt',
          }),
    } as unknown as AuthService;
    return {
      service: new QrLoginService(prisma, authService),
      prisma,
      authService,
    };
  }

  const pendingSession = {
    id: 'sid',
    qrToken: 'q'.repeat(32),
    pollKey: 'p'.repeat(32),
    status: 'PENDING',
    approvedByID: null,
    expiresAt: future,
  };

  it('create 返回双令牌、设备上下文、确认码与过期时间', async () => {
    const { service } = build();
    const result = await service.create({
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Safari/537.36',
    });
    expect(result.qrToken).toHaveLength(32);
    expect(result.pollKey).toHaveLength(32);
    expect(result.requestDevice).toBe('Chrome · macOS');
    expect(result.verificationCode).toMatch(/^\d{6}$/);
    expect(typeof result.expiresAt).toBe('string');
  });

  it('approve：PENDING 会话置 APPROVED 并记录确认人', async () => {
    const { service, prisma, authService } = build({ session: pendingSession });
    await expect(
      service.approve('user-1', pendingSession.qrToken),
    ).resolves.toEqual({ ok: true });
    expect(authService.assertQrLoginEligible).toHaveBeenCalledWith('user-1');
    expect(prisma.qrLoginSession.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'sid', status: 'PENDING' }),
      data: { status: 'APPROVED', approvedByID: 'user-1' },
    });
    // 确认谓词也必须自带 expiresAt:查过之后还隔着一次 assertQrLoginEligible
    // 查库,掐着点确认会写出「已 APPROVED 但已过期」的行,轮询侧照样拒 ——
    // 用户看到的是「手机说确认成功、网页一直不动」。
    const approveCall = (
      prisma.qrLoginSession.updateMany as jest.Mock
    ).mock.calls.find(([arg]) => arg.data.status === 'APPROVED');
    expect(approveCall?.[0].where.expiresAt).toEqual({ gt: expect.any(Date) });
  });

  it('approve：不存在 / 非 PENDING → NotFound', async () => {
    const { service } = build({ session: null });
    await expect(service.approve('user-1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('approve：已过期 → NotFound；并发抢占失败 → Conflict', async () => {
    const expired = { ...pendingSession, expiresAt: past };
    await expect(
      build({ session: expired }).service.approve('u', expired.qrToken),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      build({ session: pendingSession, approveCount: 0 }).service.approve(
        'u',
        pendingSession.qrToken,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('status：pollKey 不对与不存在一样只回 EXPIRED（无探测面）', async () => {
    const { service } = build({ session: pendingSession });
    await expect(
      service.status(pendingSession.qrToken, 'wrong-key'),
    ).resolves.toEqual({ status: 'EXPIRED' });
  });

  it('status：PENDING 未过期回 PENDING，过期回 EXPIRED', async () => {
    await expect(
      build({ session: pendingSession }).service.status(
        pendingSession.qrToken,
        pendingSession.pollKey,
      ),
    ).resolves.toEqual({ status: 'PENDING' });

    await expect(
      build({ session: { ...pendingSession, expiresAt: past } }).service.status(
        pendingSession.qrToken,
        pendingSession.pollKey,
      ),
    ).resolves.toEqual({ status: 'EXPIRED' });
  });

  it('status：APPROVED 首次轮询原子消费并换发会话', async () => {
    const approved = {
      ...pendingSession,
      status: 'APPROVED',
      approvedByID: 'user-9',
    };
    const { service, prisma, authService } = build({ session: approved });
    const result = await service.status(approved.qrToken, approved.pollKey, {
      ip: '1.2.3.4',
    } as never);
    expect(result).toEqual({
      status: 'APPROVED',
      tokens: { accessToken: 'at', refreshToken: 'rt' },
    });
    expect(prisma.qrLoginSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'sid', status: 'APPROVED' }),
      }),
    );
    // 消费谓词必须自带 expiresAt，否则检查与更新之间跨过期限就漏进去了。
    const consumeCall = (
      prisma.qrLoginSession.updateMany as jest.Mock
    ).mock.calls.find(([arg]) => arg.data.status === 'CONSUMED');
    expect(consumeCall?.[0].where.expiresAt).toEqual({ gt: expect.any(Date) });
    expect(authService.issueQrLoginTokens).toHaveBeenCalledWith('user-9', {
      ip: '1.2.3.4',
    });
  });

  it('status：消费位被抢（并发双轮询）或已 CONSUMED → EXPIRED', async () => {
    const approved = {
      ...pendingSession,
      status: 'APPROVED',
      approvedByID: 'user-9',
    };
    await expect(
      build({ session: approved, consumeCount: 0 }).service.status(
        approved.qrToken,
        approved.pollKey,
      ),
    ).resolves.toEqual({ status: 'EXPIRED' });

    await expect(
      build({
        session: { ...pendingSession, status: 'CONSUMED' },
      }).service.status(pendingSession.qrToken, pendingSession.pollKey),
    ).resolves.toEqual({ status: 'EXPIRED' });
  });

  it('status：APPROVED 但已过期 → EXPIRED，不换发会话', async () => {
    // approve 卡在到期前一秒的情形：过期是终局，不因为状态变成 APPROVED
    // 就把有效期无限延长。
    const staleApproved = {
      ...pendingSession,
      status: 'APPROVED',
      approvedByID: 'user-9',
      expiresAt: past,
    };
    const { service, prisma, authService } = build({ session: staleApproved });
    await expect(
      service.status(staleApproved.qrToken, staleApproved.pollKey),
    ).resolves.toEqual({ status: 'EXPIRED' });
    expect(authService.issueQrLoginTokens).not.toHaveBeenCalled();
    expect(prisma.qrLoginSession.updateMany).not.toHaveBeenCalled();
  });

  it('status：换发令牌失败时把消费位放回去，原始错误照抛', async () => {
    const approved = {
      ...pendingSession,
      status: 'APPROVED',
      approvedByID: 'user-9',
    };
    const boom = new Error('db down');
    const { service, prisma } = build({ session: approved, issueError: boom });

    await expect(
      service.status(approved.qrToken, approved.pollKey),
    ).rejects.toBe(boom);

    // 不回滚的话，一次瞬时故障就把会话钉死在 CONSUMED，之后每次轮询都 EXPIRED。
    expect(prisma.qrLoginSession.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'sid', status: 'CONSUMED' },
      data: { status: 'APPROVED', consumedAt: null },
    });
  });

  it('purgeExpired：按保留期删旧行，活跃会话不受影响', async () => {
    const { service, prisma } = build();
    const now = new Date('2026-08-22T12:00:00.000Z');
    await service.purgeExpired(now);
    const where = (prisma.qrLoginSession.deleteMany as jest.Mock).mock
      .calls[0][0].where;
    // 保留期 1 小时：删的是「过期超过一小时」的行，刚过期的留着。
    expect(where.expiresAt.lt).toEqual(new Date('2026-08-22T11:00:00.000Z'));
  });
});

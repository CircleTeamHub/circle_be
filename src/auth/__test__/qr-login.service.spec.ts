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
  }) {
    const prisma = {
      qrLoginSession: {
        create: jest.fn().mockResolvedValue({
          qrToken: 'q'.repeat(32),
          pollKey: 'p'.repeat(32),
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
      },
    } as unknown as PrismaService;
    const authService = {
      assertQrLoginEligible: jest.fn().mockResolvedValue(undefined),
      issueQrLoginTokens: jest.fn().mockResolvedValue({
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

  it('create 返回双令牌与过期时间', async () => {
    const { service } = build();
    const result = await service.create();
    expect(result.qrToken).toHaveLength(32);
    expect(result.pollKey).toHaveLength(32);
    expect(typeof result.expiresAt).toBe('string');
  });

  it('approve：PENDING 会话置 APPROVED 并记录确认人', async () => {
    const { service, prisma, authService } = build({ session: pendingSession });
    await expect(service.approve('user-1', pendingSession.qrToken)).resolves.toEqual(
      { ok: true },
    );
    expect(authService.assertQrLoginEligible).toHaveBeenCalledWith('user-1');
    expect(prisma.qrLoginSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'sid', status: 'PENDING' },
      data: { status: 'APPROVED', approvedByID: 'user-1' },
    });
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
    const result = await service.status(
      approved.qrToken,
      approved.pollKey,
      { ip: '1.2.3.4' } as never,
    );
    expect(result).toEqual({
      status: 'APPROVED',
      tokens: { accessToken: 'at', refreshToken: 'rt' },
    });
    expect(prisma.qrLoginSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sid', status: 'APPROVED' } }),
    );
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
});

import { Logger } from '@nestjs/common';
import { UserRole, UserStatus } from 'src/generated/prisma';
import { AdminUserErrorCode } from 'src/common/app-error-codes';
import { AdminUserService } from './admin-user.service';

describe('AdminUserService', () => {
  const prisma = {
    $transaction: jest.fn(),
    user: {
      findMany: jest.fn(),
      count: jest.fn(),
      findUnique: jest.fn(),
    },
    refreshToken: { count: jest.fn() },
    devicePushToken: { count: jest.fn() },
    friend: { count: jest.fn() },
    note: { count: jest.fn() },
    trace: { count: jest.fn() },
    circle: { count: jest.fn() },
    circleMember: { count: jest.fn() },
    friendReport: { count: jest.fn() },
    wallet: { findUnique: jest.fn() },
    sessionRevocationOutbox: { deleteMany: jest.fn() },
  };
  const audit = {
    recordInTransaction: jest.fn(),
    listForTarget: jest.fn(),
  };
  const tx = {
    user: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    refreshToken: { updateMany: jest.fn() },
    sessionRevocationOutbox: { upsert: jest.fn() },
  };
  const sessionRevocation = {
    revokeUserAt: jest.fn(),
    revocationExpiresAt: jest.fn(),
  };
  const realtime = {
    invalidateUserProfileSummaryCache: jest.fn(),
    broadcastUserProfileSummary: jest.fn(),
  };
  const service = new AdminUserService(
    prisma as never,
    audit as never,
    sessionRevocation as never,
    realtime as never,
  );

  beforeEach(() => {
    jest.resetAllMocks();
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    sessionRevocation.revokeUserAt.mockResolvedValue(true);
    sessionRevocation.revocationExpiresAt.mockImplementation(
      (revokedAtMs: number) => new Date(revokedAtMs + 60 * 60 * 1000),
    );
    prisma.sessionRevocationOutbox.deleteMany.mockResolvedValue({ count: 1 });
    realtime.invalidateUserProfileSummaryCache.mockResolvedValue(undefined);
    realtime.broadcastUserProfileSummary.mockResolvedValue(undefined);
  });

  describe('listUsers', () => {
    it('filters server-side and returns only masked contacts', async () => {
      prisma.user.findMany.mockResolvedValue([
        {
          id: 'user-1',
          accountId: 'jim-1001',
          nickname: 'Jim',
          avatarUrl: null,
          email: 'jim@example.com',
          phoneNumber: '15512345678',
          role: UserRole.USER,
          status: UserStatus.ACTIVE,
          createdAt: new Date('2026-01-02T00:00:00.000Z'),
          lastOnline: null,
        },
      ]);
      prisma.user.count.mockResolvedValue(1);

      const result = await service.listUsers({
        keyword: '  jim  ',
        status: UserStatus.ACTIVE,
        role: UserRole.USER,
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-02-01T00:00:00.000Z',
        page: 2,
        limit: 20,
      });

      const where = {
        status: UserStatus.ACTIVE,
        role: UserRole.USER,
        createdAt: {
          gte: new Date('2026-01-01T00:00:00.000Z'),
          lte: new Date('2026-02-01T00:00:00.000Z'),
        },
        OR: [
          { accountId: { contains: 'jim', mode: 'insensitive' } },
          { nickname: { contains: 'jim', mode: 'insensitive' } },
          { email: { contains: 'jim', mode: 'insensitive' } },
          { phoneNumber: { contains: 'jim' } },
        ],
      };
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where,
        select: {
          id: true,
          accountId: true,
          nickname: true,
          avatarUrl: true,
          email: true,
          phoneNumber: true,
          role: true,
          status: true,
          createdAt: true,
          lastOnline: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: 20,
        take: 20,
      });
      expect(prisma.user.count).toHaveBeenCalledWith({ where });
      expect(result).toEqual({
        items: [
          {
            id: 'user-1',
            accountId: 'jim-1001',
            nickname: 'Jim',
            avatarUrl: null,
            role: UserRole.USER,
            status: UserStatus.ACTIVE,
            createdAt: new Date('2026-01-02T00:00:00.000Z'),
            lastOnline: null,
            maskedEmail: 'j***@example.com',
            maskedPhoneNumber: '*******5678',
          },
        ],
        total: 1,
        page: 2,
        limit: 20,
      });
      expect(JSON.stringify(result)).not.toContain('jim@example.com');
      expect(JSON.stringify(result)).not.toContain('15512345678');
    });

    it('omits empty keyword and optional filters', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.listUsers({ keyword: '   ', page: 1, limit: 20 });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
      expect(prisma.user.count).toHaveBeenCalledWith({ where: {} });
    });
  });

  describe('getUserDetail', () => {
    it('aggregates a safe 360-degree user view without legacy VIP data', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        nickname: 'Jim',
        avatarUrl: null,
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        city: 'Shanghai',
        region: 'CN',
        gender: 'unset',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-02-01T00:00:00.000Z'),
        lastOnline: null,
        email: 'jim@example.com',
        phoneNumber: '15512345678',
        wechat: 'jimmy',
        qq: '12345',
        whatsup: null,
        securityCodeLockedUntil: new Date('2099-01-01T00:00:00.000Z'),
        singleDeviceLoginEnabled: true,
        openimSynced: true,
        creditScore: 88,
      });
      prisma.refreshToken.count.mockResolvedValue(2);
      prisma.devicePushToken.count.mockResolvedValue(3);
      prisma.friend.count.mockResolvedValue(4);
      prisma.note.count.mockResolvedValue(5);
      prisma.trace.count.mockResolvedValue(6);
      prisma.circle.count.mockResolvedValue(7);
      prisma.circleMember.count.mockResolvedValue(8);
      prisma.friendReport.count
        .mockResolvedValueOnce(9)
        .mockResolvedValueOnce(10);
      prisma.wallet.findUnique.mockResolvedValue({ balance: 120 });

      const result = await service.getUserDetail('user-1');

      expect(prisma.refreshToken.count).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          revokedAt: null,
          expiredAt: { gt: expect.any(Date) },
        },
      });
      expect(prisma.devicePushToken.count).toHaveBeenCalledWith({
        where: { userID: 'user-1', disabledAt: null },
      });
      expect(prisma.friend.count).toHaveBeenCalledWith({
        where: {
          state: 'ACCEPTED',
          OR: [{ userID: 'user-1' }, { friendID: 'user-1' }],
        },
      });
      expect(prisma.note.count).toHaveBeenCalledWith({
        where: { ownerID: 'user-1', status: 'ACTIVE' },
      });
      expect(prisma.trace.count).toHaveBeenCalledWith({
        where: { fromID: 'user-1', deleted: false },
      });
      expect(prisma.circle.count).toHaveBeenCalledWith({
        where: { ownerID: 'user-1', deleted: false },
      });
      expect(prisma.circleMember.count).toHaveBeenCalledWith({
        where: { userID: 'user-1', status: 'ACTIVE' },
      });
      expect(prisma.friendReport.count).toHaveBeenNthCalledWith(1, {
        where: { reporterID: 'user-1' },
      });
      expect(prisma.friendReport.count).toHaveBeenNthCalledWith(2, {
        where: { targetID: 'user-1' },
      });
      expect(result).toEqual({
        profile: {
          id: 'user-1',
          accountId: 'jim-1001',
          nickname: 'Jim',
          avatarUrl: null,
          role: UserRole.USER,
          status: UserStatus.ACTIVE,
          city: 'Shanghai',
          region: 'CN',
          gender: 'unset',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          updatedAt: new Date('2026-02-01T00:00:00.000Z'),
          lastOnline: null,
        },
        maskedContacts: {
          email: 'j***@example.com',
          phoneNumber: '*******5678',
          wechat: 'j***y',
          qq: '1***5',
          whatsup: null,
        },
        security: {
          securityCodeLocked: true,
          singleDeviceLoginEnabled: true,
          activeSessionCount: 2,
          activePushDeviceCount: 3,
          openimSynced: true,
        },
        summary: {
          creditScore: 88,
          walletBalance: 120,
          friendCount: 4,
          noteCount: 5,
          traceCount: 6,
          circlesOwnedCount: 7,
          circleMembershipCount: 8,
          reportsFiledCount: 9,
          reportsReceivedCount: 10,
        },
      });
      expect(JSON.stringify(result)).not.toContain('jim@example.com');
      expect(result).not.toHaveProperty('vipLevel');
    });

    it('uses zero wallet balance when the user has no wallet', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        nickname: 'Jim',
        avatarUrl: null,
        role: UserRole.USER,
        status: UserStatus.ACTIVE,
        city: null,
        region: null,
        gender: 'unset',
        createdAt: new Date(),
        updatedAt: new Date(),
        lastOnline: null,
        email: null,
        phoneNumber: null,
        wechat: null,
        qq: null,
        whatsup: null,
        securityCodeLockedUntil: null,
        singleDeviceLoginEnabled: false,
        openimSynced: false,
        creditScore: 100,
      });
      prisma.refreshToken.count.mockResolvedValue(0);
      prisma.devicePushToken.count.mockResolvedValue(0);
      prisma.friend.count.mockResolvedValue(0);
      prisma.note.count.mockResolvedValue(0);
      prisma.trace.count.mockResolvedValue(0);
      prisma.circle.count.mockResolvedValue(0);
      prisma.circleMember.count.mockResolvedValue(0);
      prisma.friendReport.count.mockResolvedValue(0);
      prisma.wallet.findUnique.mockResolvedValue(null);

      const result = await service.getUserDetail('user-1');

      expect(result.summary.walletBalance).toBe(0);
    });

    it('returns a stable Admin not-found error', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getUserDetail('missing')).rejects.toMatchObject({
        response: {
          errorCode: AdminUserErrorCode.NotFound,
        },
      });
    });
  });

  describe('revealSensitiveField', () => {
    const actor = { userId: 'admin-1', accountId: 'support-admin' };

    it('reveals one selected field only after recording a value-free audit event', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(Date.parse('2026-07-22T10:00:00.000Z'));
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'private@example.com',
      });
      audit.recordInTransaction.mockResolvedValue({ id: 'audit-1' });

      const result = await service.revealSensitiveField(actor, 'user-1', {
        field: 'email',
        reason: 'support-123',
      });

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { id: true, email: true },
      });
      expect(audit.recordInTransaction).toHaveBeenCalledWith(
        expect.anything(),
        {
          actorId: 'admin-1',
          actorAccountId: 'support-admin',
          action: 'USER_SENSITIVE_FIELD_VIEWED',
          targetType: 'user',
          targetId: 'user-1',
          reason: 'support-123',
          metadata: { field: 'email' },
        },
      );
      expect(
        JSON.stringify(audit.recordInTransaction.mock.calls),
      ).not.toContain('private@example.com');
      expect(result).toEqual({
        field: 'email',
        value: 'private@example.com',
        revealedAt: new Date('2026-07-22T10:00:00.000Z'),
        expiresAt: new Date('2026-07-22T10:01:00.000Z'),
      });
      jest.useRealTimers();
    });

    it('fails closed when the reveal audit cannot be written', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        phoneNumber: '15512345678',
      });
      audit.recordInTransaction.mockRejectedValue(new Error('database down'));

      await expect(
        service.revealSensitiveField(actor, 'user-1', {
          field: 'phoneNumber',
          reason: 'support-123',
        }),
      ).rejects.toMatchObject({
        response: { errorCode: AdminUserErrorCode.AuditUnavailable },
      });
    });
  });

  describe('listAuditLogs', () => {
    it('confirms the target exists before delegating to the audit service', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      audit.listForTarget.mockResolvedValue([{ id: 'audit-1' }]);

      const result = await service.listAuditLogs('user-1', 20);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { id: true },
      });
      expect(audit.listForTarget).toHaveBeenCalledWith('user', 'user-1', 20);
      expect(result).toEqual([{ id: 'audit-1' }]);
    });

    it('does not query audit rows for a missing target', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.listAuditLogs('missing', 20)).rejects.toMatchObject({
        response: { errorCode: AdminUserErrorCode.NotFound },
      });
      expect(audit.listForTarget).not.toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    const actor = { userId: 'admin-1', accountId: 'support-admin' };

    it('persists access revocation in the status transaction when banning', async () => {
      prisma.$transaction.mockImplementation(async (callback) => callback(tx));
      tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        status: UserStatus.ACTIVE,
      });
      tx.user.updateMany.mockResolvedValue({ count: 1 });
      tx.refreshToken.updateMany.mockResolvedValue({ count: 2 });
      audit.recordInTransaction.mockResolvedValue({ id: 'audit-1' });

      await service.updateStatus(actor, 'user-1', {
        status: UserStatus.BANNED,
        reason: 'policy violation',
      });

      const refreshRevokedAt =
        tx.refreshToken.updateMany.mock.calls[0][0].data.revokedAt;
      const expiresAt = new Date(refreshRevokedAt.getTime() + 60 * 60 * 1000);
      expect(tx.sessionRevocationOutbox.upsert).toHaveBeenCalledWith({
        where: { userID: 'user-1' },
        create: {
          userID: 'user-1',
          revokedAt: refreshRevokedAt,
          expiresAt,
        },
        update: {
          revokedAt: refreshRevokedAt,
          expiresAt,
          attempts: 0,
          lastError: null,
          nextAttemptAt: refreshRevokedAt,
        },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('completes and removes the durable revocation immediately when Redis is healthy', async () => {
      tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        status: UserStatus.ACTIVE,
      });
      tx.user.updateMany.mockResolvedValue({ count: 1 });
      tx.refreshToken.updateMany.mockResolvedValue({ count: 2 });
      audit.recordInTransaction.mockResolvedValue({ id: 'audit-1' });

      const result = await service.updateStatus(actor, 'user-1', {
        status: UserStatus.BANNED,
        reason: 'policy violation',
      });

      const revokedAt =
        tx.sessionRevocationOutbox.upsert.mock.calls[0][0].create.revokedAt;
      expect(sessionRevocation.revokeUserAt).toHaveBeenCalledWith(
        'user-1',
        revokedAt.getTime(),
      );
      expect(prisma.sessionRevocationOutbox.deleteMany).toHaveBeenCalledWith({
        where: { userID: 'user-1', revokedAt },
      });
      expect(result).toEqual({
        id: 'user-1',
        accountId: 'jim-1001',
        status: UserStatus.BANNED,
        sessionRevocationPending: false,
      });
    });

    it.each([
      [UserStatus.ACTIVE, UserStatus.BANNED, 'USER_BANNED', true],
      [UserStatus.ACTIVE, UserStatus.DELETED, 'USER_DELETED', true],
      [UserStatus.BANNED, UserStatus.ACTIVE, 'USER_UNBANNED', false],
      [UserStatus.BANNED, UserStatus.DELETED, 'USER_DELETED', true],
    ])(
      'changes %s to %s transactionally',
      async (currentStatus, targetStatus, action, revokesSessions) => {
        tx.user.findUnique.mockResolvedValue({
          id: 'user-1',
          accountId: 'jim-1001',
          status: currentStatus,
        });
        tx.user.updateMany.mockResolvedValue({ count: 1 });
        tx.refreshToken.updateMany.mockResolvedValue({ count: 2 });
        audit.recordInTransaction.mockResolvedValue({ id: 'audit-1' });

        const result = await service.updateStatus(actor, 'user-1', {
          status: targetStatus,
          reason: '  policy violation  ',
          ...(targetStatus === UserStatus.DELETED
            ? { confirmationAccountId: 'jim-1001' }
            : {}),
        });

        expect(tx.user.updateMany).toHaveBeenCalledWith({
          where: { id: 'user-1', status: currentStatus },
          data: { status: targetStatus },
        });
        expect(audit.recordInTransaction).toHaveBeenCalledWith(tx, {
          actorId: 'admin-1',
          actorAccountId: 'support-admin',
          action,
          targetType: 'user',
          targetId: 'user-1',
          before: { status: currentStatus },
          after: { status: targetStatus },
          reason: 'policy violation',
        });
        if (revokesSessions) {
          expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
            where: { userId: 'user-1', revokedAt: null },
            data: { revokedAt: expect.any(Date) },
          });
          const revokedAt =
            tx.refreshToken.updateMany.mock.calls[0][0].data.revokedAt;
          expect(sessionRevocation.revokeUserAt).toHaveBeenCalledWith(
            'user-1',
            revokedAt.getTime(),
          );
        } else {
          expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
          expect(sessionRevocation.revokeUserAt).not.toHaveBeenCalled();
        }
        expect(realtime.invalidateUserProfileSummaryCache).toHaveBeenCalledWith(
          'user-1',
        );
        expect(realtime.broadcastUserProfileSummary).toHaveBeenCalledWith(
          'user-1',
        );
        expect(result).toEqual({
          id: 'user-1',
          accountId: 'jim-1001',
          status: targetStatus,
          sessionRevocationPending: false,
        });
      },
    );

    it('persists session revocation in the status transaction before commit', async () => {
      tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        status: UserStatus.ACTIVE,
      });
      tx.user.updateMany.mockResolvedValue({ count: 1 });
      tx.refreshToken.updateMany.mockResolvedValue({ count: 2 });
      audit.recordInTransaction.mockResolvedValue({ id: 'audit-1' });
      const callOrder: string[] = [];
      tx.sessionRevocationOutbox.upsert.mockImplementation(async () => {
        callOrder.push('outbox');
        return {};
      });
      audit.recordInTransaction.mockImplementation(async () => {
        callOrder.push('audit');
        return { id: 'audit-1' };
      });
      prisma.$transaction.mockImplementation(async (callback) => {
        const value = await callback(tx);
        callOrder.push('commit');
        return value;
      });
      sessionRevocation.revokeUserAt.mockImplementation(async () => {
        callOrder.push('redis');
        return true;
      });

      await service.updateStatus(actor, 'user-1', {
        status: UserStatus.BANNED,
        reason: 'policy violation',
      });

      expect(callOrder).toEqual(['audit', 'outbox', 'commit', 'redis']);
    });

    it.each([
      [UserStatus.ACTIVE, UserStatus.ACTIVE],
      [UserStatus.BANNED, UserStatus.BANNED],
      [UserStatus.DELETED, UserStatus.ACTIVE],
      [UserStatus.DELETED, UserStatus.BANNED],
      [UserStatus.DELETED, UserStatus.DELETED],
    ])('rejects the invalid transition %s to %s', async (current, target) => {
      tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        status: current,
      });

      await expect(
        service.updateStatus(actor, 'user-1', {
          status: target,
          reason: 'policy violation',
        }),
      ).rejects.toMatchObject({
        response: { errorCode: AdminUserErrorCode.InvalidStatusTransition },
      });
      expect(tx.user.updateMany).not.toHaveBeenCalled();
      expect(audit.recordInTransaction).not.toHaveBeenCalled();
    });

    it.each([UserStatus.BANNED, UserStatus.DELETED])(
      'rejects self-directed %s',
      async (status) => {
        tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          accountId: 'support-admin',
          status: UserStatus.ACTIVE,
        });

        await expect(
          service.updateStatus(actor, 'admin-1', {
            status,
            reason: 'policy violation',
            confirmationAccountId: 'support-admin',
          }),
        ).rejects.toMatchObject({
          // 自保护是权限拒绝，错误目录把它定为 403，不是参数错误的 400。
          status: 403,
          response: { errorCode: AdminUserErrorCode.SelfStatusChange },
        });
      },
    );

    it('emits the admin_user_status_changed business event after commit', async () => {
      // 测试环境下 logOn 默认关，businessLogOn 是它的与项，两个都要打开。
      const previous = {
        log: process.env.LOG_ON,
        business: process.env.BUSINESS_LOG_ON,
      };
      process.env.LOG_ON = 'true';
      process.env.BUSINESS_LOG_ON = 'true';
      try {
        const logged = new AdminUserService(
          prisma as never,
          audit as never,
          sessionRevocation as never,
          realtime as never,
        );
        const logSpy = jest
          .spyOn(Logger.prototype, 'log')
          .mockImplementation(() => undefined);
        tx.user.findUnique.mockResolvedValue({
          id: 'user-1',
          accountId: 'jim-1001',
          status: UserStatus.ACTIVE,
        });
        tx.user.updateMany.mockResolvedValue({ count: 1 });
        tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
        audit.recordInTransaction.mockResolvedValue({ id: 'audit-1' });

        await logged.updateStatus(actor, 'user-1', {
          status: UserStatus.BANNED,
          reason: 'policy violation',
        });

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            businessEvent: 'admin_user_status_changed',
            actorId: 'admin-1',
            targetId: 'user-1',
            result: 'success',
            metadata: expect.objectContaining({
              oldStatus: UserStatus.ACTIVE,
              newStatus: UserStatus.BANNED,
              reason: 'policy violation',
            }),
          }),
          'BusinessEvent',
        );
        logSpy.mockRestore();
      } finally {
        for (const [key, value] of [
          ['LOG_ON', previous.log],
          ['BUSINESS_LOG_ON', previous.business],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    it.each([undefined, 'wrong-account'])(
      'requires the exact account ID for deletion (%s)',
      async (confirmationAccountId) => {
        tx.user.findUnique.mockResolvedValue({
          id: 'user-1',
          accountId: 'jim-1001',
          status: UserStatus.ACTIVE,
        });

        await expect(
          service.updateStatus(actor, 'user-1', {
            status: UserStatus.DELETED,
            reason: 'policy violation',
            confirmationAccountId,
          }),
        ).rejects.toMatchObject({
          response: { errorCode: AdminUserErrorCode.ConfirmationMismatch },
        });
      },
    );

    it('rejects a concurrent conditional-update conflict', async () => {
      tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        status: UserStatus.ACTIVE,
      });
      tx.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.updateStatus(actor, 'user-1', {
          status: UserStatus.BANNED,
          reason: 'policy violation',
        }),
      ).rejects.toMatchObject({
        response: { errorCode: AdminUserErrorCode.StatusConflict },
      });
      expect(audit.recordInTransaction).not.toHaveBeenCalled();
    });

    it('rolls back the operation surface when transactional audit fails', async () => {
      tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        status: UserStatus.ACTIVE,
      });
      tx.user.updateMany.mockResolvedValue({ count: 1 });
      tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      audit.recordInTransaction.mockRejectedValue(new Error('audit down'));

      await expect(
        service.updateStatus(actor, 'user-1', {
          status: UserStatus.BANNED,
          reason: 'policy violation',
        }),
      ).rejects.toThrow('audit down');
      expect(sessionRevocation.revokeUserAt).not.toHaveBeenCalled();
      expect(realtime.invalidateUserProfileSummaryCache).not.toHaveBeenCalled();
    });

    it('reports pending revocation when Redis returns unavailable after commit', async () => {
      tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        accountId: 'jim-1001',
        status: UserStatus.ACTIVE,
      });
      tx.user.updateMany.mockResolvedValue({ count: 1 });
      tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      audit.recordInTransaction.mockResolvedValue({ id: 'audit-1' });
      sessionRevocation.revokeUserAt.mockResolvedValue(false);
      realtime.invalidateUserProfileSummaryCache.mockRejectedValue(
        new Error('cache down'),
      );

      await expect(
        service.updateStatus(actor, 'user-1', {
          status: UserStatus.BANNED,
          reason: 'policy violation',
        }),
      ).resolves.toEqual({
        id: 'user-1',
        accountId: 'jim-1001',
        status: UserStatus.BANNED,
        sessionRevocationPending: true,
      });
      expect(prisma.sessionRevocationOutbox.deleteMany).not.toHaveBeenCalled();
    });

    it('returns not found before attempting a status write', async () => {
      tx.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus(actor, 'missing', {
          status: UserStatus.BANNED,
          reason: 'policy violation',
        }),
      ).rejects.toMatchObject({
        response: { errorCode: AdminUserErrorCode.NotFound },
      });
      expect(tx.user.updateMany).not.toHaveBeenCalled();
    });
  });
});

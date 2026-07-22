import { runWithRequestContext } from 'src/logging/request-context';
import { AdminAuditService } from './admin-audit.service';

describe('AdminAuditService', () => {
  const findMany = jest.fn();
  const service = new AdminAuditService({
    adminAuditLog: { findMany },
  } as never);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records explicit audit data with bounded request context', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const tx = { adminAuditLog: { create } };
    const secret = 'private@example.com';

    await runWithRequestContext(
      {
        requestId: 'req-1',
        traceId: 'trace-1',
        method: 'POST',
        path: '/api/v1/admin/users/user-1/sensitive-access',
        ip: 'i'.repeat(80),
        userAgent: 'u'.repeat(300),
      },
      () =>
        service.recordInTransaction(tx as never, {
          actorId: 'admin-1',
          actorAccountId: 'support-admin',
          action: 'USER_SENSITIVE_FIELD_VIEWED',
          targetType: 'user',
          targetId: 'user-1',
          reason: 'support-123',
          metadata: { field: 'email' },
          originalContact: secret,
        } as never),
    );

    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: 'admin-1',
        actorAccountId: 'support-admin',
        action: 'USER_SENSITIVE_FIELD_VIEWED',
        targetType: 'user',
        targetId: 'user-1',
        before: undefined,
        after: undefined,
        reason: 'support-123',
        metadata: { field: 'email' },
        requestId: 'req-1',
        ip: 'i'.repeat(64),
        userAgent: 'u'.repeat(256),
      },
    });
    expect(JSON.stringify(create.mock.calls[0])).not.toContain(secret);
  });

  it('lists newest public audit rows and caps the limit at 100', async () => {
    findMany.mockResolvedValue([]);

    await service.listForTarget('user', 'user-1', 500);

    expect(findMany).toHaveBeenCalledWith({
      where: { targetType: 'user', targetId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        actorId: true,
        actorAccountId: true,
        action: true,
        targetType: true,
        targetId: true,
        before: true,
        after: true,
        reason: true,
        metadata: true,
        requestId: true,
        ip: true,
        userAgent: true,
        createdAt: true,
      },
    });
  });
});

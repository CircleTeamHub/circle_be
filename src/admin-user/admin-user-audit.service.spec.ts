import { runWithRequestContext } from 'src/logging/request-context';
import { AdminUserAuditService } from './admin-user-audit.service';

describe('AdminUserAuditService', () => {
  const findMany = jest.fn();
  const service = new AdminUserAuditService({
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
        service.recordInTransaction(
          tx as never,
          {
            actorId: 'admin-1',
            actorAccountId: 'support-admin',
            action: 'USER_SENSITIVE_FIELD_VIEWED',
            targetType: 'user',
            targetId: 'user-1',
            reason: 'support-123',
            metadata: { field: 'email' },
            originalContact: secret,
          } as never,
        ),
    );

    // 写入落在治理侧先建好的列上，两个模块共用同一张 AdminAuditLog。
    expect(create).toHaveBeenCalledWith({
      data: {
        actorID: 'admin-1',
        actorAccountId: 'support-admin',
        action: 'USER_SENSITIVE_FIELD_VIEWED',
        entityType: 'user',
        entityID: 'user-1',
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
      where: { entityType: 'user', entityID: 'user-1' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        actorID: true,
        actorAccountId: true,
        action: true,
        entityType: true,
        entityID: true,
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

  it('exposes rows under the admin console target contract', async () => {
    findMany.mockResolvedValue([
      {
        id: 'audit-1',
        actorID: 'admin-1',
        actorAccountId: 'support-admin',
        action: 'USER_BANNED',
        entityType: 'user',
        entityID: 'user-1',
        before: { status: 'ACTIVE' },
        after: { status: 'BANNED' },
        reason: 'support-123',
        metadata: null,
        requestId: 'req-1',
        ip: null,
        userAgent: null,
        createdAt: new Date('2026-07-22T00:00:00.000Z'),
      },
    ]);

    const [row] = await service.listForTarget('user', 'user-1');

    expect(row).toMatchObject({
      actorId: 'admin-1',
      actorAccountId: 'support-admin',
      targetType: 'user',
      targetId: 'user-1',
    });
    expect(row).not.toHaveProperty('entityType');
    expect(row).not.toHaveProperty('actorID');
  });

  it('falls back to the actor id when a row carries no account id', async () => {
    // 治理侧写入不带 actorAccountId，管理台列表不能因此出现空的操作人。
    findMany.mockResolvedValue([
      {
        id: 'audit-2',
        actorID: 'admin-9',
        actorAccountId: null,
        action: 'NOTE_TAKEN_DOWN',
        entityType: 'user',
        entityID: 'user-1',
        before: null,
        after: null,
        reason: null,
        metadata: null,
        requestId: null,
        ip: null,
        userAgent: null,
        createdAt: new Date('2026-07-22T00:00:00.000Z'),
      },
    ]);

    const [row] = await service.listForTarget('user', 'user-1');

    expect(row.actorAccountId).toBe('admin-9');
  });
});

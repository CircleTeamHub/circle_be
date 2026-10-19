import { AdminAccessService } from './admin-access.service';
function harness(actorRole = 'SUPER_ADMIN', targetRole = 'SUPPORT') {
  const actor = {
    id: 'actor',
    role: 'ADMIN',
    status: 'ACTIVE',
    adminAccess: { role: actorRole, version: 1 },
  };
  const target = {
    id: 'target',
    role: 'ADMIN',
    status: 'ACTIVE',
    nickname: '旧昵称',
    accountId: 'old_account',
    adminAccess: { role: targetRole, version: 2 },
  };
  const tx = {
    $executeRaw: jest.fn(),
    user: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.id === 'actor' ? actor : where.id === 'target' ? target : null,
        ),
      ),
      update: jest.fn(),
    },
    accountIdentifier: { findUnique: jest.fn().mockResolvedValue(null) },
    adminAccess: {
      upsert: jest.fn().mockResolvedValue({ role: 'MODERATOR', version: 3 }),
      count: jest.fn().mockResolvedValue(2),
    },
    refreshToken: { updateMany: jest.fn() },
    adminAuditLog: { create: jest.fn() },
  };
  return {
    tx,
    actor,
    target,
    service: new AdminAccessService({
      $transaction: async (fn: any) => fn(tx),
    } as any),
  };
}
const changes = {
  nickname: '新昵称',
  accountId: 'new_account',
  role: 'MODERATOR' as const,
  version: 2,
  reason: '更新管理员资料',
};
it('updates the nickname, account and role together and revokes old sessions', async () => {
  const { tx, service } = harness();
  await service.update('actor', 'target', changes);
  expect(tx.user.update).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'target' },
      data: expect.objectContaining({
        nickname: '新昵称',
        accountId: 'new_account',
        accessTokensRevokedAt: expect.any(Date),
      }),
    }),
  );
  expect(tx.refreshToken.updateMany).toHaveBeenCalled();
  expect(tx.adminAuditLog.create).toHaveBeenCalled();
});
it.each(['OPERATIONS', 'MODERATOR', 'SUPPORT'])(
  'denies edits and deletes by %s',
  async (role) => {
    const { service, tx } = harness(role);
    await expect(
      service.update('actor', 'target', changes),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.remove('actor', 'target', { version: 2, reason: '删除管理员' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.user.update).not.toHaveBeenCalled();
  },
);
it('rejects stale profile versions and occupied account names', async () => {
  const { service, tx } = harness();
  await expect(
    service.update('actor', 'target', { ...changes, version: 1 }),
  ).rejects.toMatchObject({ status: 409 });
  tx.accountIdentifier.findUnique.mockResolvedValue({ value: 'new_account' });
  await expect(
    service.update('actor', 'target', changes),
  ).rejects.toMatchObject({ status: 409 });
  expect(tx.user.update).not.toHaveBeenCalled();
});
it('allows editing own profile but forbids changing own role or deleting own account', async () => {
  const { service, tx } = harness();
  await service.update('actor', 'actor', {
    ...changes,
    role: 'SUPER_ADMIN',
    version: 1,
  });
  expect(tx.user.update).toHaveBeenCalled();
  await expect(
    service.update('actor', 'actor', { ...changes, version: 1 }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    service.remove('actor', 'actor', { version: 1, reason: '删除自己' }),
  ).rejects.toMatchObject({ status: 400 });
});
it('deletes by disabling the account and revoking sessions while retaining audit history', async () => {
  const { service, tx } = harness();
  await service.remove('actor', 'target', { version: 2, reason: '管理员离职' });
  expect(tx.user.update).toHaveBeenCalledWith(
    expect.objectContaining({
      data: { status: 'DELETED', accessTokensRevokedAt: expect.any(Date) },
    }),
  );
  expect(tx.refreshToken.updateMany).toHaveBeenCalled();
  expect(tx.adminAuditLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        action: 'admin.account.delete',
        reason: '管理员离职',
      }),
    }),
  );
});
it('rejects stale deletion and preserves the last active super administrator', async () => {
  const { service, tx } = harness('SUPER_ADMIN', 'SUPER_ADMIN');
  await expect(
    service.remove('actor', 'target', { version: 1, reason: '删除账号' }),
  ).rejects.toMatchObject({ status: 409 });
  tx.adminAccess.count.mockResolvedValue(1);
  await expect(
    service.remove('actor', 'target', { version: 2, reason: '删除账号' }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    service.update('actor', 'target', changes),
  ).rejects.toMatchObject({ status: 400 });
  expect(tx.user.update).not.toHaveBeenCalled();
});

import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import * as argon2 from 'argon2';
import { AdminAccessService } from './admin-access.service';
import {
  CreateAdminAccountDto,
  ResetAdminPasswordDto,
} from './admin-access.dto';

const values = {
  nickname: '运营小王',
  accountId: 'operator_01',
  password: 'InitialPass1234',
  role: 'OPERATIONS' as const,
};
function createHarness(actorRole = 'SUPER_ADMIN') {
  const tx = {
    $executeRaw: jest.fn(),
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'super'
          ? {
              role: 'ADMIN',
              status: 'ACTIVE',
              adminAccess: { role: actorRole },
            }
          : null,
      ),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({
        id: 'new-admin',
        nickname: values.nickname,

        accountId: values.accountId,
      }),
    },
    accountIdentifier: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    adminAuditLog: { create: jest.fn() },
  };
  const service = new AdminAccessService({
    $transaction: async (fn: any) => fn(tx),
  } as any);
  return { service, tx };
}
it('creates a separate admin with a hashed password, selected role without self-service password changes', async () => {
  const { service, tx } = createHarness();
  const result = await service.create('super', values);
  const data = tx.user.create.mock.calls[0][0].data;
  expect(data).toEqual(
    expect.objectContaining({
      role: 'ADMIN',
      mustChangePassword: false,
      accountId: values.accountId,
      email: null,
      adminAccess: { create: { role: 'OPERATIONS' } },
    }),
  );
  expect(await argon2.verify(data.passwordHash, values.password)).toBe(true);
  expect(result).not.toHaveProperty('passwordHash');
  expect(result).not.toHaveProperty('password');
  expect(JSON.stringify(tx.adminAuditLog.create.mock.calls)).not.toContain(
    values.password,
  );
});
it('does not let a non-super administrator create another administrator', async () => {
  const { service, tx } = createHarness('OPERATIONS');
  await expect(service.create('operator', values)).rejects.toMatchObject({
    status: 403,
  });
  expect(tx.user.create).not.toHaveBeenCalled();
});
it('rejects an existing login account instead of promoting or overwriting an app account', async () => {
  const { service, tx } = createHarness();
  tx.user.findUnique.mockImplementation(async ({ where }: any) =>
    where.id === 'super'
      ? {
          role: 'ADMIN',
          status: 'ACTIVE',
          adminAccess: { role: 'SUPER_ADMIN' },
        }
      : ({ id: 'existing-user' } as any),
  );
  await expect(service.create('super', values)).rejects.toMatchObject({
    status: 409,
  });
  expect(tx.user.create).not.toHaveBeenCalled();
});
it('validates all creation fields and a strong initial password', () => {
  expect(
    validateSync(plainToInstance(CreateAdminAccountDto, values)),
  ).toHaveLength(0);
  for (const override of [
    { password: 'short' },
    { password: '123456789012' },
    { nickname: ' ' },
    { accountId: 'invalid account!' },
    { role: 'OWNER' },
  ])
    expect(
      validateSync(
        plainToInstance(CreateAdminAccountDto, { ...values, ...override }),
      ),
    ).not.toHaveLength(0);
});

function resetHarness(actorRole = 'SUPER_ADMIN', targetRole = 'ADMIN') {
  const tx = {
    $executeRaw: jest.fn(),
    user: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'super'
          ? {
              role: 'ADMIN',
              status: 'ACTIVE',
              adminAccess: { role: actorRole },
            }
          : { role: targetRole, status: 'ACTIVE' },
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    refreshToken: { updateMany: jest.fn() },
    adminAuditLog: { create: jest.fn() },
  };
  return {
    tx,
    service: new AdminAccessService({
      $transaction: async (fn: any) => fn(tx),
    } as any),
  };
}
it('lets a super administrator reset a password and revokes all sessions atomically', async () => {
  const { tx, service } = resetHarness();
  await service.resetPassword('super', 'target', {
    newPassword: 'NewPassword5678',
    reason: '管理员申请重置',
  });
  const data = tx.user.updateMany.mock.calls[0][0].data;
  expect(await argon2.verify(data.passwordHash, 'NewPassword5678')).toBe(true);
  expect(data.accessTokensRevokedAt).toBeInstanceOf(Date);
  expect(tx.refreshToken.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { userId: 'target', revokedAt: null } }),
  );
  expect(tx.adminAuditLog.create).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        actorID: 'super',
        entityID: 'target',
        action: 'admin.password.reset',
        reason: '管理员申请重置',
      }),
    }),
  );
  expect(JSON.stringify(tx.adminAuditLog.create.mock.calls)).not.toContain(
    'NewPassword5678',
  );
});
it.each(['OPERATIONS', 'SUPPORT', 'MODERATOR'])(
  'does not let %s reset their own or another administrator password',
  async (role) => {
    const { tx, service } = resetHarness(role);
    await expect(
      service.resetPassword('super', 'super', {
        newPassword: 'NewPassword5678',
        reason: '重置密码',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  },
);
it('does not use admin password reset for ordinary app users', async () => {
  const { tx, service } = resetHarness('SUPER_ADMIN', 'USER');
  await expect(
    service.resetPassword('super', 'target', {
      newPassword: 'NewPassword5678',
      reason: '重置密码',
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(tx.user.updateMany).not.toHaveBeenCalled();
});
it('requires a strong new password and audit reason', () => {
  expect(
    validateSync(
      plainToInstance(ResetAdminPasswordDto, {
        newPassword: 'weak',
        reason: '',
      }),
    ),
  ).not.toHaveLength(0);
});

it('rejects a login account reserved by another identifier without creating an administrator', async () => {
  const { service, tx } = createHarness();
  tx.accountIdentifier.findUnique.mockResolvedValue({
    value: values.accountId,
  });
  await expect(service.create('super', values)).rejects.toMatchObject({
    status: 409,
  });
  expect(tx.user.create).not.toHaveBeenCalled();
});
it('normalizes administrator login accounts and does not require an email', () => {
  const dto = plainToInstance(CreateAdminAccountDto, {
    ...values,
    accountId: '  Support_01  ',
  });
  expect(dto.accountId).toBe('support_01');
  expect(validateSync(dto)).toHaveLength(0);
});

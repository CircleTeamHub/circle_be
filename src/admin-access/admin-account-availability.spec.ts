import { AdminAccessService } from './admin-access.service';
import { AdminAccountAvailabilityQuery } from './admin-access.dto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
function harness(user: object | null = null, identifier: object | null = null) {
  const prisma = {
    user: { findUnique: jest.fn().mockResolvedValue(user) },
    accountIdentifier: { findUnique: jest.fn().mockResolvedValue(identifier) },
  };
  return { prisma, service: new AdminAccessService(prisma as any) };
}
it('checks canonical account names without returning information about the owner', async () => {
  const { service, prisma } = harness();
  expect(await service.availability({ accountId: ' Support_01 ' })).toEqual({
    available: true,
  });
  expect(prisma.user.findUnique).toHaveBeenCalledWith({
    where: { accountId: 'support_01' },
    select: { id: true },
  });
});
it.each([
  [{ id: 'app-user' }, null],
  [{ id: 'admin-user' }, { value: 'taken', currentUserID: 'admin-user' }],
  [null, { value: 'reserved', currentUserID: null }],
])(
  'rejects accounts or reserved identifiers already in use',
  async (user, identifier) => {
    expect(
      await harness(user, identifier).service.availability({
        accountId: 'taken',
      }),
    ).toEqual({ available: false });
  },
);
it('allows an unchanged account when editing its current owner', async () => {
  const { service } = harness(
    { id: 'owner' },
    { value: 'current', currentUserID: 'owner' },
  );
  expect(
    await service.availability({
      accountId: 'current',
      excludeUserId: 'owner',
    }),
  ).toEqual({ available: true });
  expect(
    await service.availability({
      accountId: 'current',
      excludeUserId: 'other',
    }),
  ).toEqual({ available: false });
});
it('does not treat historical reserved identifiers as available for their old owner', async () => {
  expect(
    await harness(null, {
      value: 'old_name',
      currentUserID: 'owner',
    }).service.availability({ accountId: 'old_name', excludeUserId: 'owner' }),
  ).toEqual({ available: false });
});
it('validates account formats and optional editing identifiers', () => {
  expect(
    validateSync(
      plainToInstance(AdminAccountAvailabilityQuery, {
        accountId: 'bad account',
      }),
    ),
  ).not.toHaveLength(0);
  expect(
    validateSync(
      plainToInstance(AdminAccountAvailabilityQuery, {
        accountId: 'valid_name',
        excludeUserId: 'invalid',
      }),
    ),
  ).not.toHaveLength(0);
});

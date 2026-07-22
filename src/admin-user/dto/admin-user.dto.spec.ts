import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserRole, UserStatus } from 'src/generated/prisma';
import {
  AdminUpdateUserStatusDto,
  ListAdminUsersQueryDto,
  RevealSensitiveFieldDto,
} from './admin-user.dto';

async function expectInvalid<T extends object>(
  type: new () => T,
  input: Record<string, unknown>,
) {
  const errors = await validate(plainToInstance(type, input));
  expect(errors.length).toBeGreaterThan(0);
}

describe('Admin user DTOs', () => {
  it.each([
    [{ page: 0 }],
    [{ limit: 101 }],
    [{ status: 'UNKNOWN' }],
    [{ role: 'UNKNOWN' }],
    [{ createdFrom: 'not-a-date' }],
    [{ createdTo: 'not-a-date' }],
    [{ keyword: 'x'.repeat(101) }],
  ])('rejects invalid list query %j', async (input) => {
    await expectInvalid(ListAdminUsersQueryDto, input);
  });

  it('accepts and transforms a valid list query', async () => {
    const dto = plainToInstance(ListAdminUsersQueryDto, {
      keyword: 'jim',
      status: UserStatus.ACTIVE,
      role: UserRole.USER,
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-02-01T00:00:00.000Z',
      page: '2',
      limit: '50',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(50);
  });

  it.each([
    [{ field: 'passwordHash', reason: 'support-123' }],
    [{ field: 'email', reason: 'no' }],
    // 空白理由必须在 DTO 层就挡掉：查看明文一定要留下真正的审计理由。
    [{ field: 'email', reason: '   ' }],
    [{ field: 'email', reason: '\t\n  ' }],
  ])('rejects invalid sensitive reveal %j', async (input) => {
    await expectInvalid(RevealSensitiveFieldDto, input);
  });

  it.each(['   ', ' \t ', '\n\n'])(
    'rejects a whitespace-only status reason %j',
    async (reason) => {
      await expectInvalid(AdminUpdateUserStatusDto, {
        status: UserStatus.BANNED,
        reason,
      });
    },
  );

  it('trims the reasons it keeps', async () => {
    const reveal = plainToInstance(RevealSensitiveFieldDto, {
      field: 'email',
      reason: '  support-123  ',
    });
    const status = plainToInstance(AdminUpdateUserStatusDto, {
      status: UserStatus.BANNED,
      reason: '  abuse reports  ',
    });

    await expect(validate(reveal)).resolves.toEqual([]);
    await expect(validate(status)).resolves.toEqual([]);
    expect(reveal.reason).toBe('support-123');
    expect(status.reason).toBe('abuse reports');
  });

  it('accepts a valid sensitive reveal', async () => {
    await expect(
      validate(
        plainToInstance(RevealSensitiveFieldDto, {
          field: 'email',
          reason: 'support-123',
        }),
      ),
    ).resolves.toEqual([]);
  });

  it('rejects a status reason shorter than three characters', async () => {
    await expectInvalid(AdminUpdateUserStatusDto, {
      status: UserStatus.BANNED,
      reason: 'no',
    });
  });

  it('accepts a valid status payload', async () => {
    await expect(
      validate(
        plainToInstance(AdminUpdateUserStatusDto, {
          status: UserStatus.DELETED,
          reason: 'fraud investigation',
          confirmationAccountId: 'windnote-1001',
        }),
      ),
    ).resolves.toEqual([]);
  });
});

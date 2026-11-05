import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { Prisma } from 'src/generated/prisma';
import { reportOperationalError } from 'src/logging/error-aggregation.service';

jest.mock('argon2', () => ({ verify: jest.fn() }));
jest.mock('src/logging/error-aggregation.service', () => ({
  reportOperationalError: jest.fn(),
}));

describe('verified email changes', () => {
  const user = {
    id: 'me',
    email: 'old@example.com',
    passwordHash: 'hash',
    role: 'USER',
    status: 'ACTIVE',
  };
  const tx = {
    user: { update: jest.fn(), findUnique: jest.fn() },
    $executeRaw: jest.fn(),
  };
  const prisma = { user: { findUnique: jest.fn() }, $transaction: jest.fn() };
  const codes = { requestCode: jest.fn(), verifyCode: jest.fn() };
  const sessions = {
    revokeAllInTransaction: jest.fn(),
    revokeAllAccessMarkers: jest.fn(),
  };
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(argon2.verify).mockResolvedValue(true);
    prisma.user.findUnique.mockImplementation(
      ({ where }: { where: { id?: string } }) =>
        Promise.resolve(where.id ? user : null),
    );
    tx.user.findUnique.mockResolvedValue(user);
    prisma.$transaction.mockImplementation(
      (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    );
    codes.verifyCode.mockResolvedValue(true);
    service = Object.assign(
      Object.create(AuthService.prototype) as AuthService,
      {
        prisma,
        emailVerification: codes,
        refreshTokenService: sessions,
        loggingConfig: { businessLogOn: false },
        logger: { error: jest.fn() },
      },
    );
  });

  it('requires the current password before sending a new-mailbox code', async () => {
    jest.mocked(argon2.verify).mockResolvedValue(false);
    await expect(
      service.requestEmailChange('me', 'new@example.com', 'wrong'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(codes.requestCode).not.toHaveBeenCalled();
  });

  it('normalizes the new email and uses a separate verification purpose', async () => {
    await service.requestEmailChange('me', ' NEW@example.com ', 'password');
    expect(codes.requestCode).toHaveBeenCalledWith(
      'new@example.com',
      'CHANGE_EMAIL',
    );
  });

  it('rejects a used email without changing the account', async () => {
    prisma.user.findUnique.mockResolvedValue({ ...user, id: 'other' });
    await expect(
      service.requestEmailChange('me', 'new@example.com', 'password'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(codes.requestCode).not.toHaveBeenCalled();
  });

  it('does not write an email when the purpose-specific code is invalid', async () => {
    codes.verifyCode.mockResolvedValue(false);
    await expect(
      service.changeEmail('me', 'new@example.com', 'password', '000000'),
    ).rejects.toThrow();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(sessions.revokeAllInTransaction).not.toHaveBeenCalled();
  });

  it('rechecks the current password before accepting a code', async () => {
    jest.mocked(argon2.verify).mockResolvedValue(false);
    await expect(
      service.changeEmail('me', 'new@example.com', 'wrong', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(codes.verifyCode).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('commits the email and revokes old sessions in the same transaction', async () => {
    await service.changeEmail('me', 'NEW@example.com', 'password', '123456');
    expect(codes.verifyCode).toHaveBeenCalledWith(
      'new@example.com',
      'CHANGE_EMAIL',
      '123456',
    );
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'me' },
      data: { email: 'new@example.com' },
    });
    expect(sessions.revokeAllInTransaction).toHaveBeenCalledWith(tx, 'me');
    expect(sessions.revokeAllAccessMarkers).toHaveBeenCalledWith('me');
  });

  it('maps a concurrent duplicate email to a user-facing error', async () => {
    tx.user.update.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique constraint', {
        code: 'P2002',
        clientVersion: '7.9.1',
      }),
    );
    await expect(
      service.changeEmail('me', 'new@example.com', 'password', '123456'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.revokeAllAccessMarkers).not.toHaveBeenCalled();
  });

  it('fails the transaction if database session revocation fails', async () => {
    sessions.revokeAllInTransaction.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(
      service.changeEmail('me', 'new@example.com', 'password', '123456'),
    ).rejects.toThrow('database unavailable');
    expect(sessions.revokeAllAccessMarkers).not.toHaveBeenCalled();
  });

  it('preserves successful email changes if only the Redis marker fails', async () => {
    sessions.revokeAllAccessMarkers.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );
    await expect(
      service.changeEmail('me', 'new@example.com', 'password', '123456'),
    ).resolves.toBeUndefined();
    expect(reportOperationalError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ operation: 'changeEmail' }),
    );
  });
});

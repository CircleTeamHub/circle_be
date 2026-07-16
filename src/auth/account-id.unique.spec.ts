import {
  generateUniqueAccountId,
  generateUniqueRegistrationCode,
} from './account-id.unique';

describe('generateUniqueAccountId', () => {
  it('returns the first candidate when it is free', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const id = await generateUniqueAccountId(prisma as any, () => 'AAAAAA');
    expect(id).toBe('AAAAAA');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('retries on collision until a free id is found', async () => {
    const taken = new Set(['DUP001']);
    const prisma = {
      user: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(taken.has(where.accountId) ? { id: 'x' } : null),
        ),
      },
    };
    const seq = ['DUP001', 'DUP001', 'FREE99'];
    let i = 0;
    const id = await generateUniqueAccountId(prisma as any, () => seq[i++]);
    expect(id).toBe('FREE99');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting attempts', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'x' }) },
    };
    await expect(
      generateUniqueAccountId(prisma as any, () => 'ALWAYS'),
    ).rejects.toThrow(/unique account ID/);
  });
});

describe('generateUniqueRegistrationCode', () => {
  it('retries when a candidate is already an invite code', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(where.inviteCode === 'taken1' ? { id: 'x' } : null),
        ),
      },
    };
    const sequence = ['taken1', 'free22'];
    let index = 0;

    const code = await generateUniqueRegistrationCode(
      prisma as any,
      () => sequence[index++],
    );

    expect(code).toBe('free22');
  });

  it('checks both accountId and inviteCode before returning a candidate', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    await generateUniqueRegistrationCode(prisma as any, () => 'free22');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { accountId: 'free22' },
      select: { id: true },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { inviteCode: 'free22' },
      select: { id: true },
    });
  });
});

import {
  generateUniqueAccountId,
  generateUniqueRegistrationCode,
} from './account-id.unique';

describe('generateUniqueAccountId', () => {
  it('returns the first candidate when it is free', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const id = await generateUniqueAccountId(prisma as any, () => '123456');
    expect(id).toBe('123456');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(2);
  });

  it('retries on collision until a free id is found', async () => {
    const taken = new Set(['100001']);
    const prisma = {
      user: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(taken.has(where.accountId) ? { id: 'x' } : null),
        ),
      },
    };
    const seq = ['100001', '100001', '200002'];
    let i = 0;
    const id = await generateUniqueAccountId(prisma as any, () => seq[i++]);
    expect(id).toBe('200002');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(6);
  });

  it('keeps numeric account IDs out of the shared invite and fancy-number namespace', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(
            where.inviteCode === '100001' ? { id: 'invite-owner' } : null,
          ),
        ),
      },
      accountIdentifier: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(
            where.value === '200002' ? { value: '200002' } : null,
          ),
        ),
      },
    };
    const sequence = ['100001', '200002', '300003'];
    let index = 0;

    await expect(
      generateUniqueAccountId(prisma as any, () => sequence[index++]),
    ).resolves.toBe('300003');
  });

  it('throws after exhausting attempts', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'x' }) },
    };
    await expect(
      generateUniqueAccountId(prisma as any, () => '100001'),
    ).rejects.toThrow(/unique account ID/);
  });
});

describe('generateUniqueRegistrationCode', () => {
  it('retries when a candidate is already an invite code', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(where.inviteCode === 'TAKEN1' ? { id: 'x' } : null),
        ),
      },
    };
    const sequence = ['taken1', 'free22'];
    let index = 0;

    const code = await generateUniqueRegistrationCode(
      prisma as any,
      () => sequence[index++],
    );

    expect(code).toBe('FREE22');
  });

  it('checks both accountId and inviteCode before returning a candidate', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      accountIdentifier: { findUnique: jest.fn().mockResolvedValue(null) },
    };

    await generateUniqueRegistrationCode(prisma as any, () => 'free22');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { accountId: 'free22' },
      select: { id: true },
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { inviteCode: 'FREE22' },
      select: { id: true },
    });
    expect(prisma.accountIdentifier.findUnique).toHaveBeenCalledWith({
      where: { value: 'free22' },
      select: { value: true },
    });
  });

  it('retries when a candidate is reserved in fancy-number inventory', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      accountIdentifier: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(
            where.value === '888888' ? { value: '888888' } : null,
          ),
        ),
      },
    };
    const sequence = ['888888', 'free22'];
    let index = 0;

    await expect(
      generateUniqueRegistrationCode(prisma as any, () => sequence[index++]),
    ).resolves.toBe('FREE22');
  });
});

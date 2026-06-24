import { generateUniqueAccountId } from './account-id.unique';

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

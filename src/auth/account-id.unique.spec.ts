import { generateUniqueAccountId } from './account-id.unique';

describe('generateUniqueAccountId', () => {
  it('returns the first candidate when it is free', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const id = await generateUniqueAccountId(prisma as any, () => 'ACC_AAAAAA');
    expect(id).toBe('ACC_AAAAAA');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it('retries on collision until a free id is found', async () => {
    const taken = new Set(['ACC_DUP001']);
    const prisma = {
      user: {
        findUnique: jest.fn(({ where }) =>
          Promise.resolve(taken.has(where.accountId) ? { id: 'x' } : null),
        ),
      },
    };
    const seq = ['ACC_DUP001', 'ACC_DUP001', 'ACC_FREE99'];
    let i = 0;
    const id = await generateUniqueAccountId(prisma as any, () => seq[i++]);
    expect(id).toBe('ACC_FREE99');
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting attempts', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'x' }) },
    };
    await expect(
      generateUniqueAccountId(prisma as any, () => 'ACC_ALWAYS'),
    ).rejects.toThrow(/unique account ID/);
  });
});

import {
  generateUniqueAccountId,
  generateUniqueRegistrationCode,
  isAccountIdentifierClaimCollision,
} from './account-id.unique';

/**
 * 建一个按"已占用集合"回答批量查询的假 prisma。takenAccountIds /
 * takenInviteCodes / takenIdentifiers 都按小写规范值比对,和 AccountIdentifier
 * 的语义一致。
 */
function fakePrisma(options: {
  accounts?: Iterable<string>;
  invites?: Iterable<string>;
  identifiers?: Iterable<string>;
  withIdentifierTable?: boolean;
}) {
  const accounts = new Set(
    [...(options.accounts ?? [])].map((v) => v.toLowerCase()),
  );
  const invites = new Set(
    [...(options.invites ?? [])].map((v) => v.toLowerCase()),
  );
  const identifiers = new Set(
    [...(options.identifiers ?? [])].map((v) => v.toLowerCase()),
  );
  const findMany = jest.fn(({ where }: any) => {
    if (where.accountId) {
      return Promise.resolve(
        where.accountId.in
          .filter((v: string) => accounts.has(v.toLowerCase()))
          .map((accountId: string) => ({ accountId })),
      );
    }
    return Promise.resolve(
      where.inviteCode.in
        .filter((v: string) => invites.has(v.toLowerCase()))
        .map((inviteCode: string) => ({ inviteCode })),
    );
  });
  const identifierFindMany = jest.fn(({ where }: any) =>
    Promise.resolve(
      where.value.in
        .filter((v: string) => identifiers.has(v.toLowerCase()))
        .map((value: string) => ({ value })),
    ),
  );
  return {
    user: { findMany },
    ...(options.withIdentifierTable === false
      ? {}
      : { accountIdentifier: { findMany: identifierFindMany } }),
  };
}

describe('generateUniqueAccountId', () => {
  it('returns the first candidate when it is free', async () => {
    const prisma = fakePrisma({});
    const id = await generateUniqueAccountId(prisma as any, () => '123456');
    expect(id).toBe('123456');
    // 一批候选只查三次(accountId / inviteCode / AccountIdentifier),不是逐个候选查。
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.accountIdentifier!.findMany).toHaveBeenCalledTimes(1);
  });

  it('retries on collision until a free id is found', async () => {
    const prisma = fakePrisma({ accounts: ['100001'] });
    const seq = ['100001', '100001', '200002'];
    let i = 0;
    const id = await generateUniqueAccountId(
      prisma as any,
      () => seq[Math.min(i++, seq.length - 1)],
    );
    expect(id).toBe('200002');
  });

  it('keeps numeric account IDs out of the shared invite and fancy-number namespace', async () => {
    const prisma = fakePrisma({
      invites: ['100001'],
      identifiers: ['200002'],
    });
    const sequence = ['100001', '200002', '300003'];
    let index = 0;

    await expect(
      generateUniqueAccountId(
        prisma as any,
        () => sequence[Math.min(index++, sequence.length - 1)],
      ),
    ).resolves.toBe('300003');
  });

  // review 修复:6 位数字只有 100 万个取值,老实现只试 10 个候选,在半满时约
  // 1/1024 的注册直接 503。批量候选必须能在"前 100 个候选全被占用"时继续找。
  it('keeps allocating near saturation instead of giving up after ten candidates', async () => {
    const taken = Array.from({ length: 100 }, (_, i) =>
      String(100000 + i).padStart(6, '0'),
    );
    const prisma = fakePrisma({ accounts: taken });
    let index = 0;
    const generate = () =>
      index < taken.length ? taken[index++] : String(900000 + index++);

    await expect(
      generateUniqueAccountId(prisma as any, generate),
    ).resolves.toBe('900100');
  });

  it('throws after exhausting every candidate batch', async () => {
    const prisma = fakePrisma({ accounts: ['100001'] });
    await expect(
      generateUniqueAccountId(prisma as any, () => '100001'),
    ).rejects.toThrow(/unique account ID/);
    // 32 批 × 2 条 user 查询;候选去重后每批只剩一个值,不会退化成每候选一条。
    expect(prisma.user.findMany).toHaveBeenCalledTimes(64);
  });

  // review 修复:固定 4 批(128 个候选)在 99% 占用时仍有约 28% 的注册被拒,
  // 而那时还剩一万个空号。空闲值落在前几批之外时也必须能找到。
  it('finds a free id that sits far outside the first random batches', async () => {
    const taken = Array.from({ length: 900 }, (_, index) =>
      String(100000 + index).padStart(6, '0'),
    );
    const prisma = fakePrisma({ accounts: taken });
    let index = 0;
    const generate = () =>
      index < taken.length ? taken[index++] : String(900000 + index++);

    await expect(
      generateUniqueAccountId(prisma as any, generate),
    ).resolves.toBe('900900');
    // 命中之前每批只花 3 条查询,不是每个候选一条。
    expect(prisma.user.findMany.mock.calls.length).toBeLessThanOrEqual(64);
  });

  it('still returns on the first batch when the namespace is empty', async () => {
    const prisma = fakePrisma({});
    await expect(
      generateUniqueAccountId(prisma as any, () => '123456'),
    ).resolves.toBe('123456');
    // 空旷时不该因为上限抬高就多跑轮次。
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
  });

  it('works without the AccountIdentifier table (pre-migration schemas)', async () => {
    const prisma = fakePrisma({ withIdentifierTable: false });
    await expect(
      generateUniqueAccountId(prisma as any, () => '123456'),
    ).resolves.toBe('123456');
  });
});

describe('generateUniqueRegistrationCode', () => {
  it('retries when a candidate is already an invite code', async () => {
    const prisma = fakePrisma({ invites: ['TAKEN1'] });
    const sequence = ['taken1', 'free22'];
    let index = 0;

    const code = await generateUniqueRegistrationCode(
      prisma as any,
      () => sequence[Math.min(index++, sequence.length - 1)],
    );

    expect(code).toBe('FREE22');
  });

  it('checks accountId, inviteCode and the shared registry before returning', async () => {
    const prisma = fakePrisma({});

    await generateUniqueRegistrationCode(prisma as any, () => 'free22');

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { accountId: { in: ['free22'] } },
      select: { accountId: true },
    });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { inviteCode: { in: ['FREE22'] } },
      select: { inviteCode: true },
    });
    expect(prisma.accountIdentifier!.findMany).toHaveBeenCalledWith({
      where: { value: { in: ['free22'] } },
      select: { value: true },
    });
  });

  it('retries when a candidate is reserved in fancy-number inventory', async () => {
    const prisma = fakePrisma({ identifiers: ['888888'] });
    const sequence = ['888888', 'free22'];
    let index = 0;

    await expect(
      generateUniqueRegistrationCode(
        prisma as any,
        () => sequence[Math.min(index++, sequence.length - 1)],
      ),
    ).resolves.toBe('FREE22');
  });
});

describe('isAccountIdentifierClaimCollision', () => {
  it('recognises the trigger error for either generated value', () => {
    const error = new Error(
      'ERROR: account identifier collision: 100001 (SQLSTATE P0001)',
    );
    expect(isAccountIdentifierClaimCollision(error, ['100001', 'FREE22'])).toBe(
      true,
    );
    expect(isAccountIdentifierClaimCollision(error, ['200002'])).toBe(false);
  });

  it('matches the uppercase invite code raised by the trigger', () => {
    const error = new Error('account identifier collision: FREE22');
    expect(isAccountIdentifierClaimCollision(error, ['100001', 'FREE22'])).toBe(
      true,
    );
  });

  it('ignores unrelated database errors', () => {
    expect(
      isAccountIdentifierClaimCollision(new Error('connection reset'), [
        '100001',
      ]),
    ).toBe(false);
  });
});

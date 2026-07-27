import { Prisma } from 'src/generated/prisma';
import { CircleMemberLockService } from './circle-member-lock';

describe('CircleMemberLockService', () => {
  const membershipPolicy = { lockUsers: jest.fn() };
  const service = new CircleMemberLockService(membershipPolicy as any);

  beforeEach(() => jest.clearAllMocks());

  it('acquires sorted global user locks before canonical sorted pair locks', async () => {
    const tx = { $executeRaw: jest.fn() };

    await service.lock(tx as any, 'circle-1', ['user-z', 'user-a', 'user-z']);

    expect(membershipPolicy.lockUsers).toHaveBeenCalledWith(tx, [
      'user-a',
      'user-z',
    ]);
    expect(membershipPolicy.lockUsers.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRaw.mock.invocationCallOrder[0],
    );
    const query = tx.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(query.values).toEqual([
      'circle-member:circle-1:user-a',
      'circle-member:circle-1:user-z',
    ]);
    expect(query.sql).toContain('hashtextextended');
    expect(query.sql).not.toContain('hashtext(');
  });

  it('does not issue pair-lock SQL for an empty batch', async () => {
    const tx = { $executeRaw: jest.fn() };

    await service.lock(tx as any, 'circle-1', []);

    expect(membershipPolicy.lockUsers).toHaveBeenCalledWith(tx, []);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});

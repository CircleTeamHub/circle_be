import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditQueryService } from './admin-audit-query.service';
import { FAILED_AUDIT_WHERE } from './audit-record-kind';

describe('normal management operation records', () => {
  it('excludes failures before pagination and uses the same predicate for totals', async () => {
    const prisma = {
      adminAuditLog: {
        findMany: jest.fn().mockReturnValue('rows'),
        count: jest.fn().mockReturnValue('count'),
      },
      user: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockResolvedValue([[], 0]),
    };
    const service = new AdminAuditQueryService(
      prisma as unknown as PrismaService,
    );
    await service.list({
      page: 2,
      limit: 20,
      action: 'login',
      actorID: 'actor',
    });
    const find = prisma.adminAuditLog.findMany.mock.calls[0][0];
    expect(find).toMatchObject({
      where: {
        NOT: FAILED_AUDIT_WHERE,
        actorID: 'actor',
        action: { contains: 'login', mode: 'insensitive' },
      },
      skip: 20,
      take: 20,
    });
    expect(prisma.adminAuditLog.count).toHaveBeenCalledWith({
      where: find.where,
    });
  });
});

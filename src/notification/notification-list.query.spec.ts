import { NotificationType } from 'src/generated/prisma';
import { notificationPageScanQuery } from './notification-list.query';

describe('notificationPageScanQuery', () => {
  const types = [NotificationType.TRACE_LIKE, NotificationType.TRACE_COMMENT];

  it('scans only id and createdAt so the recipient index can answer it alone', () => {
    const query = notificationPageScanQuery({ userId: 'u', types, limit: 21 });

    expect(query.sql).toMatch(
      /SELECT n\."id", n\."createdAt"\s+FROM "Notification" n/,
    );
    // 部分索引谓词是 deleted = false：必须是字面量，参数化后通用计划证明不了。
    expect(query.sql).toMatch(/n\."deleted" = false/);
    expect(query.sql).toMatch(/ORDER BY n\."createdAt" DESC, n\."id" DESC/);
    expect(query.sql).not.toMatch(/OFFSET/);
    expect(query.sql).not.toMatch(/\(n\."createdAt", n\."id"\) </);
    expect(query.values).toEqual(['u', ...types, 21]);
  });

  it('continues after a keyset cursor', () => {
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const query = notificationPageScanQuery({
      userId: 'u',
      types,
      limit: 21,
      before: { createdAt, id: 'n-9' },
    });

    expect(query.text).toMatch(
      /AND \(n\."createdAt", n\."id"\) < \(\$4, \$5\)/,
    );
    expect(query.values).toEqual(['u', ...types, createdAt, 'n-9', 21]);
  });

  it('keeps the legacy page offset', () => {
    const query = notificationPageScanQuery({
      userId: 'u',
      types: [NotificationType.SYSTEM],
      limit: 20,
      offset: 40,
    });

    expect(query.text).toMatch(/LIMIT \$3\s+OFFSET \$4/);
    expect(query.values).toEqual(['u', NotificationType.SYSTEM, 20, 40]);
  });

  it('omits a zero offset', () => {
    const query = notificationPageScanQuery({
      userId: 'u',
      types,
      limit: 20,
      offset: 0,
    });

    expect(query.sql).not.toMatch(/OFFSET/);
  });
});

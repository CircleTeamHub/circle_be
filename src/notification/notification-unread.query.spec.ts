import { NotificationType } from 'src/generated/prisma';
import {
  CIRCLE_NOTIFICATION_TYPES,
  DISCOVER_NOTIFICATION_TYPES,
  MOMENT_NOTIFICATION_TYPES,
  PROFILE_NOTIFICATION_TYPES,
} from './notification.constants';
import {
  loadUnreadNotificationsByDomain,
  sumUnreadNotificationsByDomain,
  unreadNotificationCountsByTypeQuery,
} from './notification-unread.query';

/**
 * 未读数从「每个域一条 count」改成「一条 GROUP BY type」之后，域的口径挪到了 JS 里。
 * 这里逐个域钉住：每种类型只计进它所属的域，域外类型（报名、留言、历史遗留的 SQUAD_*）
 * 哪个域都不计 —— 与原来四条 `type IN (...)` 的 count 逐项一致。
 */
describe('unread notifications by domain', () => {
  const ALL_TYPES = Object.values(NotificationType);

  /** 每种类型给一个互不相同的 2 的幂，求和结果就能反推出到底计了哪些类型。 */
  const rows = ALL_TYPES.map((type, index) => ({ type, count: 2 ** index }));
  const weight = new Map(rows.map((row) => [row.type, row.count]));
  const expectedSum = (types: readonly NotificationType[]) =>
    types.reduce((sum, type) => sum + (weight.get(type) ?? 0), 0);

  it('sums every domain exactly like the old per-domain type IN counts', () => {
    expect(sumUnreadNotificationsByDomain(rows)).toEqual({
      discoverUnread: expectedSum(DISCOVER_NOTIFICATION_TYPES),
      momentsUnread: expectedSum(MOMENT_NOTIFICATION_TYPES),
      circleUnread: expectedSum(CIRCLE_NOTIFICATION_TYPES),
      profileUnread: expectedSum(PROFILE_NOTIFICATION_TYPES),
    });
  });

  it('counts types outside every domain in none of them', () => {
    const outside = [
      NotificationType.CIRCLE_POST_SIGNUP_CREATED,
      NotificationType.FRIEND_REQUEST_MESSAGE,
      NotificationType.SQUAD_REQUEST_RECEIVED,
    ];
    expect(
      sumUnreadNotificationsByDomain(
        outside.map((type) => ({ type, count: 7 })),
      ),
    ).toEqual({
      discoverUnread: 0,
      momentsUnread: 0,
      circleUnread: 0,
      profileUnread: 0,
    });
  });

  it('puts each domain type into the right buckets', () => {
    const one = (type: NotificationType) =>
      sumUnreadNotificationsByDomain([{ type, count: 1 }]);

    expect(one(NotificationType.TRACE_LIKE)).toEqual({
      discoverUnread: 1,
      momentsUnread: 1,
      circleUnread: 0,
      profileUnread: 0,
    });
    expect(one(NotificationType.CIRCLE_POST_PUBLISHED)).toEqual({
      discoverUnread: 1,
      momentsUnread: 0,
      circleUnread: 1,
      profileUnread: 0,
    });
    // 好友申请 / 入群审批 / 圈子邀请只进互动总数，两个铃铛都不收。
    for (const type of [
      NotificationType.FRIEND_REQUEST_RECEIVED,
      NotificationType.GROUP_ADMISSION,
      NotificationType.CIRCLE_INVITATION_RECEIVED,
    ]) {
      expect(one(type)).toEqual({
        discoverUnread: 1,
        momentsUnread: 0,
        circleUnread: 0,
        profileUnread: 0,
      });
    }
    expect(one(NotificationType.SYSTEM)).toEqual({
      discoverUnread: 0,
      momentsUnread: 0,
      circleUnread: 0,
      profileUnread: 1,
    });
  });

  it('treats an empty result as all zero', () => {
    expect(sumUnreadNotificationsByDomain([])).toEqual({
      discoverUnread: 0,
      momentsUnread: 0,
      circleUnread: 0,
      profileUnread: 0,
    });
  });

  it('reads one GROUP BY over the unread partial index predicate', () => {
    const query = unreadNotificationCountsByTypeQuery('user-1');

    expect(query.values).toEqual(['user-1']);
    // deleted / read 必须是字面量：部分索引的谓词是 deleted = false AND read = false，
    // 绑成参数的话通用计划证明不了谓词，会退回全表。
    expect(query.sql).toMatch(/"deleted" = false/);
    expect(query.sql).toMatch(/"read" = false/);
    expect(query.sql).toMatch(/GROUP BY n\."type"/);
    expect(query.sql).toMatch(/count\(\*\)::int/);
  });

  it('loads every domain with a single statement', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([
        { type: 'TRACE_LIKE', count: 2 },
        { type: 'SYSTEM', count: 3 },
      ]),
    };

    await expect(
      loadUnreadNotificationsByDomain(db, 'user-1'),
    ).resolves.toEqual({
      discoverUnread: 2,
      momentsUnread: 2,
      circleUnread: 0,
      profileUnread: 3,
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

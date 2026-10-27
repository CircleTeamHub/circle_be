import type { Client } from 'pg';
import { lockUserRelationshipState } from 'src/utils/user-relationship-lock';
import {
  backendPid,
  openCircleTxDb,
  waitUntilBlockedBy,
  type CircleTxDb,
} from './circle-tx-harness';
import { describePostgres } from './pg-test-db';

/**
 * lockUserRelationshipState 在一条语句里拿完所有 call-user:* 锁(原来每个用户一次
 * 往返:建 200 人的群就是事务里连发 200 条)。合并后必须守住三件事:
 * - 只发一条语句;
 * - 加锁顺序仍是排序后的用户顺序 —— 跨功能事务都按这个顺序拿锁,乱序就会死锁;
 * - key 与 FriendService / CallService 单独加锁时完全相同,彼此仍然互斥。
 */
describePostgres('lockUserRelationshipState (PostgreSQL)', () => {
  let t: CircleTxDb;
  let observer: Client;

  beforeAll(async () => {
    t = await openCircleTxDb('rel_lock');
    observer = await t.rawClient();
  }, 60_000);

  afterAll(async () => {
    await observer?.end();
    await t?.close();
  });

  /** 这个后端当前持有(granted)或在等(!granted)的 call-user 锁,按 key 列出。 */
  const advisoryState = async (pid: number, users: string[]) => {
    const { rows } = await observer.query<{ id: string; granted: boolean }>(
      `SELECT u.id, l.granted
         FROM unnest($2::text[]) AS u(id)
         JOIN pg_locks l
           ON l.pid = $1
          AND l.locktype = 'advisory'
          AND ((l.classid::bigint << 32) | l.objid::bigint)
              = hashtextextended('call-user:' || u.id, 0)
        ORDER BY u.id`,
      [pid, users],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.granted]));
  };

  it('takes every key in a single statement, deduplicated and sorted', async () => {
    t.setRecording(true);
    await t.prisma.$transaction((tx) =>
      lockUserRelationshipState(tx, ['u-c', 'u-a', 'u-b', 'u-a']),
    );
    t.setRecording(false);

    const locks = t.statements.filter((entry) =>
      entry.sql.includes('pg_advisory_xact_lock'),
    );
    expect(locks).toHaveLength(1);
    expect(locks[0].values).toEqual([
      ['call-user:u-a', 'call-user:u-b', 'call-user:u-c'],
    ]);
  });

  it('sends nothing for an empty list', async () => {
    t.setRecording(true);
    await t.prisma.$transaction((tx) => lockUserRelationshipState(tx, []));
    t.setRecording(false);
    expect(
      t.statements.filter((entry) =>
        entry.sql.includes('pg_advisory_xact_lock'),
      ),
    ).toHaveLength(0);
  });

  it('locks in sorted order and contends with single-key lockers', async () => {
    const holder = await t.rawClient();
    try {
      // FriendService / CallService 的单 key 写法。
      await holder.query('BEGIN');
      await holder.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('call-user:u-b', 0))`,
      );

      const locking = t.prisma.$transaction((tx) =>
        lockUserRelationshipState(tx, ['u-d', 'u-b', 'u-a', 'u-c']),
      );
      const [waiter] = await waitUntilBlockedBy(
        observer,
        await backendPid(holder),
      );

      // 排在 u-b 前面的已经拿到,u-b 在等,排在后面的还没开始拿。
      expect(await advisoryState(waiter, ['u-a', 'u-b', 'u-c', 'u-d'])).toEqual(
        {
          'u-a': true,
          'u-b': false,
        },
      );

      await holder.query('COMMIT');
      await locking;
    } finally {
      await holder.end();
    }
  });
});

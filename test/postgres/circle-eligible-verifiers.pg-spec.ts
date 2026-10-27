import { eligibleVerifierIdsQuery } from 'src/circle-invitation/eligible-verifiers.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 可挑验证人 = 本圈 ACTIVE 成员 ∩ 申请人的已接受好友 − 排除名单，按入圈先后。
 * 口径对齐旧实现（成员全量 + 两个 IN 查好友 + 内存求交）的每个分支；成本上不再把
 * 整圈成员搬出来，好友一侧走 Friend 的成对索引收窄。
 */
describePostgres('circle eligible verifiers query (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const eligible = async (params: {
    circleId?: string;
    callerId?: string;
    excludedUserIds?: string[];
  }) => {
    const q = eligibleVerifierIdsQuery({
      circleId: params.circleId ?? 'circle-1',
      callerId: params.callerId ?? 'applicant',
      excludedUserIds: params.excludedUserIds ?? ['applicant'],
    });
    const { rows } = await s.db.query<{ userID: string }>(q.text, q.values);
    return rows.map((row) => row.userID);
  };

  const member = async (
    userID: string,
    joinedAt: string,
    extra: { circleID?: string; status?: string } = {},
  ) => {
    await s.db.query(
      `INSERT INTO "CircleMember" (id, "userID", "circleID", status, "createdAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `m-${userID}-${extra.circleID ?? 'circle-1'}`,
        userID,
        extra.circleID ?? 'circle-1',
        extra.status ?? 'ACTIVE',
        joinedAt,
      ],
    );
  };

  let friendRow = 0;
  const friend = async (
    userID: string,
    friendID: string,
    state = 'ACCEPTED',
  ) => {
    friendRow += 1;
    await s.db.query(
      `INSERT INTO "Friend" (id, "userID", "friendID", state) VALUES ($1, $2, $3, $4)`,
      [`f-${friendRow}`, userID, friendID, state],
    );
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('circle_eligible_verifiers');
    await s.db.query(`
      CREATE TYPE "CircleMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
      CREATE TYPE "FriendState" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');
      CREATE TABLE "CircleMember" (
        id text PRIMARY KEY,
        "userID" text NOT NULL,
        "circleID" text NOT NULL,
        status "CircleMemberStatus" NOT NULL DEFAULT 'PENDING',
        "createdAt" timestamp(3) NOT NULL
      );
      CREATE UNIQUE INDEX "CircleMember_userID_circleID_key"
        ON "CircleMember" ("userID", "circleID");
      CREATE INDEX "CircleMember_circleID_status_userID_idx"
        ON "CircleMember" ("circleID", status, "userID");
      CREATE TABLE "Friend" (
        id text PRIMARY KEY,
        "userID" text NOT NULL,
        "friendID" text NOT NULL,
        state "FriendState" NOT NULL DEFAULT 'PENDING'
      );
      -- 与本批 Friend 成对索引迁移（20261026000200）一致的终态。
      CREATE INDEX "Friend_userID_friendID_idx" ON "Friend" ("userID", "friendID");
      CREATE INDEX "Friend_friendID_userID_idx" ON "Friend" ("friendID", "userID");
    `);
  });

  afterAll(async () => {
    await s?.close();
  });

  beforeEach(async () => {
    await s.db.query('TRUNCATE "CircleMember", "Friend"');
  });

  it('intersects active members with accepted friends in either direction, by join order', async () => {
    await member('late-friend', '2026-03-01 00:00:00');
    await member('early-friend', '2026-01-01 00:00:00');
    await member('reverse-friend', '2026-02-01 00:00:00');
    await member('stranger', '2026-01-15 00:00:00');
    await friend('applicant', 'late-friend');
    await friend('applicant', 'early-friend');
    // 好友行里申请人在 friendID 一侧。
    await friend('reverse-friend', 'applicant');
    // 好友但不在这个圈里。
    await friend('applicant', 'outside-friend');

    expect(await eligible({})).toEqual([
      'early-friend',
      'reverse-friend',
      'late-friend',
    ]);
  });

  it('drops non-accepted friendships, inactive or other-circle members, and the excluded ids', async () => {
    await member('pending-friend', '2026-01-01 00:00:00');
    await member('withdrawn-friend', '2026-01-02 00:00:00');
    await member('inactive-member', '2026-01-03 00:00:00', {
      status: 'PENDING',
    });
    await member('other-circle', '2026-01-04 00:00:00', {
      circleID: 'circle-2',
    });
    await member('seated-verifier', '2026-01-05 00:00:00');
    await member('rejected-verifier', '2026-01-06 00:00:00');
    await member('applicant', '2026-01-07 00:00:00');
    await member('ok', '2026-01-08 00:00:00');
    await friend('applicant', 'pending-friend', 'PENDING');
    await friend('withdrawn-friend', 'applicant', 'WITHDRAWN');
    for (const id of [
      'inactive-member',
      'other-circle',
      'seated-verifier',
      'rejected-verifier',
      'ok',
    ]) {
      await friend('applicant', id);
    }
    // 自己和自己的脏数据行：CASE 取回申请人自己，被排除名单挡掉。
    await friend('applicant', 'applicant');

    expect(
      await eligible({
        excludedUserIds: ['seated-verifier', 'rejected-verifier', 'applicant'],
      }),
    ).toEqual(['ok']);
  });

  it('returns each member once even when the friendship is stored twice', async () => {
    await member('dup-friend', '2026-01-01 00:00:00');
    await friend('applicant', 'dup-friend');
    await friend('dup-friend', 'applicant');
    await friend('applicant', 'dup-friend');

    expect(await eligible({})).toEqual(['dup-friend']);
  });

  it('narrows from the applicant’s friendships instead of pulling every member', async () => {
    // 3000 人的大圈，申请人只有几个好友在里面。
    await s.db.query(`
      INSERT INTO "CircleMember" (id, "userID", "circleID", status, "createdAt")
      SELECT 'm-' || g, 'user-' || g, 'circle-1', 'ACTIVE', TIMESTAMP '2026-01-01' + (g || ' minutes')::interval
      FROM generate_series(1, 3000) g;
      INSERT INTO "CircleMember" (id, "userID", "circleID", status, "createdAt")
      SELECT 'o-' || g, 'user-' || g, 'circle-' || (g % 40 + 2), 'ACTIVE', TIMESTAMP '2026-01-01'
      FROM generate_series(1, 3000) g;
      INSERT INTO "Friend" (id, "userID", "friendID", state)
      SELECT 'fx-' || g, 'user-' || g, 'user-' || (g + 1), 'ACCEPTED'
      FROM generate_series(1, 5000) g;
      INSERT INTO "Friend" (id, "userID", "friendID", state) VALUES
        ('fa-1', 'applicant', 'user-10', 'ACCEPTED'),
        ('fa-2', 'user-20', 'applicant', 'ACCEPTED');
      ANALYZE "CircleMember"; ANALYZE "Friend";
    `);

    const q = eligibleVerifierIdsQuery({
      circleId: 'circle-1',
      callerId: 'applicant',
      excludedUserIds: ['applicant'],
    });
    const plan = await explainPlan(s.db, q.text, q.values);
    // 好友一侧两个方向各走一条成对索引；成员一侧不整表扫描。
    expect(plan).toContain('Friend_userID_friendID_idx');
    expect(plan).toContain('Friend_friendID_userID_idx');
    expect(plan).not.toMatch(
      /"Node Type":"Seq Scan"[^}]*"Relation Name":"CircleMember"/,
    );
    expect(await eligible({})).toEqual(['user-10', 'user-20']);
  });
});

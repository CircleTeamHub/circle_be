import {
  readScopeGenerations,
  readSessionVerificationLookup,
  sessionVerificationQuery,
} from 'src/auth/session-verification.query';
import {
  describePostgres,
  explainPlan,
  openIsolatedSchema,
  type IsolatedSchema,
} from './pg-test-db';

/**
 * 鉴权每请求那条合并查询(SessionVerifier.verifyInDatabase)的真库回归。
 *
 * 三张表只建判定用得到的列,但类型照迁移:状态/受众/吊销原因/作用域都是真枚举,
 * 这样 `::text` 转换和 `sg.scope = 'ACCOUNT'` 这类枚举比较走的是真实路径;主键与
 * SessionScopeGeneration 的唯一索引同名同列。迁移里还有一条单列 userId 索引,这里
 * 故意不建:表几乎是空的时候规划器会偏向那条更小的索引,两条都以 userId 打头,
 * 断言就只能写成「用了某个索引」,看不出唯一索引是否可用。
 */
const SCHEMA = [
  `CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BANNED', 'DELETED')`,
  `CREATE TYPE "RefreshTokenAudience" AS ENUM ('APP', 'ADMIN')`,
  `CREATE TYPE "RefreshTokenRevocationReason" AS ENUM (
    'ROTATED', 'SINGLE_DEVICE_REPLACED', 'LOGOUT', 'LOGOUT_ALL',
    'SESSION_REVOKED', 'OTHER_SESSIONS_REVOKED', 'TOKEN_FAMILY_REUSE'
  )`,
  `CREATE TYPE "SessionRevocationScope" AS ENUM (
    'ACCOUNT', 'AUDIENCE', 'DEVICE', 'FAMILY'
  )`,
  `CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessTokensRevokedAt" TIMESTAMP(3),
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "accountGeneration" INTEGER NOT NULL DEFAULT 0,
    "audienceGeneration" INTEGER NOT NULL DEFAULT 0,
    "deviceGeneration" INTEGER NOT NULL DEFAULT 0,
    "familyGeneration" INTEGER NOT NULL DEFAULT 0,
    "audience" "RefreshTokenAudience" NOT NULL DEFAULT 'APP',
    "deviceKey" TEXT,
    "accessRevokedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revocationReason" "RefreshTokenRevocationReason",
    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE "SessionScopeGeneration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "SessionRevocationScope" NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 0,
    "exemptFamilyId" TEXT,
    CONSTRAINT "SessionScopeGeneration_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX "SessionScopeGeneration_userId_scope_scopeKey_key"
    ON "SessionScopeGeneration"("userId", "scope", "scopeKey")`,
];

type GenerationSeed = [
  userId: string,
  scope: string,
  scopeKey: string,
  generation: number,
  exemptFamilyId: string | null,
];

/**
 * user-1 的每种作用域都有「该命中」和「不该命中」的行;user-2 用的是和 user-1
 * 会话完全相同的 scopeKey —— 混进来就说明 userId 条件丢了。
 */
const GENERATIONS: GenerationSeed[] = [
  ['user-1', 'ACCOUNT', '*', 5, 'family-1'],
  ['user-1', 'AUDIENCE', 'APP', 6, null],
  ['user-1', 'AUDIENCE', 'ADMIN', 7, null],
  ['user-1', 'DEVICE', 'device-1', 8, null],
  ['user-1', 'DEVICE', 'device-other', 9, null],
  ['user-1', 'DEVICE', '', 10, null],
  ['user-1', 'FAMILY', 'family-1', 11, null],
  ['user-1', 'FAMILY', 'family-2', 12, null],
  ['user-1', 'FAMILY', 'family-unrelated', 13, null],
  ['user-2', 'ACCOUNT', '*', 20, null],
  ['user-2', 'AUDIENCE', 'APP', 21, null],
  ['user-2', 'DEVICE', 'device-1', 22, null],
  ['user-2', 'FAMILY', 'family-1', 23, null],
];

type Generation = {
  scope: string;
  generation: number;
  exemptFamilyId: string | null;
};

function byScope(generations: Generation[]): Generation[] {
  return [...generations].sort((a, b) => a.scope.localeCompare(b.scope));
}

describePostgres('session verification lookup (PostgreSQL)', () => {
  let ctx: IsolatedSchema;

  beforeAll(async () => {
    ctx = await openIsolatedSchema('session_verify');
    for (const statement of SCHEMA) {
      await ctx.db.query(statement);
    }
    await ctx.db.query(`
      INSERT INTO "User" ("id", "status", "accessTokensRevokedAt") VALUES
        ('user-1', 'ACTIVE', NULL),
        ('user-2', 'ACTIVE', NULL),
        ('user-banned', 'BANNED', '2026-09-01 08:30:00')
    `);
    await ctx.db.query(`
      INSERT INTO "RefreshToken" (
        "id", "userId", "familyId", "audience", "deviceKey",
        "accountGeneration", "audienceGeneration", "deviceGeneration", "familyGeneration",
        "revokedAt", "revocationReason", "accessRevokedAt"
      ) VALUES
        ('session-1', 'user-1', 'family-1', 'APP', 'device-1', 1, 2, 3, 4, NULL, NULL, NULL),
        ('session-no-device', 'user-1', 'family-2', 'ADMIN', NULL, 0, 0, 0, 0, NULL, NULL, NULL),
        ('session-empty-device', 'user-1', 'family-2', 'ADMIN', '', 0, 0, 0, 0, NULL, NULL, NULL),
        ('session-rotated', 'user-1', 'family-1', 'APP', 'device-1', 0, 0, 0, 0,
          '2026-09-02 10:00:00', 'ROTATED', '2026-09-03 11:00:00'),
        ('session-of-user-2', 'user-2', 'family-1', 'APP', 'device-1', 0, 0, 0, 0, NULL, NULL, NULL)
    `);
    for (const [index, seed] of GENERATIONS.entries()) {
      await ctx.db.query(
        `INSERT INTO "SessionScopeGeneration"
           ("id", "userId", "scope", "scopeKey", "generation", "exemptFamilyId")
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`generation-${index}`, ...seed],
      );
    }
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /** 跑 src 里同一个构造器生成的 SQL;锚点子查询保证永远恰好一行。 */
  async function lookup(userId: string, sessionId: string | null) {
    const query = sessionVerificationQuery(userId, sessionId);
    const { rows } = await ctx.db.query<Record<string, unknown>>(
      query.text,
      query.values,
    );
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  it('returns user, session and the four matching scope generations in one row', async () => {
    const row = await lookup('user-1', 'session-1');

    expect(row).toMatchObject({
      userStatus: 'ACTIVE',
      accessTokensRevokedAt: null,
      sessionId: 'session-1',
      sessionUserId: 'user-1',
      revokedAt: null,
      revocationReason: null,
      accessRevokedAt: null,
      familyId: 'family-1',
      audience: 'APP',
      deviceKey: 'device-1',
      accountGeneration: 1,
      audienceGeneration: 2,
      deviceGeneration: 3,
      familyGeneration: 4,
    });
    // 四种作用域各命中一行;ACCOUNT 的豁免 family 原样带回;user-1 的
    // device-other / family-unrelated / AUDIENCE ADMIN 和 user-2 的同键行都不在。
    expect(byScope(row.generations as Generation[])).toEqual([
      { scope: 'ACCOUNT', generation: 5, exemptFamilyId: 'family-1' },
      { scope: 'AUDIENCE', generation: 6, exemptFamilyId: null },
      { scope: 'DEVICE', generation: 8, exemptFamilyId: null },
      { scope: 'FAMILY', generation: 11, exemptFamilyId: null },
    ]);
  });

  it('feeds the row parser the column names and value types it expects', async () => {
    const row = await lookup('user-1', 'session-1');
    const parsed = readSessionVerificationLookup([row]);

    expect(parsed.user).toEqual({
      status: 'ACTIVE',
      accessTokensRevokedAt: null,
    });
    expect(parsed.session).toEqual({
      userId: 'user-1',
      revokedAt: null,
      revocationReason: null,
      accessRevokedAt: null,
      familyId: 'family-1',
      audience: 'APP',
      deviceKey: 'device-1',
      accountGeneration: 1,
      audienceGeneration: 2,
      deviceGeneration: 3,
      familyGeneration: 4,
    });
    expect(byScope(readScopeGenerations(parsed.generations))).toEqual([
      { scope: 'ACCOUNT', generation: 5, exemptFamilyId: 'family-1' },
      { scope: 'AUDIENCE', generation: 6, exemptFamilyId: null },
      { scope: 'DEVICE', generation: 8, exemptFamilyId: null },
      { scope: 'FAMILY', generation: 11, exemptFamilyId: null },
    ]);
  });

  it('casts enums to text and returns timestamps for revoked rows', async () => {
    const row = await lookup('user-1', 'session-rotated');
    const banned = await lookup('user-banned', null);

    // node-postgres 把 timestamp without time zone 按本地时区解析(Prisma 按 UTC),
    // 所以这里用本地时间构造期望值;要验的是「是 Date 且是这一刻」,不是时区。
    expect(row).toMatchObject({
      revocationReason: 'ROTATED',
      revokedAt: new Date(2026, 8, 2, 10, 0, 0),
      accessRevokedAt: new Date(2026, 8, 3, 11, 0, 0),
    });
    expect(banned).toMatchObject({
      userStatus: 'BANNED',
      accessTokensRevokedAt: new Date(2026, 8, 1, 8, 30, 0),
    });
    expect(readSessionVerificationLookup([row]).session).toMatchObject({
      revocationReason: 'ROTATED',
      revokedAt: new Date(2026, 8, 2, 10, 0, 0),
    });
  });

  it('matches no DEVICE row when the session has no device key', async () => {
    const row = await lookup('user-1', 'session-no-device');

    expect(row.deviceKey).toBeNull();
    expect(byScope(row.generations as Generation[])).toEqual([
      { scope: 'ACCOUNT', generation: 5, exemptFamilyId: 'family-1' },
      { scope: 'AUDIENCE', generation: 7, exemptFamilyId: null },
      { scope: 'FAMILY', generation: 12, exemptFamilyId: null },
    ]);
  });

  it('treats an empty device key like a missing one, as the old truthy check did', async () => {
    const row = await lookup('user-1', 'session-empty-device');

    expect(row.deviceKey).toBe('');
    expect(
      (row.generations as Generation[]).map(({ scope }) => scope),
    ).not.toContain('DEVICE');
  });

  it('returns null user columns when the user does not exist', async () => {
    const withoutSession = await lookup('user-missing', null);
    const withSession = await lookup('user-missing', 'session-1');

    expect(withoutSession).toMatchObject({
      userStatus: null,
      accessTokensRevokedAt: null,
      sessionId: null,
      generations: [],
    });
    expect(readSessionVerificationLookup([withoutSession]).user).toBeNull();
    // 会话行照样带回(属于 user-1),verifier 先按用户不存在判 revoked;
    // generations 按 token 的 userId 过滤,不会拿 user-1 的行。
    expect(withSession).toMatchObject({
      userStatus: null,
      sessionUserId: 'user-1',
      generations: [],
    });
  });

  it('returns null session columns and no generations when the session row is gone', async () => {
    const row = await lookup('user-1', 'session-missing');

    expect(row).toMatchObject({
      userStatus: 'ACTIVE',
      sessionId: null,
      sessionUserId: null,
      familyId: null,
      audience: null,
      accountGeneration: null,
      generations: [],
    });
    expect(readSessionVerificationLookup([row]).session).toBeNull();
  });

  it('matches no session and fetches no generations when the session id is null', async () => {
    // user-1 有 ACCOUNT 行;没有会话时一行都不该取。
    const row = await lookup('user-1', null);

    expect(row).toMatchObject({
      userStatus: 'ACTIVE',
      sessionId: null,
      sessionUserId: null,
      generations: [],
    });
  });

  it("returns another user's session row as-is so the verifier can reject it", async () => {
    const row = await lookup('user-1', 'session-of-user-2');

    // 会话按主键取、不加 userId 条件:加了的话别人的 sid 会被当成「行已清理」放行。
    expect(row.sessionUserId).toBe('user-2');
    // generations 只按 token 的 userId 取:同样的键命中的是 user-1 的行,
    // user-2 的同键行(20-23)不在。
    expect(byScope(row.generations as Generation[])).toEqual([
      { scope: 'ACCOUNT', generation: 5, exemptFamilyId: 'family-1' },
      { scope: 'AUDIENCE', generation: 6, exemptFamilyId: null },
      { scope: 'DEVICE', generation: 8, exemptFamilyId: null },
      { scope: 'FAMILY', generation: 11, exemptFamilyId: null },
    ]);
  });

  it('reaches every table through its primary key or unique index', async () => {
    const query = sessionVerificationQuery('user-1', 'session-1');
    await ctx.db.query('SET enable_seqscan = off');
    try {
      const plan = await explainPlan(ctx.db, query.text, query.values);

      expect(plan).toContain('"Index Name":"User_pkey"');
      expect(plan).toContain('"Index Name":"RefreshToken_pkey"');
      expect(plan).toContain(
        '"Index Name":"SessionScopeGeneration_userId_scope_scopeKey_key"',
      );
      expect(plan).not.toContain('"Node Type":"Seq Scan"');
    } finally {
      await ctx.db.query('RESET enable_seqscan');
    }
  });
});

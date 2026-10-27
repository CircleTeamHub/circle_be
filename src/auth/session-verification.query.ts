import {
  Prisma,
  RefreshTokenAudience,
  SessionRevocationScope,
} from 'src/generated/prisma';

/**
 * SessionVerifier 的数据库判定一次取齐:账号状态、会话行、会话所属四个作用域的
 * 当前 generation。每个已登录的 HTTP 请求和 WebSocket 连接都走这里,原来是
 * 「用户 + 会话」并发两条再串行一条 generation,每请求两次往返、瞬间占两个池连接
 * (池默认 10);现在一条语句、一个连接。
 *
 * - 锚点 `(SELECT 1)` 保证永远恰好一行:用户或会话不存在时对应列是 NULL,
 *   而不是整行消失,两种「不存在」在调用方各有各的判法;
 * - 会话只按主键取,**不加** userId 条件。加了的话别人的 sid 会和「行已被清理」
 *   一样落空,而后者按账号状态放行 —— 那就成了拿别人 sid 的 token 也能过;
 * - sessionId 为 NULL 时 `s.id = NULL` 不成立,会话列全空,generation 也不取;
 * - generation 按 token 的 userId 过滤(调用方只在会话属于该用户时才用它),
 *   作用域与旧的 findMany OR 列表逐条对应。DEVICE 用 NULLIF 把空串当没有:
 *   旧代码是 `session.deviceKey ? … : []` 的真值判断,空串同样不查;
 * - 枚举一律 `::text` 带回,不在 SQL 里写类型名,免得依赖 search_path 解析类型。
 *
 * 三处都能走主键/唯一索引(SessionScopeGeneration 是 userId+scope+scopeKey 的
 * 唯一索引,行多时规划器拆成四路精确探测),见 test/postgres/session-verification.pg-spec.ts。
 */
export function sessionVerificationQuery(
  userId: string,
  sessionId: string | null,
): Prisma.Sql {
  return Prisma.sql`
    SELECT
      u."status"::text AS "userStatus",
      u."accessTokensRevokedAt",
      s."id" AS "sessionId",
      s."userId" AS "sessionUserId",
      s."revokedAt",
      s."revocationReason"::text AS "revocationReason",
      s."accessRevokedAt",
      s."familyId",
      s."audience"::text AS "audience",
      s."deviceKey",
      s."accountGeneration",
      s."audienceGeneration",
      s."deviceGeneration",
      s."familyGeneration",
      g."generations"
    FROM (SELECT 1) AS anchor
    LEFT JOIN "User" u ON u."id" = ${userId}
    LEFT JOIN "RefreshToken" s ON s."id" = ${sessionId}
    LEFT JOIN LATERAL (
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'scope', sg."scope"::text,
            'generation', sg."generation",
            'exemptFamilyId', sg."exemptFamilyId"
          )
        ),
        '[]'::json
      ) AS "generations"
      FROM "SessionScopeGeneration" sg
      WHERE s."id" IS NOT NULL
        AND sg."userId" = ${userId}
        AND (
          (sg."scope" = 'ACCOUNT' AND sg."scopeKey" = '*')
          OR (sg."scope" = 'AUDIENCE' AND sg."scopeKey" = s."audience"::text)
          OR (sg."scope" = 'DEVICE' AND sg."scopeKey" = NULLIF(s."deviceKey", ''))
          OR (sg."scope" = 'FAMILY' AND sg."scopeKey" = s."familyId")
        )
    ) g ON true
  `;
}

/**
 * sessionVerificationQuery 原样返回的一行,列名即 SQL 里的别名。LEFT JOIN 没命中时
 * 对应列是 NULL,所以全都可空;generations 是 json_agg 的结果,收窄前一律 unknown。
 * 下面的解析器按这个类型的键取列,测试里拼行的 fixture 也以它为类型 —— 改别名时
 * 三处由 tsc 和 test/postgres/session-verification.pg-spec.ts 一起兜住。
 */
export type SessionVerificationRow = {
  userStatus: string | null;
  accessTokensRevokedAt: Date | null;
  sessionId: string | null;
  sessionUserId: string | null;
  revokedAt: Date | null;
  revocationReason: string | null;
  accessRevokedAt: Date | null;
  familyId: string | null;
  audience: string | null;
  deviceKey: string | null;
  accountGeneration: number | null;
  audienceGeneration: number | null;
  deviceGeneration: number | null;
  familyGeneration: number | null;
  generations: unknown;
};

export type SessionVerificationUser = {
  /** 原样字符串:调用方只比较是否 ACTIVE,未知值自然落到 revoked。 */
  status: string;
  accessTokensRevokedAt: Date | null;
};

export type SessionVerificationSession = {
  userId: string;
  revokedAt: Date | null;
  /** 同上,只和 ROTATED 比较。 */
  revocationReason: string | null;
  accessRevokedAt: Date | null;
  familyId: string;
  audience: RefreshTokenAudience;
  deviceKey: string | null;
  accountGeneration: number;
  audienceGeneration: number;
  deviceGeneration: number;
  familyGeneration: number;
};

export type ScopeGeneration = {
  scope: SessionRevocationScope;
  generation: number;
  exemptFamilyId: string | null;
};

export type SessionVerificationLookup = {
  user: SessionVerificationUser | null;
  session: SessionVerificationSession | null;
  /**
   * 原样保留:旧实现只在会话各项检查都通过后才查 generation,这里一并取回,
   * 但也要等到那时才用 readScopeGenerations 收窄 —— 前面的检查已经判了
   * revoked 的话,这一列再怎么异常也不该改变结论。
   */
  generations: unknown;
};

/**
 * 行形状不对(驱动类型映射变了、列名和 SQL 对不上)。调用方按「数据库答不上来」
 * 处理成 unavailable,与查询报错同一出口。信息里只有列名,不带值(值里有用户/会话 id)。
 */
export class SessionVerificationRowError extends Error {
  constructor(column: string, expected: string) {
    super(`session verification row: ${column} is not ${expected}`);
    this.name = 'SessionVerificationRowError';
  }
}

const AUDIENCES: readonly string[] = Object.values(RefreshTokenAudience);
const SCOPES: readonly string[] = Object.values(SessionRevocationScope);

/** 只知道有哪些列、还不知道值类型的视图:读列时列名受键约束,写错过不了 tsc。 */
type Unparsed<T> = { readonly [K in keyof T]: unknown };

type ScopeGenerationEntry = Unparsed<ScopeGeneration>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString<R>(row: R, column: keyof R & string): string {
  const value: unknown = row[column];
  if (typeof value !== 'string') {
    throw new SessionVerificationRowError(column, 'a string');
  }
  return value;
}

function readNullableString<R>(
  row: R,
  column: keyof R & string,
): string | null {
  const value: unknown = row[column];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new SessionVerificationRowError(column, 'a string or null');
  }
  return value;
}

function readNullableDate<R>(row: R, column: keyof R & string): Date | null {
  const value: unknown = row[column];
  if (value === null) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new SessionVerificationRowError(column, 'a Date or null');
  }
  return value;
}

function readInteger<R>(row: R, column: keyof R & string): number {
  const value: unknown = row[column];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SessionVerificationRowError(column, 'an integer');
  }
  return value;
}

/**
 * 收窄 sessionVerificationQuery 的结果。user / session 为 null 表示那张表没命中
 * (status、会话主键都是 NOT NULL 列,为 NULL 只可能是 LEFT JOIN 落空)。
 */
export function readSessionVerificationLookup(
  rows: unknown,
): SessionVerificationLookup {
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) {
    throw new SessionVerificationRowError('result', 'exactly one row');
  }
  // 缺列在运行时是 undefined,上面的读取函数一律当形状错误,不会悄悄当成 NULL。
  const row = rows[0] as Unparsed<SessionVerificationRow>;

  const status = readNullableString(row, 'userStatus');
  const user: SessionVerificationUser | null =
    status === null
      ? null
      : {
          status,
          accessTokensRevokedAt: readNullableDate(row, 'accessTokensRevokedAt'),
        };

  let session: SessionVerificationSession | null = null;
  if (readNullableString(row, 'sessionId') !== null) {
    const audience = readString(row, 'audience');
    if (!AUDIENCES.includes(audience)) {
      throw new SessionVerificationRowError('audience', 'a known audience');
    }
    session = {
      userId: readString(row, 'sessionUserId'),
      revokedAt: readNullableDate(row, 'revokedAt'),
      revocationReason: readNullableString(row, 'revocationReason'),
      accessRevokedAt: readNullableDate(row, 'accessRevokedAt'),
      familyId: readString(row, 'familyId'),
      audience: audience as RefreshTokenAudience,
      deviceKey: readNullableString(row, 'deviceKey'),
      accountGeneration: readInteger(row, 'accountGeneration'),
      audienceGeneration: readInteger(row, 'audienceGeneration'),
      deviceGeneration: readInteger(row, 'deviceGeneration'),
      familyGeneration: readInteger(row, 'familyGeneration'),
    };
  }

  return { user, session, generations: row.generations };
}

/**
 * json_agg 出来的 generation 列表当外部数据收窄:作用域只能是四个枚举值之一,
 * generation 必须是整数 —— 否则旧的 `generation !== snapshots[scope]` 比较会
 * 拿 undefined 去比,结论不可预期。
 */
export function readScopeGenerations(value: unknown): ScopeGeneration[] {
  if (!Array.isArray(value)) {
    throw new SessionVerificationRowError('generations', 'an array');
  }
  return value.map((entry: unknown): ScopeGeneration => {
    if (!isRecord(entry)) {
      throw new SessionVerificationRowError('generations[]', 'an object');
    }
    const fields = entry as ScopeGenerationEntry;
    const scope = fields.scope;
    if (typeof scope !== 'string' || !SCOPES.includes(scope)) {
      throw new SessionVerificationRowError(
        'generations[].scope',
        'a known scope',
      );
    }
    return {
      scope: scope as SessionRevocationScope,
      generation: readInteger(fields, 'generation'),
      exemptFamilyId: readNullableString(fields, 'exemptFamilyId'),
    };
  });
}

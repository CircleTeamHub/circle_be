import type { SessionVerificationRow } from '../session-verification.query';

/**
 * 单元测试里冒充 sessionVerificationQuery 的结果。返回值以 SessionVerificationRow
 * 为类型:SQL 别名一改,解析器和这里都过不了 tsc,不会出现「测试拼的行和真查询
 * 对不上、测试却照样绿」。真实 SQL 的行为由 test/postgres/session-verification.pg-spec.ts
 * 在真库上守着,这里只负责拼形状。
 *
 * 驱动真 SessionVerifier 的 spec 都用它:session-verifier / refresh-token /
 * realtime.gateway。
 */

export type RowUser = {
  status: string;
  accessTokensRevokedAt?: Date | null;
};

/** 结构上兼容 RefreshToken 行,内存里的会话记录可以直接传进来。 */
export type RowSession = {
  id: string;
  userId: string;
  familyId: string;
  audience: string;
  deviceKey?: string | null;
  revokedAt?: Date | null;
  revocationReason?: string | null;
  accessRevokedAt?: Date | null;
  accountGeneration?: number;
  audienceGeneration?: number;
  deviceGeneration?: number;
  familyGeneration?: number;
};

export type RowScopeGeneration = {
  userId?: string;
  scope: string;
  scopeKey?: string;
  generation: number;
  exemptFamilyId?: string | null;
};

/**
 * 拼一行结果:没命中的表对应列全是 NULL(LEFT JOIN),generation 只在有会话时才有。
 * 快照列缺省 0,与表上的 DEFAULT 0 一致。
 */
export function sessionVerificationRow(
  user: RowUser | null,
  session: RowSession | null,
  generations: RowScopeGeneration[] = [],
): SessionVerificationRow {
  return {
    userStatus: user?.status ?? null,
    accessTokensRevokedAt: user?.accessTokensRevokedAt ?? null,
    sessionId: session?.id ?? null,
    sessionUserId: session?.userId ?? null,
    revokedAt: session?.revokedAt ?? null,
    revocationReason: session?.revocationReason ?? null,
    accessRevokedAt: session?.accessRevokedAt ?? null,
    familyId: session?.familyId ?? null,
    audience: session?.audience ?? null,
    deviceKey: session?.deviceKey ?? null,
    accountGeneration: session ? (session.accountGeneration ?? 0) : null,
    audienceGeneration: session ? (session.audienceGeneration ?? 0) : null,
    deviceGeneration: session ? (session.deviceGeneration ?? 0) : null,
    familyGeneration: session ? (session.familyGeneration ?? 0) : null,
    generations: session
      ? generations.map(({ scope, generation, exemptFamilyId }) => ({
          scope,
          generation,
          exemptFamilyId: exemptFamilyId ?? null,
        }))
      : [],
  };
}

/**
 * SQL 里 LATERAL 那段过滤的内存版,给拿内存表驱动真 SessionVerifier 的 spec 用:
 * 只要 token 那个 userId 的行,作用域与会话一一对应,deviceKey 为空(含空串)时
 * 不取 DEVICE。
 */
export function matchingScopeGenerations(
  userId: string,
  session: RowSession | null,
  rows: Iterable<RowScopeGeneration>,
): RowScopeGeneration[] {
  if (session === null) return [];
  const wanted = [
    { scope: 'ACCOUNT', scopeKey: '*' },
    { scope: 'AUDIENCE', scopeKey: session.audience },
    ...(session.deviceKey
      ? [{ scope: 'DEVICE', scopeKey: session.deviceKey }]
      : []),
    { scope: 'FAMILY', scopeKey: session.familyId },
  ];
  return [...rows].filter(
    (row) =>
      row.userId === userId &&
      wanted.some(
        ({ scope, scopeKey }) =>
          row.scope === scope && row.scopeKey === scopeKey,
      ),
  );
}

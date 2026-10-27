import { Prisma, ReferralStatus } from 'src/generated/prisma';

/**
 * 邀请管理两处关键词搜索(admin-invite.service campaigns / referrals,search 非空时)。
 *
 * 原 Prisma 查询把 owner / inviter / invitee 的账号写成 OR 里的关系条件,Prisma 7
 * 编译成 LEFT JOIN User 之后的跨表 OR,哪支都用不上 trigram 索引,findMany 和 count
 * 各整表扫一遍。这里改成「各个可索引的分支分别取 id,再 UNION」,只返回当前页的 id
 * 和 total,行数据由调用方按 id 回查。
 *
 * 口径与原查询一致(真库逐页对照:test/postgres/admin-search-union.pg-spec.ts):
 * - Prisma 的 `contains + insensitive` 编译成 `ILIKE ('%' || $n || '%')`,不转义 % 和 _,
 *   这里照原样保留,不改变已有的匹配结果;
 * - 排序 createdAt DESC, id DESC。
 */
/** column 只接受本文件里写死的列名;search 走参数绑定。 */
const ilike = (column: string, search: string) =>
  Prisma.sql`${Prisma.raw(column)} ILIKE ('%' || ${search} || '%')`;

// ─── 活动邀请码 ──────────────────────────────────────────────────────────────

/** code / name 两条 trigram 一支,发起人账号(User trigram → ownerUserID 索引)一支。 */
function campaignSearchWhere(search: string) {
  return Prisma.sql`WHERE c."id" IN (
    SELECT own."id" FROM "CampaignInvite" own
    WHERE ${ilike('own."code"', search)}
       OR ${ilike('own."name"', search)}
    UNION
    SELECT owned."id" FROM "CampaignInvite" owned
    JOIN "User" u ON u."id" = owned."ownerUserID"
    WHERE ${ilike('u."accountId"', search)}
  )`;
}

export function buildCampaignSearchPageQuery(input: {
  search: string;
  limit: number;
  offset: number;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT c."id" FROM "CampaignInvite" c
    ${campaignSearchWhere(input.search)}
    ORDER BY c."createdAt" DESC, c."id" DESC
    LIMIT ${input.limit} OFFSET ${input.offset}`;
}

export function buildCampaignSearchCountQuery(input: {
  search: string;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::int AS "total" FROM "CampaignInvite" c
    ${campaignSearchWhere(input.search)}`;
}

// ─── 邀请关系 ────────────────────────────────────────────────────────────────

export type ReferralSearchFilter = {
  search: string;
  status?: ReferralStatus;
  /** 被邀请人通过哪个活动码注册(CampaignInviteUse.userID 唯一,至多一行)。 */
  campaignID?: string;
};

/**
 * 邀请人一支(User trigram → Referral_inviterID_createdAt_idx),被邀请人一支
 * (User trigram → inviteeID 唯一键)。status / campaignID 与原查询一样是 AND 条件。
 */
function referralSearchWhere({
  search,
  status,
  campaignID,
}: ReferralSearchFilter) {
  const matching = Prisma.sql`
    SELECT byInviter."id" FROM "Referral" byInviter
    JOIN "User" inviter ON inviter."id" = byInviter."inviterID"
    WHERE ${ilike('inviter."accountId"', search)}
    UNION
    SELECT byInvitee."id" FROM "Referral" byInvitee
    JOIN "User" invitee ON invitee."id" = byInvitee."inviteeID"
    WHERE ${ilike('invitee."accountId"', search)}`;
  const statusFilter = status
    ? Prisma.sql`AND r."status" = ${status}::"ReferralStatus"`
    : Prisma.empty;
  const campaignFilter = campaignID
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM "CampaignInviteUse" used
        WHERE used."userID" = r."inviteeID" AND used."campaignID" = ${campaignID}
      )`
    : Prisma.empty;
  return Prisma.sql`WHERE r."id" IN (${matching}) ${statusFilter} ${campaignFilter}`;
}

export function buildReferralSearchPageQuery(
  input: ReferralSearchFilter & { limit: number; offset: number },
): Prisma.Sql {
  return Prisma.sql`
    SELECT r."id" FROM "Referral" r
    ${referralSearchWhere(input)}
    ORDER BY r."createdAt" DESC, r."id" DESC
    LIMIT ${input.limit} OFFSET ${input.offset}`;
}

export function buildReferralSearchCountQuery(
  input: ReferralSearchFilter,
): Prisma.Sql {
  return Prisma.sql`
    SELECT COUNT(*)::int AS "total" FROM "Referral" r
    ${referralSearchWhere(input)}`;
}

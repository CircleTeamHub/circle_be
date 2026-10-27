import { Prisma } from 'src/generated/prisma';
import type { FeedCursor } from 'src/utils/feed-cursor';

/**
 * 朋友圈 feed 的一页：每个可见作者各取前 N 条，再合并取前 N 条。
 *
 * 此前是 trace.findMany({ where: { fromID: { in: 最多 5001 个作者 }, ... },
 * orderBy: [createdAt desc, id desc], take })。Trace ("fromID", "createdAt" DESC,
 * "id" DESC) 对单个作者是现成的有序索引，但 PostgreSQL 没有跨 IN 列表的有序归并：
 * 只能把这些作者的**全部**动态读出来再做 Top-N 排序；键集条件也只能当过滤，翻到
 * 第 2 页以后的开销和第 1 页同阶 —— 好友越多、发得越多，每一页都越慢。
 *
 * 这里逐个作者做一次 LATERAL 索引扫描：WHERE "fromID" = 作者 AND 游标之后，按
 * ("createdAt" DESC, "id" DESC) 读到 N 条就停；外层只对「作者数 × N」行排序取前 N。
 * 全局前 N 条一定落在各作者自己的前 N 条之内，所以结果与原查询逐行一致：
 * - 可见性条件原样照搬：deleted = false，且「作者是 viewer 本人」或 FRIENDS_ONLY /
 *   PUBLIC（PRIVATE 只有作者本人看得见）；
 * - 排序键 ("createdAt" DESC, "id" DESC)，id 是主键，同一时刻的行次序也唯一确定；
 * - 游标 ("createdAt", "id") < (游标) 与 feedCursorWhere 的
 *   createdAt < c OR (createdAt = c AND id < i) 等价（两列都非空），写成行比较才能
 *   落进索引条件、从游标处开始扫，而不是从头读再过滤；
 * - 老客户端的页码模式：每个作者取前 offset + take 条，外层 OFFSET offset LIMIT take。
 *
 * 作者 id 先去重：IN 列表天然去重，unnest 不会 —— 脏数据里重复的好友行会让同一个
 * 作者展开两次，动态就会重复出现。
 *
 * 只返回 id：整行与作者资料由调用方按主键用 Prisma 回填，DTO 与原先同一个形状。
 */
export type TraceFeedPageScan = {
  viewerId: string;
  authorIds: readonly string[];
  cursor: FeedCursor | null;
  /** 页码模式跳过的行数；游标模式恒为 0。 */
  offset: number;
  /** 这一页要的行数（游标模式由调用方多加一行判断 hasMore）。 */
  take: number;
};

export type TraceFeedPageRow = { id: string };

export function traceFeedPageQuery(scan: TraceFeedPageScan): Prisma.Sql {
  const authorIds = [...new Set(scan.authorIds)];
  const keyset = scan.cursor
    ? Prisma.sql`AND (t."createdAt", t."id") < (${scan.cursor.createdAt}, ${scan.cursor.id})`
    : Prisma.empty;
  return Prisma.sql`
    SELECT page."id"
    FROM unnest(${authorIds}::text[]) AS author("id")
    CROSS JOIN LATERAL (
      SELECT t."id", t."createdAt"
      FROM "Trace" AS t
      WHERE t."fromID" = author."id"
        AND t."deleted" = false
        AND (t."fromID" = ${scan.viewerId}
             OR t."visibility" IN ('FRIENDS_ONLY', 'PUBLIC'))
        ${keyset}
      ORDER BY t."createdAt" DESC, t."id" DESC
      LIMIT ${scan.offset + scan.take}
    ) AS page
    ORDER BY page."createdAt" DESC, page."id" DESC
    LIMIT ${scan.take}
    ${scan.offset > 0 ? Prisma.sql`OFFSET ${scan.offset}` : Prisma.empty}
  `;
}

/**
 * feed 用的好友范围：viewer 的已接受好友（按 updatedAt 倒序最多 limit 个），以及
 * 其中哪些人只给了 viewer CHAT_ONLY（他们的动态对 viewer 隐藏）。
 *
 * 此前是两次 Friend 读取：先按 updatedAt 倒序取 limit 行算好友 id，再拿这至多 5000 个
 * id 做 IN 列表把同一批关系行再读一遍，只为看 permissionA / permissionB。这里一次读完：
 * - 好友 id 的口径不变：两侧任一是 viewer、state = ACCEPTED，ORDER BY "updatedAt" DESC
 *   LIMIT limit（原查询在 updatedAt 相同的边界上本来就不保证取哪几行）；
 * - chatOnly 读「对方那一侧」的授权：viewer 在 userID 一侧看 permissionB，在 friendID
 *   一侧看 permissionA。窗口函数 bool_or 按好友分区、在 LIMIT 之前对 viewer 与他之间
 *   的**全部**已接受关系行求或 —— 与原第二次查询（不设上限地按 IN 列表读这些人的所有
 *   关系行，任一行 CHAT_ONLY 即算）一致，脏数据里同一对人的重复行也照算。
 *
 * viewer 自己（自己加自己的脏行）也会出现在结果里；调用方与原实现一样不对本人做
 * chatOnly 判断。
 */
export type MomentFriendScopeRow = { friendId: string; chatOnly: boolean };

export function momentFriendScopeQuery(
  viewerId: string,
  limit: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT scope."friendId", scope."chatOnly"
    FROM (
      SELECT
        CASE WHEN f."userID" = ${viewerId} THEN f."friendID" ELSE f."userID" END
          AS "friendId",
        bool_or(
          CASE WHEN f."userID" = ${viewerId}
               THEN f."permissionB" ELSE f."permissionA" END = 'CHAT_ONLY'
        ) OVER (
          PARTITION BY
            CASE WHEN f."userID" = ${viewerId} THEN f."friendID" ELSE f."userID" END
        ) AS "chatOnly",
        f."updatedAt"
      FROM "Friend" AS f
      WHERE (f."userID" = ${viewerId} OR f."friendID" = ${viewerId})
        AND f."state" = 'ACCEPTED'
    ) AS scope
    ORDER BY scope."updatedAt" DESC
    LIMIT ${limit}
  `;
}

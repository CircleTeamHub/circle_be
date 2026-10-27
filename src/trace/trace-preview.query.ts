import { Prisma } from 'src/generated/prisma';

/**
 * 朋友圈 feed / 详情里每条动态的点赞预览与评论预览：每条动态只取最新的 N 条。
 *
 * 此前写成 trace.findMany 的嵌套 include（likeStats / comments 各带 take）。Prisma 7
 * 对嵌套关系的 take 不生成 LIMIT —— SQL 把这一页所有动态的**全部**点赞、全部评论读出来，
 * 再分别按 id 嵌套查 user 和 replyTo，最后在内存里每条截 N 条。热门动态有几千个赞、
 * 几百条评论时，一页 feed 就要搬几万行。
 *
 * 这里用 LATERAL 子查询逐条动态取前 N 条，LIMIT 在 SQL 里；作者昵称、被回复评论的 id
 * 与被回复人昵称在同一条语句里 JOIN 出来（只为留下的那 N 条）。
 *
 * 索引（迁移 20261026000530_trace_preview_indexes）：
 * - 评论走 TraceComment ("traceID", "createdAt")：按动态取最新评论是一次倒序索引扫描，
 *   跳过已删的、凑够 N 条就停；
 * - 点赞走部分索引 traceLikeStat ("traceID", "updatedAt") WHERE "deleted" = false ——
 *   下面的 "deleted" = false 必须是字面量、与索引谓词一字不差。
 *
 * 口径与原嵌套查询一致：评论只滤 deleted（不看 private），replyTo 指向的父评论即使已删
 * 也照样返回 id 与昵称；点赞按 updatedAt 倒序、评论按 createdAt 倒序（id 只用来给同一
 * 时刻的行定个稳定次序）。外层 ORDER BY 让同一条动态的行连续且保持倒序，调用方按
 * traceID 分组即可。
 */

/** 一条点赞预览：点赞人 id 与昵称。 */
export type TraceLikePreviewRow = {
  traceID: string;
  userID: string;
  userNickname: string;
};

/** 一条评论预览：映射成 TraceCommentDto 需要的全部列。 */
export type TraceCommentPreviewRow = {
  id: string;
  traceID: string;
  userID: string;
  content: string;
  images: string[];
  createdAt: Date;
  userNickname: string;
  /** 被回复的父评论 id；父评论行不存在时为 null。 */
  replyToID: string | null;
  /** 父评论作者的昵称；父评论不存在时为 null（昵称列本身非空）。 */
  replyToNickname: string | null;
};

export function traceLikePreviewQuery(
  traceIds: readonly string[],
  limitPerTrace: number,
): Prisma.Sql {
  const ids = [...traceIds];
  return Prisma.sql`
    SELECT preview."traceID", preview."userID", liker."nickname" AS "userNickname"
    FROM unnest(${ids}::text[]) AS trace("id")
    CROSS JOIN LATERAL (
      SELECT stat."id", stat."traceID", stat."userID", stat."updatedAt"
      FROM "traceLikeStat" AS stat
      WHERE stat."traceID" = trace."id"
        AND stat."deleted" = false
      ORDER BY stat."updatedAt" DESC, stat."id" DESC
      LIMIT ${limitPerTrace}
    ) AS preview
    JOIN "User" AS liker ON liker."id" = preview."userID"
    ORDER BY preview."traceID", preview."updatedAt" DESC, preview."id" DESC
  `;
}

export function traceCommentPreviewQuery(
  traceIds: readonly string[],
  limitPerTrace: number,
): Prisma.Sql {
  const ids = [...traceIds];
  return Prisma.sql`
    SELECT preview."id", preview."traceID", preview."userID", preview."content",
           preview."images", preview."createdAt",
           author."nickname" AS "userNickname",
           parent."id" AS "replyToID",
           parent_author."nickname" AS "replyToNickname"
    FROM unnest(${ids}::text[]) AS trace("id")
    CROSS JOIN LATERAL (
      SELECT tc."id", tc."traceID", tc."userID", tc."content",
             tc."images", tc."createdAt", tc."replyToID"
      FROM "TraceComment" AS tc
      WHERE tc."traceID" = trace."id"
        AND tc."deleted" = false
      ORDER BY tc."createdAt" DESC, tc."id" DESC
      LIMIT ${limitPerTrace}
    ) AS preview
    JOIN "User" AS author ON author."id" = preview."userID"
    LEFT JOIN "TraceComment" AS parent ON parent."id" = preview."replyToID"
    LEFT JOIN "User" AS parent_author ON parent_author."id" = parent."userID"
    ORDER BY preview."traceID", preview."createdAt" DESC, preview."id" DESC
  `;
}

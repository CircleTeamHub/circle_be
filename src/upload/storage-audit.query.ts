import { Prisma } from 'src/generated/prisma';

/**
 * 存量对象盘点对聊天媒体的引用判定：从「把引用全读进内存」反转成「按 S3 列举的一批
 * key 反查是否被引用」。
 *
 * 原来按 id 顺序扫 ChatMessage / ChatBurnArchive 里所有媒体类型的行（type 只能当过滤，
 * 等于按主键随机读整张最大的表），把 content 里的 key / thumbKey 全放进一个 Set ——
 * 聊天媒体越多，05:00 这一刻占的内存越大。
 *
 * 判定口径不变（StorageAuditService.collectReferencedKeys 原来的规则）：
 * 「某个对象 K 被引用」⇔ 存在一行 type ∈ CHAT_MEDIA_KEY_FIELDS 的消息 / 焚毁归档
 * （消息不论 deleted），它的某个字段（image/video: key、thumbKey；voice/file: key）
 * 是非空字符串 v，且 toObjectKey(v) = K。拆成两部分：
 *
 * 1. 规整的引用（chatMediaKeyReferencesQuery）：活消息（deleted = false）与焚毁归档里
 *    以 'chat/' 开头的值。这种值 toObjectKey(v) = v（没有协议头、不以 / 开头，
 *    new URL 解析失败、也不以任何 http(s) 公共前缀开头），判定就是 v = K —— 正好落在
 *    迁移 20261019000300 的四条表达式部分索引上，按一批 key 逐个探测。WHERE 里的
 *    deleted = false、type IN (...)、IS NOT NULL 都是为了与索引谓词逐字一致（Prisma 的
 *    参数化 type 列表证明不了部分索引）。S3 的 key 都以审计前缀开头，非字符串 JSON 值的
 *    文本（数字、true、{...}、[...]）不可能等于它。
 * 2. 不规整的引用（chatMediaIrregularRowsQuery / chatBurnArchiveIrregularRowsQuery）：
 *    带着 key 的墓碑（deleted = true；正常焚毁会清空 content，这里兜住历史/意外数据）、
 *    不以 'chat/' 开头的值（URL、前导 /、早期别的前缀……）。这些行由迁移
 *    20261026000900 的部分索引兜住（正常情况下一行都没有），按 id 游标读出来，
 *    在 JS 里照原规则 toObjectKey 后放进 Set —— 内存只与这些异常行成正比。
 *
 * 两部分的并集恰好是原来的引用集合。改这里的谓词必须同步改迁移
 * （test/postgres/storage-audit-reverse.pg-spec.ts 会拦）。
 */

/** 规整引用的前缀，与 CHAT_MEDIA_KEY_PREFIX 一致（spec 钉着）。 */
export const REGULAR_CHAT_MEDIA_KEY_PREFIX = 'chat/';

export type ChatMediaKeyReferenceRow = { key: string };

export function chatMediaKeyReferencesQuery(
  keys: readonly string[],
): Prisma.Sql {
  const wanted = [...keys];
  return Prisma.sql`
    SELECT m."content" ->> 'key' AS "key"
    FROM "ChatMessage" AS m
    WHERE m."deleted" = false
      AND m."type" IN ('image', 'video', 'voice', 'file')
      AND (m."content" ->> 'key') IS NOT NULL
      AND (m."content" ->> 'key') = ANY(${wanted}::text[])
    UNION
    SELECT m."content" ->> 'thumbKey'
    FROM "ChatMessage" AS m
    WHERE m."deleted" = false
      AND m."type" IN ('image', 'video')
      AND (m."content" ->> 'thumbKey') IS NOT NULL
      AND (m."content" ->> 'thumbKey') = ANY(${wanted}::text[])
    UNION
    SELECT a."content" ->> 'key'
    FROM "ChatBurnArchive" AS a
    WHERE a."type" IN ('image', 'video', 'voice', 'file')
      AND (a."content" ->> 'key') IS NOT NULL
      AND (a."content" ->> 'key') = ANY(${wanted}::text[])
    UNION
    SELECT a."content" ->> 'thumbKey'
    FROM "ChatBurnArchive" AS a
    WHERE a."type" IN ('image', 'video')
      AND (a."content" ->> 'thumbKey') IS NOT NULL
      AND (a."content" ->> 'thumbKey') = ANY(${wanted}::text[])
  `;
}

export type ChatMediaContentRow = {
  id: string;
  type: string;
  content: unknown;
};

/**
 * 规整引用之外的聊天消息（谓词与 ChatMessage_audit_irregular_media_idx 逐字一致）。
 */
export function chatMediaIrregularRowsQuery(
  cursor: string | undefined,
  take: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT m."id", m."type", m."content"
    FROM "ChatMessage" AS m
    WHERE m."type" IN ('image', 'video', 'voice', 'file')
      AND (
        (m."deleted" = true
          AND ((m."content" ->> 'key') IS NOT NULL
               OR (m."content" ->> 'thumbKey') IS NOT NULL))
        OR left(m."content" ->> 'key', 5) <> 'chat/'
        OR left(m."content" ->> 'thumbKey', 5) <> 'chat/'
      )
      ${cursor === undefined ? Prisma.empty : Prisma.sql`AND m."id" > ${cursor}`}
    ORDER BY m."id"
    LIMIT ${take}
  `;
}

/**
 * 规整引用之外的焚毁归档（谓词与 ChatBurnArchive_audit_irregular_media_idx 逐字一致）。
 */
export function chatBurnArchiveIrregularRowsQuery(
  cursor: string | undefined,
  take: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT a."id", a."type", a."content"
    FROM "ChatBurnArchive" AS a
    WHERE a."type" IN ('image', 'video', 'voice', 'file')
      AND (
        left(a."content" ->> 'key', 5) <> 'chat/'
        OR left(a."content" ->> 'thumbKey', 5) <> 'chat/'
      )
      ${cursor === undefined ? Prisma.empty : Prisma.sql`AND a."id" > ${cursor}`}
    ORDER BY a."id"
    LIMIT ${take}
  `;
}

export type NoteCardSectionsRow = {
  id: string;
  contactItems: unknown;
  groupItems: unknown;
};

/**
 * Note.sections 里个人 / 群名片的条目（冻结的头像 url 在里面），按 id 游标分批。
 * 原来整列 sections 搬回来（含正文、contentJson 副本、媒体条目），只为读这两个数组。
 * -> 链上任一层不是对象、items 不是数组都得到 NULL，与原来逐层的类型判断一致；
 * 条目本身是否对象、faceURL / avatarUrl 是否字符串仍由调用方照原规则判断。
 */
export function noteCardSectionsPageQuery(
  cursor: string | undefined,
  take: number,
): Prisma.Sql {
  return Prisma.sql`
    SELECT n."id",
           CASE WHEN jsonb_typeof(s."contacts" -> 'items') = 'array'
                THEN s."contacts" -> 'items'
           END AS "contactItems",
           CASE WHEN jsonb_typeof(s."groups" -> 'items') = 'array'
                THEN s."groups" -> 'items'
           END AS "groupItems"
    FROM "Note" AS n
    LEFT JOIN LATERAL jsonb_to_record(
      CASE WHEN jsonb_typeof(n."sections") = 'object' THEN n."sections" END
    ) AS s("contacts" jsonb, "groups" jsonb) ON true
    ${cursor === undefined ? Prisma.empty : Prisma.sql`WHERE n."id" > ${cursor}`}
    ORDER BY n."id"
    LIMIT ${take}
  `;
}

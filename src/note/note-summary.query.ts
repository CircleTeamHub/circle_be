import { Prisma, type NoteMediaType } from 'src/generated/prisma';

/**
 * 笔记列表摘要（listNotes / listDeletedNotes / 公开的 resolveShareLink）要的派生字段，
 * 按这一页的笔记 id 在 SQL 里算好再带回来。
 *
 * 此前三条列表都 include NOTE_INCLUDE：正文最多 2 万字、contentJson、sections（里面还有
 * 一份 contentJson 的副本）、每条最多 50 条 media 整行搬回 Node，一页最多 500 条；再把
 * 每条笔记的全部 media、poster、sections 里的条目都签一遍名，深度遍历整份 contentJson
 * 只为算出 hasText。摘要实际只用到：
 * - contentPreview：正文压缩空白后的前 120 个字符 —— 这里只取正文开头
 *   left(content, NOTE_SUMMARY_CONTENT_HEAD)，调用方在 JS 里用原来的规则压缩；开头几乎
 *   全是空白、定不出预览时再补读整段（见 NoteService.summarizeContentHead）；
 * - hasText：分区里存的正文是字符串就看它（btrim 用 JS trim 认的同一组空白字符），否则看
 *   Note.content（由调用方从开头判断）；或者正文块数组里至少有一个对象元素（原来
 *   resolvePublishedBlocks 丢掉非对象块后长度 > 0）；
 * - showcaseCount：分区里显式的 showcase.items 的长度；否则显式 media.items 时为 0；
 *   都没有时数这条笔记的 IMAGE 媒体 —— 与 buildSectionsFromRow 的回退顺序一致；
 * - contactItems / groupItems：分区里显式的名片数组原样带回（调用方照旧过滤对象元素、
 *   补圈子 id、截前 3 张）；没有显式数组时为 NULL；
 * - hasLocation：分区里 location 是对象；
 * - 封面：coverMediaID 指向的媒体是 IMAGE 就用它，否则这条笔记 sortOrder 最小的 IMAGE
 *   （(noteID, sortOrder) 唯一，不会并列）。coverNoteID 让调用方只给属于这条笔记的封面
 *   签名（原来只签 note.media 里的 url）。
 *
 * 每个 isRecord / Array.isArray 判断都落在 jsonb 的 -> 上：-> 对数组、标量返回 NULL，
 * jsonb_typeof(NULL) 也是 NULL，所以「sections 是对象、某个分区是对象、items 是数组」
 * 这一串条件天然连成一条。sections 用 jsonb_to_record 一次拆出各分区，不在每个表达式
 * 里各解压一遍大字段。
 */
export const NOTE_SUMMARY_CONTENT_HEAD = 1024;

/**
 * ECMAScript String.prototype.trim / 正则 \s 认的全部空白：WhiteSpace（TAB、VT、FF、
 * ZWNBSP 与 Unicode Zs 类）加 LineTerminator（LF、CR、LS、PS）。spec 逐个码点对过。
 */
export const JS_WHITESPACE_CHARS = '\t\n\v\f\r                  　﻿';

export type NoteSummaryProjectionRow = {
  id: string;
  contentHead: string | null;
  /** 分区里存的正文是字符串时它是否有非空白字符；不是字符串时为 null。 */
  sectionTextHasText: boolean | null;
  hasJsonText: boolean;
  showcaseCount: number;
  contactItems: unknown;
  groupItems: unknown;
  hasLocation: boolean;
  coverId: string | null;
  coverType: NoteMediaType | null;
  coverUrl: string | null;
  coverObjectKey: string | null;
  coverNoteID: string | null;
};

export function noteSummaryProjectionQuery(
  noteIds: readonly string[],
): Prisma.Sql {
  const ids = [...noteIds];
  return Prisma.sql`
    SELECT n."id",
           left(n."content", ${NOTE_SUMMARY_CONTENT_HEAD}::int) AS "contentHead",
           CASE WHEN jsonb_typeof(s."text" -> 'content') = 'string'
                THEN btrim(s."text" ->> 'content', ${JS_WHITESPACE_CHARS}::text) <> ''
           END AS "sectionTextHasText",
           COALESCE(
             jsonb_path_exists(
               CASE WHEN jsonb_typeof(s."text" -> 'contentJson') = 'array'
                      THEN s."text" -> 'contentJson'
                    WHEN jsonb_typeof(n."contentJson") = 'array'
                      THEN n."contentJson"
               END,
               'strict $[*] ? (@.type() == "object")', '{}', true
             ),
             false
           ) AS "hasJsonText",
           CASE WHEN jsonb_typeof(s."showcase" -> 'items') = 'array'
                  THEN jsonb_array_length(s."showcase" -> 'items')
                WHEN jsonb_typeof(s."media" -> 'items') = 'array'
                  THEN 0
                ELSE (
                  SELECT count(*)::int
                  FROM "NoteMedia" AS m
                  WHERE m."noteID" = n."id" AND m."type" = 'IMAGE'
                )
           END AS "showcaseCount",
           CASE WHEN jsonb_typeof(s."contacts" -> 'items') = 'array'
                THEN s."contacts" -> 'items'
           END AS "contactItems",
           CASE WHEN jsonb_typeof(s."groups" -> 'items') = 'array'
                THEN s."groups" -> 'items'
           END AS "groupItems",
           COALESCE(jsonb_typeof(s."location") = 'object', false) AS "hasLocation",
           COALESCE(chosen."id", fallback."id") AS "coverId",
           COALESCE(chosen."type", fallback."type") AS "coverType",
           COALESCE(chosen."url", fallback."url") AS "coverUrl",
           COALESCE(chosen."objectKey", fallback."objectKey") AS "coverObjectKey",
           COALESCE(chosen."noteID", fallback."noteID") AS "coverNoteID"
    FROM "Note" AS n
    LEFT JOIN LATERAL jsonb_to_record(
      CASE WHEN jsonb_typeof(n."sections") = 'object' THEN n."sections" END
    ) AS s("text" jsonb, "media" jsonb, "showcase" jsonb,
           "contacts" jsonb, "groups" jsonb, "location" jsonb) ON true
    LEFT JOIN "NoteMedia" AS chosen
      ON chosen."id" = n."coverMediaID" AND chosen."type" = 'IMAGE'
    LEFT JOIN LATERAL (
      SELECT fm."id", fm."type", fm."url", fm."objectKey", fm."noteID"
      FROM "NoteMedia" AS fm
      WHERE fm."noteID" = n."id" AND fm."type" = 'IMAGE'
      ORDER BY fm."sortOrder" ASC
      LIMIT 1
    ) AS fallback ON true
    WHERE n."id" = ANY(${ids}::text[])
  `;
}

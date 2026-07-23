-- 清除跨属主的 NoteMedia.posterUrl。
--
-- 背景：presign-on-read 会从客户端可控的 posterUrl 反推 object key 去签名，而写入侧
-- 当时只校验了 objectKey 的属主、posterUrl 只校验同源。攻击者可以在自己的笔记上把
-- posterUrl 指向别人的对象，读取时换回一个有效的签名 URL。
-- 代码侧已在两处堵死（写入 assertMediaOwnership + 读取 collectNoteMediaTargets），
-- 这条迁移负责清掉修复前可能已经落库的脏数据 —— 无论它来自利用还是客户端 bug。
--
-- 判据与代码一致：poster 的 key 必须与同一条媒体 objectKey 处在同一个 notes/{uid}/ 下。
-- 刻意 **不是** 「等于笔记主人」：收藏复制不搬运对象（collectNote 沿用原作者的
-- objectKey/posterUrl），按笔记主人一刀切会误清所有收藏笔记的封面。
--
-- 只处理指向本站 notes/ 前缀的 posterUrl：
--   - 站外 URL（CDN 等）反推不出 key，读取路径本来就不会签，留着无害；
--   - 指向 chat/ 等其它前缀的同样反推不到 notes 属主，不在本次安全问题范围内。
-- 置 NULL 而不是删行：媒体本身（objectKey/url）是合法的，只有封面这一列有问题。
--
-- 谓词已在 postgres 16 上用样本行验证：仅跨属主行命中，收藏副本 / 同属主 / 站外 /
-- 非 notes 前缀均不受影响。
UPDATE "NoteMedia"
SET "posterUrl" = NULL
WHERE "posterUrl" IS NOT NULL
  AND "posterUrl" LIKE '%/notes/%'
  AND split_part("objectKey", '/', 2) IS DISTINCT FROM
      split_part(substring("posterUrl" FROM '/notes/(.*)$'), '/', 1);

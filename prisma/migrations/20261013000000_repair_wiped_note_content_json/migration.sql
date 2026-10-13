-- 修复被清空的笔记正文结构。
--
-- 全局 ValidationPipe 开了 enableImplicitConversion，而 contentJson 字段没声明元素
-- 类型（缺 @Type(() => Object)），class-transformer 按反射到的 Array 把每个正文块
-- 对象「转换」成了空数组：落库的 contentJson 变成 [[], [], []]，富文本结构整段丢失，
-- 纯文本 content 列完好。客户端见到非空的块数组就按块渲染，于是详情页正文一片空白。
--
-- 这里把「被清空的形状」（非空数组、且每个元素都是空数组）还原成「没有块」：
-- 顶层 contentJson 置 NULL，sections.text.contentJson 整个键删掉。客户端遇到没有块
-- 时会回退显示 / 编辑 content。只匹配被清空的形状，可重复执行；不碰 updatedAt。
--
-- jsonb_array_length 对非数组会直接报错，而 Postgres 不保证 AND 的求值顺序，
-- 所以类型判断必须放在 CASE 里。

UPDATE "Note"
SET "contentJson" = NULL
WHERE CASE
  WHEN jsonb_typeof("contentJson") = 'array' THEN
    jsonb_array_length("contentJson") > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("contentJson") AS block
      WHERE jsonb_typeof(block) <> 'array' OR jsonb_array_length(block) <> 0
    )
  ELSE false
END;

UPDATE "Note"
SET "sections" = "sections" #- '{text,contentJson}'
WHERE CASE
  WHEN jsonb_typeof("sections" -> 'text' -> 'contentJson') = 'array' THEN
    jsonb_array_length("sections" -> 'text' -> 'contentJson') > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("sections" -> 'text' -> 'contentJson') AS block
      WHERE jsonb_typeof(block) <> 'array' OR jsonb_array_length(block) <> 0
    )
  ELSE false
END;

UPDATE "NoteDraft"
SET "contentJson" = NULL
WHERE CASE
  WHEN jsonb_typeof("contentJson") = 'array' THEN
    jsonb_array_length("contentJson") > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("contentJson") AS block
      WHERE jsonb_typeof(block) <> 'array' OR jsonb_array_length(block) <> 0
    )
  ELSE false
END;

UPDATE "NoteDraft"
SET "sections" = "sections" #- '{text,contentJson}'
WHERE CASE
  WHEN jsonb_typeof("sections" -> 'text' -> 'contentJson') = 'array' THEN
    jsonb_array_length("sections" -> 'text' -> 'contentJson') > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements("sections" -> 'text' -> 'contentJson') AS block
      WHERE jsonb_typeof(block) <> 'array' OR jsonb_array_length(block) <> 0
    )
  ELSE false
END;

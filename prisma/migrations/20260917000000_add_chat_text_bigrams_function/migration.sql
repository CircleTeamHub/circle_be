-- 聊天消息关键词搜索的索引函数:把文本拆成相邻两个字符的集合(小写化、去重)。
--
-- 为什么不是 pg_trgm:中文搜索词大多只有两个字(「晚饭」「合同」),trigram 从两个字
-- 的 LIKE '%晚饭%' 里一个完整三元组都拆不出来,索引整个用不上、退回全表扫。二元组
-- 对两个字及以上的中文、英文都能命中;一个字的搜索词拆不出二元组(空数组),查询里
-- `@>` 恒真,自然退回按会话范围扫,结果不受影响。
--
-- 查询侧必须同时带 LIKE 复核:二元组都在不代表它们相邻、顺序一致。
--
-- lower() 与 generate_series 都是 IMMUTABLE,函数可以进表达式索引。本文件只建函数
-- (带 $$ 整份一个事务,不碰任何表);索引在下一个文件里 CONCURRENTLY 建。
CREATE OR REPLACE FUNCTION chat_text_bigrams(input text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(array_agg(DISTINCT substr(source.lowered, i, 2)), ARRAY[]::text[])
  FROM (SELECT lower(COALESCE(input, '')) AS lowered) AS source
  CROSS JOIN LATERAL generate_series(1, char_length(source.lowered) - 1) AS i
$$;

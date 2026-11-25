-- 原生堆剖析：录制结束时仍未释放的内存，归到「第一个不是分配器本身的调用方」所在的动态库。
-- 用法：trace_processor -q heap-by-owner.sql heap.pftrace
-- 叶子帧总是 libc 的 malloc/calloc 之类，libc++ 的 operator new 也只是转手，所以往上跳过它们。

DROP VIEW IF EXISTS frame_info;
CREATE VIEW frame_info AS
SELECT f.id AS frame_id, f.name AS fn, m.name AS mapping,
       (m.name GLOB '*/libc.so' OR m.name GLOB '*/libc++.so' OR m.name GLOB '*libc++_shared.so'
        OR m.name GLOB '*scudo*' OR m.name GLOB '*heapprofd*') AS is_allocator
FROM stack_profile_frame f JOIN stack_profile_mapping m ON f.mapping = m.id;

DROP TABLE IF EXISTS callsite_owner;
CREATE TABLE callsite_owner AS
WITH RECURSIVE walk(leaf_id, cur_id, depth) AS (
  SELECT id, id, 0 FROM stack_profile_callsite
  UNION ALL
  SELECT w.leaf_id, c.parent_id, w.depth + 1
  FROM walk w
  JOIN stack_profile_callsite c ON c.id = w.cur_id
  JOIN frame_info fi ON fi.frame_id = c.frame_id
  WHERE fi.is_allocator AND c.parent_id IS NOT NULL AND w.depth < 12
),
last_step AS (
  SELECT leaf_id, cur_id FROM walk w
  WHERE depth = (SELECT max(depth) FROM walk w2 WHERE w2.leaf_id = w.leaf_id)
)
SELECT l.leaf_id, fi.mapping AS owner_mapping, fi.fn AS owner_fn
FROM last_step l
JOIN stack_profile_callsite c ON c.id = l.cur_id
JOIN frame_info fi ON fi.frame_id = c.frame_id;

SELECT '== 未释放总量 MB' AS section, round(sum(size) / 1048576.0, 1) AS mb, sum(count) AS allocs
FROM heap_profile_allocation;

SELECT '== 按动态库' AS section, replace(o.owner_mapping, rtrim(o.owner_mapping, replace(o.owner_mapping, '/', '')), '') AS lib,
       round(sum(a.size) / 1048576.0, 1) AS unreleased_mb, sum(a.count) AS allocs
FROM heap_profile_allocation a JOIN callsite_owner o ON o.leaf_id = a.callsite_id
GROUP BY o.owner_mapping HAVING sum(a.size) > 524288
ORDER BY sum(a.size) DESC LIMIT 25;

SELECT '== 按调用函数' AS section, replace(o.owner_mapping, rtrim(o.owner_mapping, replace(o.owner_mapping, '/', '')), '') AS lib,
       substr(coalesce(o.owner_fn, '(无符号)'), 1, 90) AS fn,
       round(sum(a.size) / 1048576.0, 1) AS unreleased_mb, sum(a.count) AS allocs
FROM heap_profile_allocation a JOIN callsite_owner o ON o.leaf_id = a.callsite_id
GROUP BY o.owner_mapping, o.owner_fn HAVING sum(a.size) > 1048576
ORDER BY sum(a.size) DESC LIMIT 30;

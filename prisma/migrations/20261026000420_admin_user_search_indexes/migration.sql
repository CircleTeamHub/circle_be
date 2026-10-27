-- 管理台两处按 User 查的列表(真库回归:test/postgres/index-admin-console.pg-spec.ts)。
--
-- CONCURRENTLY:User 是写热表。两条都是部分索引,按仓库惯例不进 schema.prisma。文件里
-- 不能有函数体或 DO 块,Prisma 才会把每条语句放在事务外执行。部署后查
-- pg_index.indisvalid:中断的并发建索引会留下 invalid 索引,IF NOT EXISTS 会把它当成
-- 已存在 —— 遇到要先手动 DROP INDEX CONCURRENTLY 再重跑。

-- 1. 用户中心关键词搜索(admin-user.service listUsers):
--      accountId ILIKE OR nickname ILIKE OR email = OR phoneNumber =
--    前三支各有索引(两条 trigram + email 唯一键),phoneNumber 没有任何索引,整个 OR
--    就没法 BitmapOr,findMany 和 count 各扫一遍全表。只收有手机号的行:等值条件
--    (严格运算符)蕴含 IS NOT NULL,规划器能证明可用;大多数账号没有手机号,索引很小。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_phoneNumber_present_idx"
ON "User" ("phoneNumber")
WHERE "phoneNumber" IS NOT NULL;

-- 2. 管理员列表(admin-access.service list):role = 'ADMIN' AND status <> 'DELETED',
--    按 createdAt DESC, id DESC 分页并计数。role 没有索引,两条查询都整表扫。部分索引
--    只收管理员,几乎为空,普通用户行的写入完全不碰它。
--    谓词必须是字面量才能匹配:Prisma 编译出的 CAST($1::text AS "UserRole") 规划期
--    不折叠,所以查询改走 src/admin-access/admin-access-list.query.ts 的原生 SQL。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_admin_createdAt_idx"
ON "User" ("createdAt" DESC, "id" DESC)
WHERE "role" = 'ADMIN' AND "status" <> 'DELETED';

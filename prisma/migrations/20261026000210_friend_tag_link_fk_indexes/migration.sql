-- FriendTagOnFriend 两个外键列的前导索引。
--
-- 删好友 / 拉黑(friend.service 里的 friend.delete、friend.deleteMany)删掉 Friend 行
-- 时,外键级联会执行
--   DELETE FROM ONLY "FriendTagOnFriend" WHERE $1 = "friendID"
-- 删标签同理(按 "tagID")。原有索引都以 "ownerID" 打头 —— ("ownerID", "friendID")
-- 和唯一键 ("ownerID", "tagID", "friendID") —— 级联语句不带 ownerID,用不上,每删一个
-- 好友 / 标签就是一次全表扫描,而且发生在删好友的事务里。
--
-- CONCURRENTLY:同 20261026000200,文件里只放 CREATE INDEX CONCURRENTLY,部署后核对
-- pg_index.indisvalid。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "FriendTagOnFriend_friendID_idx"
ON "FriendTagOnFriend" ("friendID");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "FriendTagOnFriend_tagID_idx"
ON "FriendTagOnFriend" ("tagID");

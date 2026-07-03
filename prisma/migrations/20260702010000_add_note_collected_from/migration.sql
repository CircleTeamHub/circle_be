-- 收藏笔记入"我的笔记"：记录来源快照（群/用户名片 + 消息定位），并冗余原笔记 id 供幂等去重
ALTER TABLE "Note" ADD COLUMN "collectedFrom" JSONB;
ALTER TABLE "Note" ADD COLUMN "collectedFromNoteID" TEXT;

CREATE INDEX "Note_ownerID_collectedFromNoteID_idx" ON "Note"("ownerID", "collectedFromNoteID");

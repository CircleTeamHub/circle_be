-- CreateTable
CREATE TABLE "ConversationGroup" (
  "id" TEXT NOT NULL,
  "ownerID" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "pinnedToTabs" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ConversationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationGroupMembership" (
  "groupID" TEXT NOT NULL,
  "conversationID" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConversationGroupMembership_pkey" PRIMARY KEY ("groupID", "conversationID")
);

-- CreateIndex
CREATE INDEX "ConversationGroup_ownerID_idx" ON "ConversationGroup"("ownerID");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationGroup_ownerID_name_key" ON "ConversationGroup"("ownerID", "name");

-- CreateIndex
CREATE INDEX "ConversationGroupMembership_conversationID_idx" ON "ConversationGroupMembership"("conversationID");

-- AddForeignKey
ALTER TABLE "ConversationGroup" ADD CONSTRAINT "ConversationGroup_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationGroupMembership" ADD CONSTRAINT "ConversationGroupMembership_groupID_fkey" FOREIGN KEY ("groupID") REFERENCES "ConversationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ChatMediaReference" (
    "id" TEXT NOT NULL,
    "messageID" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMediaReference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatMediaReference_messageID_objectKey_key"
ON "ChatMediaReference"("messageID", "objectKey");

CREATE INDEX "ChatMediaReference_objectKey_idx"
ON "ChatMediaReference"("objectKey");

ALTER TABLE "ChatMediaReference"
ADD CONSTRAINT "ChatMediaReference_messageID_fkey"
FOREIGN KEY ("messageID") REFERENCES "ChatMessage"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ChatMediaReference" ("id", "messageID", "objectKey", "createdAt")
SELECT gen_random_uuid()::text, message."id", keys."objectKey", CURRENT_TIMESTAMP
FROM "ChatMessage" AS message
CROSS JOIN LATERAL (
    VALUES (message.content->>'key'), (message.content->>'thumbKey')
) AS keys("objectKey")
WHERE message."deleted" = false
  AND message."revokedAt" IS NULL
  AND keys."objectKey" LIKE 'chat/%/note-import/%'
ON CONFLICT ("messageID", "objectKey") DO NOTHING;

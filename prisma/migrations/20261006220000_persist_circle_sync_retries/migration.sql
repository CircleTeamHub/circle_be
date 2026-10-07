CREATE TABLE "ChatCircleSyncRetry" (
  "circleID" VARCHAR(36) NOT NULL,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatCircleSyncRetry_pkey" PRIMARY KEY ("circleID")
);

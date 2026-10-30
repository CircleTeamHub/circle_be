ALTER TABLE "AssistantSubscription"
    ADD COLUMN "keywords" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "noteStatusAlerts" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "MembershipProgramState" (
    "id" INTEGER NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "enabledByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipProgramState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MembershipProgramState_singleton" CHECK ("id" = 1)
);

INSERT INTO "MembershipProgramState" ("id") VALUES (1);

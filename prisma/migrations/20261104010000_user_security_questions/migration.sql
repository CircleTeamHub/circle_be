-- 纯加性：密保问题（陌生设备登录的兜底验证）。
CREATE TABLE "UserSecurityQuestion" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "questionKey" TEXT NOT NULL,
    "answerHash" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSecurityQuestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserSecurityQuestion_userId_position_key" ON "UserSecurityQuestion"("userId", "position");

ALTER TABLE "UserSecurityQuestion" ADD CONSTRAINT "UserSecurityQuestion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

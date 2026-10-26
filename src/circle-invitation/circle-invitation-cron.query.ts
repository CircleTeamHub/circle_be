import { Prisma } from 'src/generated/prisma';

/**
 * 圈子邀请两个定时任务的批次查询。两条都落在迁移
 * 20261026000520_circle_invitation_cron_indexes 的部分索引上 —— 能不能用上取决于
 * 查询条件与索引谓词一字不差：
 * - status 必须写成 SQL 字面量。Prisma 会把枚举参数化成 CAST($n::text AS 枚举)，
 *   枚举输入函数不是 immutable，规划期连自定义计划也折叠不成常量，部分索引的谓词
 *   永远证明不了，只能整表扫描（真库回归里有对照）；
 * - 布尔条件写成裸列名，与索引谓词同形。
 * 改这里就必须同步改迁移（真库回归 test/postgres/circle-invitation-cron.pg-spec.ts 会拦）。
 */

/**
 * 每分钟的同意制邀请投递：还没投递成功、没用完重试次数的 INVITED 邀请，重试少的、
 * 早建的先发。部分索引只收「待投递」的行，平时几乎是空的。
 */
export function pendingConsentDeliveriesQuery(params: {
  maxAttempts: number;
  limit: number;
}): Prisma.Sql {
  return Prisma.sql`
    SELECT "id", "consentNoticeAttempts"
    FROM "CircleInvitation"
    WHERE "status" = 'INVITED'
      AND "consentNoticeRequired"
      AND "consentNoticeDeliveredAt" IS NULL
      AND "consentNoticeAttempts" < ${params.maxAttempts}
    ORDER BY "consentNoticeAttempts" ASC, "createdAt" ASC
    LIMIT ${params.limit}
  `;
}

/**
 * 每 5 分钟的补偿：票数已够、却因请求事务中断仍停在 PENDING 的邀请。表上原有索引都
 * 以 circleID / applicantID 打头，这条只能整表扫描；部分索引只收这类卡住的行（正常
 * 情况下为空），按 (updatedAt, id) 有序，读到 LIMIT 条就停。
 */
export function approvedInvitationsToReconcileQuery(): Prisma.Sql {
  return Prisma.sql`
    SELECT "id", "circleID", "applicantID"
    FROM "CircleInvitation"
    WHERE "status" = 'PENDING'
      AND "approvedCount" >= "requiredCount"
    ORDER BY "updatedAt" ASC, "id" ASC
    LIMIT 100
  `;
}

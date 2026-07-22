import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

export type AdminAuditEntry = {
  actorID: string;
  action: string;
  entityType?: string;
  entityID?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * 管理台操作审计（#90）。只追加；写失败不阻断业务动作本身 —— 审计缺一行
 * 可容忍，管理操作因审计库抖动而失败不可容忍（但要 error 喊出来）。
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 事务内严格审计写入（round 2 review）：takedown/restore 的恢复资格判定
   * 依赖这两类审计行的存在性 —— best-effort 吞错会让判定地基悬空（下架审计
   * 丢了→合法恢复被拒；恢复审计丢了→作者自删又能被复活）。作为承载业务
   * 语义的行，必须与状态变更同事务、失败即整体回滚。
   */
  async recordStrict(
    tx: Pick<PrismaService, 'adminAuditLog'>,
    entry: AdminAuditEntry,
  ): Promise<void> {
    await tx.adminAuditLog.create({
      data: {
        actorID: entry.actorID,
        action: entry.action,
        entityType: entry.entityType ?? null,
        entityID: entry.entityID ?? null,
        before: entry.before
          ? (JSON.parse(JSON.stringify(entry.before)) as object)
          : undefined,
        after: entry.after
          ? (JSON.parse(JSON.stringify(entry.after)) as object)
          : undefined,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  }

  async record(entry: AdminAuditEntry): Promise<void> {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          actorID: entry.actorID,
          action: entry.action,
          entityType: entry.entityType ?? null,
          entityID: entry.entityID ?? null,
          // Prisma Json 入参要求 InputJsonValue；这里都是纯 JSON 值。
          before: entry.before
            ? (JSON.parse(JSON.stringify(entry.before)) as object)
            : undefined,
          after: entry.after
            ? (JSON.parse(JSON.stringify(entry.after)) as object)
            : undefined,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `admin audit write failed action=${entry.action} entity=${entry.entityType ?? ''}:${entry.entityID ?? ''}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}

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

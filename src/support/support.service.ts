import { BadRequestException, Injectable } from '@nestjs/common';
import { SupportErrorCode } from 'src/common/app-error-codes';
import { AdminUserAuditService } from 'src/admin-user/admin-user-audit.service';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';

// 覆盖式写入的串行化锁。整表只有一份配置,所以固定一个 key 就够。
const SUPPORT_AGENTS_LOCK_KEY = 'support-agents-replace';
import {
  AdminSupportAgentDto,
  SUPPORT_AGENT_CATEGORIES,
  SupportAgentCategory,
  SupportAgentViewDto,
  SupportConfigDto,
  SupportAgentInputDto,
} from './support.dto';

const AGENT_USER_SELECT = {
  id: true,
  nickname: true,
  avatarUrl: true,
  vipLevel: true,
} as const;

function emptyConfig(): Record<SupportAgentCategory, SupportAgentViewDto[]> {
  return Object.fromEntries(
    SUPPORT_AGENT_CATEGORIES.map((category) => [category, []]),
  ) as Record<SupportAgentCategory, SupportAgentViewDto[]>;
}

function toView(user: {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  vipLevel: number;
}): SupportAgentViewDto {
  return {
    userID: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    vipLevel: user.vipLevel,
  };
}

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminUserAuditService,
  ) {}

  /**
   * App 读取:只返回「启用且账号仍 ACTIVE」的客服。
   *
   * 账号被封/注销时必须一并消失 —— 否则客服中心渲染出一行,点进去被
   * getOrCreateDirectConversation 以 PeerNotFound 拒绝,又回到了 imAdmin 时代
   * 「渲染成功、点击失败」的老毛病。
   */
  async getConfig(): Promise<SupportConfigDto> {
    const rows = await this.prisma.supportAgent.findMany({
      where: { enabled: true, user: { status: 'ACTIVE' } },
      orderBy: [
        { category: 'asc' },
        { sortOrder: 'asc' },
        { createdAt: 'asc' },
      ],
      select: { category: true, user: { select: AGENT_USER_SELECT } },
    });

    const agents = emptyConfig();
    for (const row of rows) {
      agents[row.category as SupportAgentCategory].push(toView(row.user));
    }
    return { agents };
  }

  /** 管理台读取:含停用行,否则管理台无法把停用的客服改回启用。 */
  async listForAdmin(): Promise<AdminSupportAgentDto[]> {
    const rows = await this.prisma.supportAgent.findMany({
      orderBy: [
        { category: 'asc' },
        { sortOrder: 'asc' },
        { createdAt: 'asc' },
      ],
      select: {
        category: true,
        sortOrder: true,
        enabled: true,
        user: { select: AGENT_USER_SELECT },
      },
    });

    return rows.map((row) => ({
      ...toView(row.user),
      category: row.category as SupportAgentCategory,
      sortOrder: row.sortOrder,
      enabled: row.enabled,
    }));
  }

  /**
   * 整表覆盖式写入。
   *
   * 实现为 diff:未出现在 payload 里的行才删除,出现的按 (category,userID) upsert。
   * 不用 deleteMany+createMany 是因为那会重置 id 与 createdAt —— 调整一次顺序就让
   * 所有行看起来像刚创建,审计日志里再也分不出「新增了谁」和「只是挪了个位置」。
   */
  async replaceAgents(
    operator: { userId: string; accountId: string },
    input: SupportAgentInputDto[],
  ): Promise<AdminSupportAgentDto[]> {
    this.assertNoDuplicates(input);
    await this.assertUsersUsable(input);

    await this.prisma.$transaction(async (tx) => {
      // 两个管理员同时提交时,默认隔离级别下双方都会读到同一份 before 快照,
      // 各自只删自己快照里、payload 外的行 —— 最终落库的是两份 payload 的并集,
      // 而这个组合谁都没提交过。用与会员开关同款的事务级 advisory lock 串行化。
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${SUPPORT_AGENTS_LOCK_KEY}, 0)
        )
      `);

      const before = await tx.supportAgent.findMany({
        select: {
          category: true,
          userID: true,
          sortOrder: true,
          enabled: true,
        },
      });

      const keep = new Set(input.map((a) => `${a.category}:${a.userID}`));
      const removed = before.filter(
        (row) => !keep.has(`${row.category}:${row.userID}`),
      );
      if (removed.length > 0) {
        await tx.supportAgent.deleteMany({
          where: {
            OR: removed.map(({ category, userID }) => ({ category, userID })),
          },
        });
      }

      for (const agent of input) {
        const data = {
          sortOrder: agent.sortOrder,
          enabled: agent.enabled ?? true,
        };
        await tx.supportAgent.upsert({
          where: {
            category_userID: { category: agent.category, userID: agent.userID },
          },
          create: { category: agent.category, userID: agent.userID, ...data },
          update: data,
        });
      }

      await this.audit.recordInTransaction(tx, {
        actorId: operator.userId,
        actorAccountId: operator.accountId,
        action: 'support.agents.replace',
        targetType: 'support_agents',
        // 覆盖式写入没有单一目标实体,固定用哨兵 id 让整表变更也能被检索到。
        targetId: 'all',
        before,
        after: input.map((agent) => ({
          category: agent.category,
          userID: agent.userID,
          sortOrder: agent.sortOrder,
          enabled: agent.enabled ?? true,
        })),
      });
    });

    return this.listForAdmin();
  }

  /**
   * 陌生人开关豁免用。客服本人在 App 里关掉「接收陌生人消息」会静默切断整条客服通道,
   * 且失效时没有任何信号 —— 所以做成服务端规则,而不是靠约束客服的个人设置。
   */
  async isSupportAgent(userID: string): Promise<boolean> {
    const row = await this.prisma.supportAgent.findFirst({
      where: { userID, enabled: true },
      select: { id: true },
    });
    return row != null;
  }

  private assertNoDuplicates(input: SupportAgentInputDto[]): void {
    const seen = new Set<string>();
    for (const agent of input) {
      const key = `${agent.category}:${agent.userID}`;
      if (seen.has(key)) {
        throw new BadRequestException({
          message: `同一类里重复配置了同一个客服:${agent.category}`,
          errorCode: SupportErrorCode.AgentDuplicate,
        });
      }
      seen.add(key);
    }
  }

  /** 把「配错了要等用户点击才暴露」提前到配置那一刻。 */
  private async assertUsersUsable(
    input: SupportAgentInputDto[],
  ): Promise<void> {
    const userIDs = [...new Set(input.map((agent) => agent.userID))];
    if (userIDs.length === 0) return;

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIDs } },
      select: { id: true, status: true },
    });
    const byId = new Map(users.map((user) => [user.id, user.status]));

    for (const userID of userIDs) {
      const status = byId.get(userID);
      if (status === undefined) {
        throw new BadRequestException({
          message: `客服账号不存在:${userID}`,
          errorCode: SupportErrorCode.AgentUserNotFound,
        });
      }
      if (status !== 'ACTIVE') {
        throw new BadRequestException({
          message: `客服账号不可用(${status}):${userID}`,
          errorCode: SupportErrorCode.AgentUserInactive,
        });
      }
    }
  }
}

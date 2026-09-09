import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import type { Prisma } from 'src/generated/prisma';
import {
  circleGroupRole,
  GROUP_EVENTS_PAGE_DEFAULT,
  GROUP_EVENTS_PAGE_MAX,
  isGroupManager,
} from './chat-group-roles';
import type {
  ChatGroupEventDto,
  ChatGroupEventKind,
  ChatGroupEventsPageDto,
  ChatSenderInfo,
} from './chat.types';

export interface GroupEventInput {
  kind: ChatGroupEventKind;
  /** 操作者;null = 系统/圈子对账。 */
  actorId: string | null;
  targetIds?: readonly string[];
  payload?: Record<string, unknown> | null;
}

interface EventCursor {
  createdAt: Date;
  id: string;
}

/**
 * 群事件账本(群日志)。
 *
 * 与 type='system' 的聊天提示成对写,但它是独立的表:不受清空水位/焚毁影响,
 * 后入群的人也能翻到入群前的记录。读侧闸门与成员目录同口径 —— 圈子群只开放
 * 给圈主/管理员(目录本身就是这么限的,日志里全是成员身份),独立群聊全员可读。
 *
 * 独立成服务:GroupService / CircleService / ChatCircleSyncService 都要写它,
 * 而它们与 ChatService 之间已有依赖方向,塞进 ChatService 会成环。
 */
@Injectable()
export class ChatGroupEventService {
  private readonly logger = new Logger(ChatGroupEventService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 在**调用方的事务里**记一条事件:设置变更/角色变更/移出/禁言这类「必须留痕」
   * 的写路径,把事件和变更放进同一事务,要么都成、要么都不成。
   */
  async recordInTx(
    tx: Prisma.TransactionClient,
    conversationId: string,
    input: GroupEventInput,
  ): Promise<void> {
    await tx.chatGroupEvent.create({
      data: {
        conversationID: conversationId,
        kind: input.kind,
        actorID: input.actorId,
        targetIDs: [...new Set(input.targetIds ?? [])],
        ...(input.payload
          ? { payload: input.payload as Prisma.InputJsonObject }
          : {}),
      },
    });
  }

  /**
   * 事务外的尽力而为写入:进群/退群/改名这类原本就是 fire-and-forget 系统提示的
   * 路径。失败只记日志 —— 座位变更已经提交,少一行日志不该让请求失败。
   */
  async record(conversationId: string, input: GroupEventInput): Promise<void> {
    try {
      await this.recordInTx(this.prisma, conversationId, input);
    } catch (error) {
      // 只记错误类型:底层 message 可能带出群名、用户标识。
      this.logger.warn(
        `group event record failed conversation=${conversationId} kind=${input.kind} (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
    }
  }

  /** 群日志倒序分页((createdAt, id) 复合 keyset,不用 OFFSET)。 */
  async listEvents(
    userId: string,
    conversationId: string,
    query: { cursor?: string; limit?: number },
  ): Promise<ChatGroupEventsPageDto> {
    await this.assertCanViewLog(userId, conversationId);
    const limit = Math.min(
      Math.max(query.limit ?? GROUP_EVENTS_PAGE_DEFAULT, 1),
      GROUP_EVENTS_PAGE_MAX,
    );
    const cursor = decodeCursor(query.cursor);
    const rows = await this.prisma.chatGroupEvent.findMany({
      where: {
        conversationID: conversationId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const users = await this.resolveUsers(
      page.flatMap((row) => [
        ...(row.actorID ? [row.actorID] : []),
        ...row.targetIDs,
      ]),
    );
    const events: ChatGroupEventDto[] = page.map((row) => ({
      id: row.id,
      kind: row.kind as ChatGroupEventKind,
      actor: row.actorID
        ? (users.get(row.actorID) ?? ghost(row.actorID))
        : null,
      targets: row.targetIDs.map((id) => users.get(id) ?? ghost(id)),
      payload:
        row.payload &&
        typeof row.payload === 'object' &&
        !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : null,
      createdAt: row.createdAt.toISOString(),
    }));
    const last = page[page.length - 1];
    return {
      events,
      nextCursor:
        rows.length > limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  /**
   * 读侧闸门:在座成员;圈子群再要求圈主/管理员(与成员目录同一条线,
   * 错误码也复用 MemberDirectoryForbidden,客户端已有这条文案)。
   */
  private async assertCanViewLog(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const seat = await this.prisma.chatMember.findUnique({
      where: {
        conversationID_userID: {
          conversationID: conversationId,
          userID: userId,
        },
      },
      select: {
        leftAt: true,
        conversation: { select: { type: true, circleID: true } },
      },
    });
    if (!seat || seat.leftAt) {
      throw new ForbiddenException({
        message: '不是会话成员',
        errorCode: ChatErrorCode.NotMember,
      });
    }
    if (seat.conversation.type !== 'GROUP' || !seat.conversation.circleID) {
      return;
    }
    const membership = await this.prisma.circleMember.findUnique({
      where: {
        userID_circleID: {
          userID: userId,
          circleID: seat.conversation.circleID,
        },
      },
      select: { role: true, status: true },
    });
    if (!isGroupManager(circleGroupRole(membership))) {
      throw new ForbiddenException({
        message: '仅圈主和管理员可查看群日志',
        errorCode: ChatErrorCode.MemberDirectoryForbidden,
      });
    }
  }

  private async resolveUsers(
    userIds: string[],
  ): Promise<Map<string, ChatSenderInfo>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, nickname: true, avatarUrl: true },
    });
    return new Map(
      users.map((user) => [
        user.id,
        { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl },
      ]),
    );
  }
}

/** 已注销/查不到的账号:保留 id、昵称空串,由客户端兜底文案。 */
function ghost(id: string): ChatSenderInfo {
  return { id, nickname: '', avatarUrl: null };
}

function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id }),
  ).toString('base64url');
}

/** 游标是不透明串,但客户端可能回传坏值:解不开一律 400,不能静默从头翻。 */
function decodeCursor(raw: string | undefined): EventCursor | null {
  if (raw === undefined) return null;
  const invalid = () =>
    new BadRequestException({
      message: '无效的分页游标',
      errorCode: ChatErrorCode.InvalidPayload,
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object') throw invalid();
  const { t, id } = parsed as { t?: unknown; id?: unknown };
  if (typeof t !== 'string' || typeof id !== 'string' || id.length === 0) {
    throw invalid();
  }
  const createdAt = new Date(t);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return { createdAt, id };
}

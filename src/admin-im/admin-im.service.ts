import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { Prisma } from 'src/generated/prisma';
import { ChatGroupAdminService } from 'src/chat/chat-group-admin.service';
import { UploadService } from 'src/upload/upload.service';
import {
  CHAT_MEDIA_KEY_FIELDS,
  CHAT_MEDIA_KEY_PREFIX,
} from 'src/chat/chat.constants';
import { GroupService } from 'src/group/group.service';
import {
  buildChatRetentionWindow,
  chatRetentionWhere,
  NO_VIEWER_RETENTION,
} from 'src/chat/chat-retention';
import {
  ImListDto,
  ImMemberActionDto,
  ImMessageQueryDto,
} from './admin-im.dto';

@Injectable()
export class AdminImService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly groups: ChatGroupAdminService,
    private readonly circleGroups: GroupService,
    private readonly upload: UploadService,
  ) {}
  private async conversation(id: string) {
    const row = await this.prisma.chatConversation.findUnique({
      where: { id },
    });
    if (!row || (row.type !== 'DIRECT' && row.type !== 'GROUP'))
      throw new NotFoundException(
        'Persisted direct/group session not found; legacy OpenIM history is unavailable',
      );
    return row;
  }
  async list(q: ImListDto) {
    const where: Prisma.ChatConversationWhereInput = {
      type: q.type ?? { in: ['DIRECT', 'GROUP'] },
      ...(q.keyword
        ? {
            OR: [
              { id: { contains: q.keyword } },
              { name: { contains: q.keyword, mode: 'insensitive' } },
              { circleID: { contains: q.keyword } },
              {
                members: {
                  some: { userID: { contains: q.keyword }, leftAt: null },
                },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.chatConversation.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: {
          id: true,
          type: true,
          circleID: true,
          name: true,
          ownerID: true,
          createdAt: true,
          lastMessageAt: true,
          members: {
            where: { leftAt: null },
            orderBy: { joinedAt: 'asc' },
            take: 4,
            select: { userID: true, alias: true },
          },
          _count: { select: { members: { where: { leftAt: null } } } },
        },
      }),
      this.prisma.chatConversation.count({ where }),
    ]);
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: rows.flatMap((r) => r.members.map((m) => m.userID)) },
      },
      select: { id: true, nickname: true },
    });
    const circles = await this.prisma.circle.findMany({
      where: {
        id: { in: rows.flatMap((r) => (r.circleID ? [r.circleID] : [])) },
      },
      select: { id: true, name: true },
    });
    return {
      items: rows.map(({ members, _count, ...r }) => ({
        ...r,
        name: r.name ?? circles.find((c) => c.id === r.circleID)?.name ?? null,
        source: 'SELF_HOSTED',
        memberCount: _count.members,
        participants: members.map((m) => ({
          id: m.userID,
          nickname:
            m.alias ??
            users.find((u) => u.id === m.userID)?.nickname ??
            'Deleted account',
        })),
      })),
      total,
      page: q.page,
      limit: q.limit,
      sourceNote:
        'Only self-hosted persisted sessions. OpenIM server history is not integrated.',
    };
  }
  async messages(actorID: string, id: string, q: ImMessageQueryDto) {
    if (q.from && q.to && new Date(q.from) > new Date(q.to))
      throw new BadRequestException('Invalid date range');
    const result = await this.prisma.$transaction(async (tx) => {
      // The shared conversation lock orders this read against clear/recall/burn writes.
      await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id" = ${id} FOR SHARE`;
      const conversation = await tx.chatConversation.findUnique({
        where: { id },
      });
      if (!conversation || !['DIRECT', 'GROUP'].includes(conversation.type))
        throw new NotFoundException(
          'Persisted session not found; legacy OpenIM history unavailable',
        );
      const where: Prisma.ChatMessageWhereInput = {
        conversationID: id,
        deleted: false,
        deletedAt: null,
        revokedAt: null,
        height: {
          gt: conversation.clearedBeforeHeight,
          ...(q.cursor ? { lt: q.cursor } : {}),
        },
        ...(q.senderId ? { senderID: q.senderId } : {}),
        AND: [
          chatRetentionWhere(
            buildChatRetentionWindow(conversation, NO_VIEWER_RETENTION),
          ),
          ...(q.from || q.to
            ? [
                {
                  createdAt: {
                    ...(q.from ? { gte: new Date(q.from) } : {}),
                    ...(q.to ? { lte: new Date(q.to) } : {}),
                  },
                },
              ]
            : []),
          ...(q.text
            ? [
                {
                  type: 'text',
                  content: { path: ['text'], string_contains: q.text },
                },
              ]
            : []),
        ],
      };
      const rows = await tx.chatMessage.findMany({
        where,
        orderBy: { height: 'desc' },
        take: q.limit + 1,
        select: {
          id: true,
          height: true,
          senderID: true,
          type: true,
          content: true,
          createdAt: true,
        },
      });
      // Never record message bodies or text filters (which themselves may contain private content).
      await tx.adminAuditLog.create({
        data: {
          actorID,
          action: 'IM_MESSAGES_READ',
          entityType: 'ChatConversation',
          entityID: id,
          reason: q.reason,
          after: {
            senderId: q.senderId ?? null,
            from: q.from ?? null,
            to: q.to ?? null,
            textFilterUsed: !!q.text,
            cursor: q.cursor ?? null,
            limit: q.limit,
            returned: Math.min(rows.length, q.limit),
          },
        },
      });
      return {
        rows: rows.slice(0, q.limit),
        hasMore: rows.length > q.limit,
        conversation,
      };
    });
    const items = result.rows.map((r) => ({
      id: r.id,
      conversationId: id,
      sender: null,
      replyToId: null,
      mediaExpiresAt: null as string | null,
      revision: 0,
      d: null,
      visibleUntil:
        result.conversation.burnDurationSec &&
        (!result.conversation.burnStartedAt ||
          r.createdAt >= result.conversation.burnStartedAt)
          ? new Date(
              r.createdAt.getTime() +
                result.conversation.burnDurationSec * 1000,
            ).toISOString()
          : null,
      height: r.height,
      senderId: r.senderID,
      type: r.type,
      createdAt: r.createdAt.toISOString(),
      content: this.content(r.type, r.content),
    }));
    await Promise.all(
      items.map(async (item) => {
        const remaining = item.visibleUntil
          ? Math.floor((Date.parse(item.visibleUntil) - Date.now()) / 1000)
          : 900;
        if (remaining <= 0) {
          item.content = {};
          return;
        }
        for (const field of CHAT_MEDIA_KEY_FIELDS[item.type] ?? []) {
          const key = item.content[field.key];
          if (typeof key !== 'string' || !key.startsWith(CHAT_MEDIA_KEY_PREFIX))
            continue;
          try {
            const signed = await this.upload.createPresignedGetUrl(
              key,
              Math.min(900, remaining),
            );
            item.content[field.url] = signed.url;
            const expiry = signed.expiresAt.toISOString();
            if (!item.mediaExpiresAt || expiry < item.mediaExpiresAt)
              item.mediaExpiresAt = expiry;
          } catch {
            /* Media unavailability is shown without logging private object keys. */
          }
        }
      }),
    );
    for (const item of items) {
      delete item.content.key;
      delete item.content.thumbKey;
      delete item.content.coverKey;
    }
    return {
      items: items.filter(
        (item) =>
          !item.visibleUntil || Date.parse(item.visibleUntil) > Date.now(),
      ),
      nextCursor: result.hasMore
        ? (items[items.length - 1]?.height ?? null)
        : null,
      source: 'SELF_HOSTED',
    };
  }
  private content(
    type: string,
    value: Prisma.JsonValue,
  ): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const fields =
      type === 'text'
        ? ['text']
        : ['image', 'voice', 'video', 'file'].includes(type)
          ? [
              'key',
              'thumbKey',
              'coverKey',
              'width',
              'height',
              'duration',
              'name',
              'size',
            ]
          : [];
    return Object.fromEntries(
      fields
        .filter(
          (k) => typeof value[k] === 'string' || typeof value[k] === 'number',
        )
        .map((k) => [k, value[k]]),
    );
  }
  async members(id: string, q: ImListDto) {
    const conversation = await this.conversation(id);
    if (conversation.type !== 'GROUP')
      throw new BadRequestException('Group required');
    const where: Prisma.ChatMemberWhereInput = {
      conversationID: id,
      leftAt: null,
      ...(q.keyword
        ? {
            OR: [
              { userID: { contains: q.keyword } },
              { alias: { contains: q.keyword, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [seats, total, circle] = await Promise.all([
      this.prisma.chatMember.findMany({
        where,
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      this.prisma.chatMember.count({ where }),
      conversation.circleID
        ? this.prisma.circle.findUnique({
            where: { id: conversation.circleID },
            select: { id: true, name: true, ownerID: true, groupID: true },
          })
        : null,
    ]);
    const [users, memberships] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: seats.map((s) => s.userID) } },
        select: { id: true, nickname: true },
      }),
      conversation.circleID
        ? this.prisma.circleMember.findMany({
            where: {
              circleID: conversation.circleID,
              userID: { in: seats.map((s) => s.userID) },
            },
            select: { userID: true, role: true, status: true },
          })
        : [],
    ]);
    return {
      conversationId: id,
      name: conversation.name ?? circle?.name ?? null,
      circle,
      items: seats.map((s) => ({
        id: s.userID,
        nickname:
          s.alias ??
          users.find((u) => u.id === s.userID)?.nickname ??
          'Deleted account',
        role: circle
          ? (memberships.find((m) => m.userID === s.userID)?.role ??
            'UNAVAILABLE')
          : conversation.ownerID === s.userID
            ? 'OWNER'
            : s.role,
        silenced:
          !!s.silencedAt && (!s.silencedUntil || s.silencedUntil > new Date()),
        silencedUntil: s.silencedUntil,
        joinedAt: s.joinedAt,
      })),
      total,
      page: q.page,
      limit: q.limit,
    };
  }
  async moderate(
    actor: string,
    id: string,
    target: string,
    q: ImMemberActionDto,
  ) {
    const conversation = await this.conversation(id);
    if (
      conversation.circleID &&
      (q.action === 'role' || q.action === 'remove')
    ) {
      return this.circleGroups.moderateAsAdministrator(
        actor,
        conversation.circleID,
        target,
        q.action,
        q.role,
        q.reason,
      );
    }
    return this.groups.moderateAsAdministrator(
      actor,
      id,
      target,
      q.action,
      q.role,
      q.reason,
    );
  }
}

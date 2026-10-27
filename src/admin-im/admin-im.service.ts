import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ADMIN_ROLE_PERMISSIONS } from 'src/admin-access/admin-permission.guard';
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
  type ChatBurnPolicy,
  chatRetentionWhere,
  NO_VIEWER_RETENTION,
} from 'src/chat/chat-retention';
import {
  ImListDto,
  ImMemberActionDto,
  ImMessageQueryDto,
} from './admin-im.dto';

function assertReadableConversation<T extends { type: string }>(
  conversation: T | null,
): asserts conversation is T {
  if (!conversation || !['DIRECT', 'GROUP'].includes(conversation.type))
    throw new NotFoundException(
      'Persisted session not found; legacy OpenIM history unavailable',
    );
}

/** 管理员看得到的会话消息:全局清空、撤回、删除、过期照样生效。 */
function messageWhere(
  id: string,
  q: ImMessageQueryDto,
  conversation: ChatBurnPolicy & { clearedBeforeHeight: number },
): Prisma.ChatMessageWhereInput {
  return {
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
}

/** 焚毁存档:只看保留期内的,不受用户清空水位影响。 */
function archiveWhere(
  id: string,
  q: ImMessageQueryDto,
): Prisma.ChatBurnArchiveWhereInput {
  return {
    conversationID: id,
    retainUntil: { gt: new Date() },
    ...(q.cursor ? { height: { lt: q.cursor } } : {}),
    ...(q.senderId ? { senderID: q.senderId } : {}),
    ...(q.from || q.to
      ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to ? { lte: new Date(q.to) } : {}),
          },
        }
      : {}),
    ...(q.text
      ? {
          type: 'text',
          content: { path: ['text'], string_contains: q.text },
        }
      : {}),
  };
}

type AdminReadRow = {
  id: string;
  height: number;
  senderID: string | null;
  type: string;
  content: Prisma.JsonValue;
  createdAt: Date;
  burnExpiresAt: Date | null;
  burnDurationSec: number | null;
};

/**
 * 锁内按主键复核候选(最多 limit+1 条)。过滤条件取锁后的会话状态:扫描之后才提交的
 * 清空 / 撤回 / 删除 / 过期一律生效;正文也在锁内读。
 */
async function recheckCandidates(
  tx: Prisma.TransactionClient,
  id: string,
  q: ImMessageQueryDto,
  conversation: ChatBurnPolicy & { clearedBeforeHeight: number },
  archive: boolean,
  ids: string[],
): Promise<AdminReadRow[]> {
  if (ids.length === 0) return [];
  if (archive) {
    const archived = await tx.chatBurnArchive.findMany({
      where: { ...archiveWhere(id, q), id: { in: ids } },
      orderBy: { height: 'desc' },
    });
    return archived.map((row) => ({ ...row, burnExpiresAt: row.retainUntil }));
  }
  return tx.chatMessage.findMany({
    where: { ...messageWhere(id, q, conversation), id: { in: ids } },
    orderBy: { height: 'desc' },
    select: {
      id: true,
      height: true,
      senderID: true,
      type: true,
      content: true,
      createdAt: true,
      burnExpiresAt: true,
      burnDurationSec: true,
    },
  });
}

/**
 * 下一页游标。候选都还在时与原来一致:多取的第 limit+1 条存在就有下一页,游标是本页
 * 最后一条。有候选在扫描后被清空 / 撤回时,最低候选以上都已复核过,下一页从它往下
 * 接着找 —— 不漏也不重复(本页可能不足 limit 条,与按过期过滤后的短页同一种情况)。
 */
function pageCursor(
  candidates: ReadonlyArray<{ height: number }>,
  survivors: ReadonlyArray<{ height: number }>,
  limit: number,
): number | null {
  if (survivors.length > limit) return survivors[limit - 1].height;
  if (candidates.length > limit)
    return candidates[candidates.length - 1].height;
  return null;
}

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
        circle: circles.find((c) => c.id === r.circleID) ?? null,
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
  async messages(
    actorID: string,
    id: string,
    q: ImMessageQueryDto,
    archive = false,
  ) {
    if (q.from && q.to && new Date(q.from) > new Date(q.to))
      throw new BadRequestException('Invalid date range');
    const result = await this.prisma.$transaction(async (tx) => {
      // Recheck after the HTTP guard. Hold both account and grant rows until
      // the content read and its audit record commit, ordering against revoke.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorID} FOR SHARE`;
      await tx.$queryRaw`SELECT "userID" FROM "AdminAccess" WHERE "userID" = ${actorID} FOR SHARE`;
      const actor = await tx.user.findUnique({
        where: { id: actorID },
        select: {
          role: true,
          status: true,
          adminAccess: { select: { role: true } },
        },
      });
      if (
        actor?.role !== 'ADMIN' ||
        actor.status !== 'ACTIVE' ||
        !actor.adminAccess ||
        !(ADMIN_ROLE_PERMISSIONS[actor.adminAccess.role] ?? []).includes(
          archive ? 'IM_ARCHIVE_READ' : 'IM_READ',
        )
      ) {
        throw new ForbiddenException('无权限查看聊天记录');
      }
      // 慢的那一步(关键词 / 发送者 / 日期过滤可能要把整个会话扫一遍)放在拿会话锁之前,
      // 只取候选 id 与 height。发送路径对会话行 FOR UPDATE:以前整段扫描都持着下面那把
      // FOR SHARE,大群里搜一个罕见词,扫多久这个会话就多久发不出消息。账号 / 授权两行
      // 的 FOR SHARE 不动,吊销照旧排在这次读取和审计提交之后。
      const snapshot = await tx.chatConversation.findUnique({
        where: { id },
        select: {
          type: true,
          clearedBeforeHeight: true,
          burnDurationSec: true,
          burnStartedAt: true,
        },
      });
      assertReadableConversation(snapshot);
      const candidates = archive
        ? await tx.chatBurnArchive.findMany({
            where: archiveWhere(id, q),
            orderBy: { height: 'desc' },
            take: q.limit + 1,
            select: { id: true, height: true },
          })
        : await tx.chatMessage.findMany({
            where: messageWhere(id, q, snapshot),
            orderBy: { height: 'desc' },
            take: q.limit + 1,
            select: { id: true, height: true },
          });
      // The shared conversation lock orders this read against clear/recall/burn writes.
      await tx.$queryRaw`SELECT "id" FROM "ChatConversation" WHERE "id" = ${id} FOR SHARE`;
      const conversation = await tx.chatConversation.findUnique({
        where: { id },
      });
      assertReadableConversation(conversation);
      const survivors = await recheckCandidates(
        tx,
        id,
        q,
        conversation,
        archive,
        candidates.map((candidate) => candidate.id),
      );
      const rows = survivors.slice(0, q.limit);
      const nextCursor = pageCursor(candidates, survivors, q.limit);
      const observedAt = Date.now();
      // Never record message bodies or text filters (which themselves may contain private content).
      await tx.adminAuditLog.create({
        data: {
          actorID,
          action: archive ? 'IM_BURN_ARCHIVE_READ' : 'IM_MESSAGES_READ',
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
            returned: rows.length,
          },
        },
      });
      return {
        rows,
        nextCursor,
        conversation,
        observedAt,
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
      // A pending read has no expiry yet. Limit this audited display lease to
      // one burn window from the snapshot, so a later read cannot leave an
      // already-open admin page displaying content past its eventual expiry.
      // The administrator can explicitly re-query if it is still unread.
      visibleUntil:
        r.burnExpiresAt?.toISOString() ??
        (r.burnDurationSec
          ? new Date(result.observedAt + r.burnDurationSec * 1000).toISOString()
          : null),
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
      nextCursor: result.nextCursor,
      source: archive ? 'BURN_ARCHIVE' : 'SELF_HOSTED',
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

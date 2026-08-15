import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import { TempChatStatus } from 'src/generated/prisma';
import { TempChatErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatBroadcastService } from 'src/chat/chat-broadcast.service';
import { ChatService } from 'src/chat/chat.service';
import { NoteService } from 'src/note/note.service';
import type { NoteDetailDto } from 'src/note/dto/note.dto';
import {
  LinkTokenService,
  type GuestChatTokenPayload,
} from './link-token.service';
import { CreateTempChatDto } from './dto/create-temp-chat.dto';
import { JoinTempChatDto } from './dto/join-temp-chat.dto';
import { newGroupId, newGuestId } from './temp-chat.ids';

export interface CreateTempChatResult {
  id: string;
  groupId: string;
  conversationId: string;
  title: string;
  maxMembers: number;
  expiresAt: string;
  shareUrl: string;
}

export interface TempChatMeta {
  title: string;
  memberCount: number;
  maxMembers: number;
  status: string;
  expiresAt: string;
  full: boolean;
}

export interface TempChatListItem {
  id: string;
  groupId: string;
  conversationId: string | null;
  title: string;
  status: string;
  guestCount: number;
  memberCount: number;
  maxMembers: number;
  expiresAt: string;
  createdAt: string;
  endedAt: string | null;
  shareUrl: string | null;
}

/** 访客可见的成员条目:头衔只区分「房主 / 其他」,不外泄圈子角色。 */
export interface TempChatMemberItem {
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  isHost: boolean;
}

export interface JoinTempChatResult {
  guestId: string;
  displayName: string;
  conversationId: string;
  /** 访客聊天凭证:socket 握手 auth.token 与访客历史接口 Bearer 共用。 */
  chatToken: string;
  /** socket.io 挂载路径(origin 用 API 同源)。 */
  wsPath: string;
}

const MAX_ACTIVE_ROOMS_PER_HOST = 200;

/**
 * 临时聊天(自研栈版):房间 ←→ ChatConversation(type=TEMP) 一一对应,
 * 访客以 TempChatGuest 身份(非 User 行)入座 ChatMember;凭证与实时通道
 * 全部走自研 chat —— OpenIM 的注册/建群/发token/强退在本模块已出清。
 */
@Injectable()
export class TempChatService {
  private static readonly CLEANUP_LEASE_MS = 2 * 60 * 1000;
  private readonly logger = new Logger(TempChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly linkToken: LinkTokenService,
    private readonly config: ConfigService,
    private readonly chatBroadcast: ChatBroadcastService,
    private readonly chatService: ChatService,
    private readonly noteService: NoteService,
  ) {}

  async create(
    hostUserId: string,
    dto: CreateTempChatDto,
  ): Promise<CreateTempChatResult> {
    const title = (dto.title?.trim() || '临时聊天').slice(0, 30);
    const ttlMinutes =
      dto.ttlMinutes ??
      this.config.get<number>('TEMP_CHAT_DEFAULT_TTL_MINUTES', 4320);
    const maxMembers =
      dto.maxMembers ?? this.config.get<number>('TEMP_CHAT_MAX_MEMBERS', 50);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

    // round 3 review:/mine 有 200 条护栏 —— 上限与护栏对齐;count+create 在
    // 同一把 per-host advisory 锁里,防两个 199→200 的并发请求落成 201。
    // (原先「先建 OpenIM 群再落库」的两段式与回滚补偿随 OpenIM 一并移除:
    // 会话行与房间行现在同事务原子创建,不存在孤儿群问题。)
    const quotaLockKey = `temp-chat:${hostUserId}`;
    const groupId = newGroupId();
    const { row, conversationId } = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${quotaLockKey}))`;
        const active = await tx.tempChat.count({
          where: { hostUserId, endedAt: null, expiresAt: { gt: new Date() } },
        });
        if (active >= MAX_ACTIVE_ROOMS_PER_HOST) {
          throw new BadRequestException(
            `活跃临时聊天数量已达上限（${MAX_ACTIVE_ROOMS_PER_HOST}），请先结束不再使用的房间`,
          );
        }
        const row = await tx.tempChat.create({
          data: { groupId, hostUserId, title, maxMembers, expiresAt },
        });
        const conversation = await tx.chatConversation.create({
          data: {
            type: 'TEMP',
            tempChatID: row.id,
            members: { create: [{ userID: hostUserId }] },
          },
          select: { id: true },
        });
        return { row, conversationId: conversation.id };
      },
    );

    // 房主已在线的 socket 立即入房,不必等重连。
    void this.chatBroadcast
      .joinUserToConversation(hostUserId, conversationId)
      .catch(() => undefined);

    const seconds = Math.max(
      1,
      Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    );
    const token = this.linkToken.sign(row.id, seconds);
    const base = this.config.get<string>('TEMP_CHAT_WEB_BASE', '');
    return {
      id: row.id,
      groupId: row.groupId,
      conversationId,
      title: row.title,
      maxMembers: row.maxMembers,
      expiresAt: row.expiresAt.toISOString(),
      shareUrl: `${base}/t/${token}`,
    };
  }

  async getByToken(token: string): Promise<TempChatMeta> {
    const { tcId } = this.linkToken.verify(token); // 抛错 → 调用方转 404
    const room = await this.prisma.tempChat.findUnique({ where: { id: tcId } });
    if (
      !room ||
      room.status !== 'ACTIVE' ||
      room.expiresAt.getTime() <= Date.now()
    ) {
      throw new GoneException({
        message: '临时聊天已结束',
        errorCode: TempChatErrorCode.Ended,
      });
    }
    const memberCount = await this.prisma.tempChatGuest.count({
      where: { tempChatId: tcId, provisioningFailedAt: null },
    });
    return {
      title: room.title,
      memberCount,
      maxMembers: room.maxMembers,
      status: room.status,
      expiresAt: room.expiresAt.toISOString(),
      full: memberCount >= room.maxMembers,
    };
  }

  async listMine(hostUserId: string): Promise<TempChatListItem[]> {
    const rows = await this.prisma.tempChat.findMany({
      where: { hostUserId },
      orderBy: [{ createdAt: 'desc' }],
      take: 200, // #108：防爆护栏
      include: {
        _count: {
          select: { guests: { where: { provisioningFailedAt: null } } },
        },
      },
    });
    const conversations = await this.prisma.chatConversation.findMany({
      where: { tempChatID: { in: rows.map((row) => row.id) } },
      select: { id: true, tempChatID: true },
    });
    const conversationByRoom = new Map(
      conversations.map((c) => [c.tempChatID, c.id]),
    );

    const base = this.config.get<string>('TEMP_CHAT_WEB_BASE', '');
    const now = Date.now();

    return rows.map((row) => {
      const guestCount = row._count.guests;
      const remainingSeconds = Math.floor(
        (row.expiresAt.getTime() - now) / 1000,
      );
      const conversationId = conversationByRoom.get(row.id) ?? null;
      // 拆栈前建的房间没有 ChatConversation。这类行照旧报 ACTIVE 并签一个新的
      // 分享链接,而 join 走到最后会把「会话缺失」当成房间已结束 —— 房主可以
      // 反复分享一条对访客必然失败的链接,自己却完全看不出问题。
      // 状态口径与 join 的实际行为对齐:没有会话 = 不可加入。
      const migrationPending =
        row.status === TempChatStatus.ACTIVE && conversationId === null;
      const effectiveStatus =
        row.status === TempChatStatus.ACTIVE &&
        (remainingSeconds <= 0 || migrationPending)
          ? TempChatStatus.EXPIRED
          : row.status;
      const shareUrl =
        effectiveStatus === TempChatStatus.ACTIVE
          ? `${base}/t/${this.linkToken.sign(row.id, Math.max(1, remainingSeconds))}`
          : null;

      return {
        id: row.id,
        groupId: row.groupId,
        conversationId,
        title: row.title,
        status: effectiveStatus,
        guestCount,
        memberCount: guestCount + 1,
        maxMembers: row.maxMembers,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        shareUrl,
      };
    });
  }

  async join(token: string, dto: JoinTempChatDto): Promise<JoinTempChatResult> {
    const { tcId } = this.linkToken.verify(token);
    const displayName = (
      dto.displayName?.trim() || `访客${randomInt(1000, 10000)}`
    ).slice(0, 20);
    const guestId = newGuestId();

    // 原子占座：Serializable 事务内复查房间状态 + 人数后建 guest 行与座位。
    // 既防并发超员,也关上「加入与销毁同时发生」的竞态 —— 销毁后占不到座。
    const { room, conversationId } = await this.prisma.$transaction(
      async (tx) => {
        const roomLockKey = `temp-chat:${tcId}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${roomLockKey}))`;
        const room = await tx.tempChat.findUnique({ where: { id: tcId } });
        if (
          !room ||
          room.status !== 'ACTIVE' ||
          room.expiresAt.getTime() <= Date.now()
        ) {
          throw new GoneException({
            message: '临时聊天已结束',
            errorCode: TempChatErrorCode.Ended,
          });
        }
        const conversation = await tx.chatConversation.findUnique({
          where: { tempChatID: tcId },
          select: { id: true },
        });
        if (!conversation) {
          // 旧 OpenIM 时代遗留房间没有会话行:按已结束处理,不再补建。
          throw new GoneException({
            message: '临时聊天已结束',
            errorCode: TempChatErrorCode.Ended,
          });
        }
        const count = await tx.tempChatGuest.count({
          where: { tempChatId: tcId, provisioningFailedAt: null },
        });
        if (count >= room.maxMembers) {
          throw new ConflictException({
            message: '人数已满',
            errorCode: TempChatErrorCode.Full,
          });
        }
        await tx.tempChatGuest.create({
          data: { tempChatId: tcId, imUserId: guestId, displayName },
        });
        await tx.chatMember.create({
          data: { conversationID: conversation.id, userID: guestId },
        });
        return { room, conversationId: conversation.id };
      },
      { isolationLevel: 'Serializable' },
    );

    const remainingSeconds = Math.max(
      1,
      Math.floor((room.expiresAt.getTime() - Date.now()) / 1000),
    );
    const chatToken = this.linkToken.signGuest(
      { guestId, tcId, conversationId },
      remainingSeconds,
    );
    return {
      guestId,
      displayName,
      conversationId,
      chatToken,
      wsPath: '/chat-ws',
    };
  }

  /**
   * 访客成员目录:复用会话成员目录(在座 + 展示名,访客走 TempChatGuest 兜底),
   * 再按 TempChat.hostUserId 标出房主 —— TEMP 会话没有 circleID,
   * ChatMemberDto.role 恒为 null,房主身份只有这里知道。
   * 鉴权由 chatService.listMembers 的 requireMembership 兜底:凭证里的 guestId
   * 必须仍在座,离座访客拿不到名单。
   */
  async listGuestMembers(
    guest: GuestChatTokenPayload,
  ): Promise<TempChatMemberItem[]> {
    const [room, members] = await Promise.all([
      this.prisma.tempChat.findUnique({
        where: { id: guest.tcId },
        select: { hostUserId: true },
      }),
      this.chatService.listMembers(guest.guestId, guest.conversationId),
    ]);
    return members.map((member) => ({
      userId: member.userId,
      nickname: member.nickname,
      avatarUrl: member.avatarUrl,
      isHost: member.userId === room?.hostUserId,
    }));
  }

  async getGuestNote(
    guest: GuestChatTokenPayload,
    messageId: string,
  ): Promise<NoteDetailDto> {
    const noteId = await this.chatService.getNoteCardNoteId(
      guest.guestId,
      guest.conversationId,
      messageId,
    );
    return this.noteService.getSharedNoteForGuest(noteId);
  }

  async end(hostUserId: string, id: string): Promise<{ status: string }> {
    const room = await this.prisma.tempChat.findUniqueOrThrow({
      where: { id },
    });
    if (room.hostUserId !== hostUserId) {
      throw new ForbiddenException({
        message: '只有创建者可以结束',
        errorCode: TempChatErrorCode.CreatorOnly,
      });
    }
    if (room.status !== 'ACTIVE') {
      return { status: room.status };
    }
    const finalStatus = await this.teardown(room, TempChatStatus.ENDED);
    return { status: finalStatus };
  }

  /**
   * 结束房间:落库状态 + 访客离座 + 断开访客 socket。幂等:仅对 ACTIVE 房调用。
   * 全部是本地库/本进程操作;租约与 cleanedUp 语义保留,兼容旧行重扫。
   */
  async teardown(
    room: { id: string; groupId: string },
    status: TempChatStatus,
  ): Promise<TempChatStatus> {
    const claim = await this.prisma.$transaction(async (tx) => {
      const roomLockKey = `temp-chat:${room.id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${roomLockKey}))`;
      const current = await tx.tempChat.findUnique({ where: { id: room.id } });
      if (!current) {
        return {
          finalStatus: status,
          shouldCleanup: false,
          guests: [] as { imUserId: string }[],
          conversationId: null as string | null,
        };
      }
      const finalStatus =
        current.status === TempChatStatus.ACTIVE ? status : current.status;
      const staleBefore = new Date(
        Date.now() - TempChatService.CLEANUP_LEASE_MS,
      );
      if (
        current.cleanupCompletedAt ||
        (current.cleanupLockedAt && current.cleanupLockedAt > staleBefore)
      ) {
        return {
          finalStatus,
          shouldCleanup: false,
          guests: [] as { imUserId: string }[],
          conversationId: null as string | null,
        };
      }
      const claimedAt = new Date();
      await tx.tempChat.update({
        where: { id: room.id },
        data: {
          status: finalStatus,
          endedAt: current.endedAt ?? claimedAt,
          cleanupLockedAt: claimedAt,
        },
      });
      const guests = await tx.tempChatGuest.findMany({
        where: { tempChatId: room.id, cleanedUp: false },
        select: { imUserId: true },
      });
      const conversation = await tx.chatConversation.findUnique({
        where: { tempChatID: room.id },
        select: { id: true },
      });
      if (conversation && guests.length > 0) {
        // 访客座位统一离座:membership 校验即刻拒发,历史仍留给房主。
        await tx.chatMember.updateMany({
          where: {
            conversationID: conversation.id,
            userID: { in: guests.map((g) => g.imUserId) },
            leftAt: null,
          },
          data: { leftAt: claimedAt },
        });
      }
      if (guests.length > 0) {
        await tx.tempChatGuest.updateMany({
          where: {
            tempChatId: room.id,
            imUserId: { in: guests.map((g) => g.imUserId) },
          },
          data: { cleanedUp: true },
        });
      }
      await tx.tempChat.updateMany({
        where: { id: room.id, cleanupLockedAt: claimedAt },
        data: { cleanupCompletedAt: new Date(), cleanupLockedAt: null },
      });
      return {
        finalStatus,
        shouldCleanup: true,
        guests,
        conversationId: conversation?.id ?? null,
      };
    });

    if (!claim.shouldCleanup) return claim.finalStatus;

    // 断开访客在线 socket(尽力而为;凭证过期与 membership 校验双重兜底)。
    for (const guest of claim.guests) {
      void this.chatBroadcast
        .disconnectUser(guest.imUserId)
        .catch(() => undefined);
    }
    return claim.finalStatus;
  }
}

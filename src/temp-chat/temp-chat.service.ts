import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'crypto';
import {
  TEMP_CHAT_HOST_ALIAS,
  isGuestUserId,
  toGuestMessageView,
} from 'src/chat/chat-guest-view';
import type { ChatHistoryPageDto } from 'src/chat/chat.types';
import { TempChatStatus } from 'src/generated/prisma';
import { ChatErrorCode, TempChatErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatBroadcastService } from 'src/chat/chat-broadcast.service';
import { ChatService } from 'src/chat/chat.service';
import { NoteService } from 'src/note/note.service';
import { SensitiveWordService } from 'src/sensitive-word/sensitive-word.service';
import type { NoteDetailDto } from 'src/note/dto/note.dto';
import {
  LinkTokenService,
  type GuestChatTokenPayload,
} from './link-token.service';
import { CreateTempChatDto } from './dto/create-temp-chat.dto';
import { JoinTempChatDto } from './dto/join-temp-chat.dto';
import { newGroupId, newGuestId } from './temp-chat.ids';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';

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
 * 每人每天最多新建的临时聊天数。删掉的房间照样算(软删行还在),否则建了删、
 * 删了建就能无限开房。
 *
 * 「天」按北京时间自然日(UTC+8,无夏令时)零点重置:用户在国内,UTC 日界落在
 * 北京时间早上八点,和「每天」的直觉对不上。滚动 24 小时窗口同样不好解释
 * 「什么时候能再建」。
 */
const DAILY_CREATE_LIMIT = 5;
const QUOTA_DAY_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** now 所在北京时间自然日的零点(返回的是对应的 UTC 时刻)。 */
function startOfQuotaDay(now: Date): Date {
  const shifted = now.getTime() + QUOTA_DAY_OFFSET_MS;
  return new Date(shifted - (shifted % DAY_MS) - QUOTA_DAY_OFFSET_MS);
}

/**
 * 临时聊天(自研栈版):房间 ←→ ChatConversation(type=TEMP) 一一对应,
 * 访客以 TempChatGuest 身份(非 User 行)入座 ChatMember;凭证与实时通道
 * 全部走自研 chat —— OpenIM 的注册/建群/发token/强退在本模块已出清。
 */
/** 访客昵称上限(与 JoinTempChatDto 的 MaxLength 一致)。 */
const GUEST_DISPLAY_NAME_MAX = 20;

/**
 * 访客昵称里要剥掉的字符:C0/C1 控制符(\p{Cc},含换行/制表)、行/段分隔符,以及
 * 改写显示方向的双向格式符(ALM、LRM/RLM、嵌入/覆盖 U+202A–U+202E、隔离
 * U+2066–U+2069)。零宽连接符 U+200C/U+200D 不在其列:它们是 emoji 序列与部分
 * 文字的组成部分,不是控制符。
 */
const UNSAFE_GUEST_NAME_CHARACTERS =
  /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

@Injectable()
export class TempChatService {
  private static readonly CLEANUP_LEASE_MS = 2 * 60 * 1000;
  private readonly logger = new Logger(TempChatService.name);

  private readonly loggingConfig = createLoggingConfig();
  constructor(
    private readonly prisma: PrismaService,
    private readonly linkToken: LinkTokenService,
    private readonly config: ConfigService,
    private readonly chatBroadcast: ChatBroadcastService,
    private readonly chatService: ChatService,
    private readonly noteService: NoteService,
    private readonly sensitiveWords: SensitiveWordService,
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
    // 每日配额同理:两个并发的第 5 个请求在锁里排队,后一个看得到前一个的行。
    // (原先「先建 OpenIM 群再落库」的两段式与回滚补偿随 OpenIM 一并移除:
    // 会话行与房间行现在同事务原子创建,不存在孤儿群问题。)
    const quotaLockKey = `temp-chat:${hostUserId}`;
    const groupId = newGroupId();
    const { row, conversationId } = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${quotaLockKey}))`;
        const createdToday = await tx.tempChat.count({
          where: {
            hostUserId,
            createdAt: { gte: startOfQuotaDay(new Date()) },
          },
        });
        if (createdToday >= DAILY_CREATE_LIMIT) {
          throw new BadRequestException({
            message: `每天最多创建 ${DAILY_CREATE_LIMIT} 个临时聊天，今天的次数已用完`,
            errorCode: TempChatErrorCode.DailyCreateLimit,
          });
        }
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
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'temp_chat_created',
      actorId: hostUserId,
      result: 'success',
      entityType: 'temp_chat',
      entityId: row.id,
      metadata: { maxMembers: row.maxMembers },
    });
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
    const include = {
      _count: {
        select: { guests: { where: { provisioningFailedAt: null } } },
      },
    } as const;
    const activeRows = await this.prisma.tempChat.findMany({
      where: {
        hostUserId,
        deletedAt: null,
        status: TempChatStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 200, // #108：防爆护栏
      include,
    });
    const remaining = 200 - activeRows.length;
    const activeIds = activeRows.map((row) => row.id);
    const recentRows =
      remaining > 0
        ? await this.prisma.tempChat.findMany({
            where: {
              hostUserId,
              deletedAt: null,
              ...(activeIds.length > 0 ? { id: { notIn: activeIds } } : {}),
            },
            orderBy: [{ createdAt: 'desc' }],
            take: remaining,
            include,
          })
        : [];
    const rows = [...activeRows, ...recentRows];
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
    const displayName = this.resolveGuestDisplayName(dto.displayName);
    const guestId = newGuestId();

    // 原子占座：在房间级 advisory 锁里复查房间状态 + 人数后建 guest 行与座位。
    // 既防并发超员,也关上「加入与销毁同时发生」的竞态 —— 销毁后占不到座。
    // 用默认的 READ COMMITTED:每条语句在拿到锁之后才取快照。Serializable 的
    // 快照在取锁那条语句开始时就固定了,排队拿到锁的事务读到旧人数、写入被判
    // 40001,同时点开链接的访客会直接失败。
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
   * 访客昵称:剥掉控制符与双向格式符、过敏感词闸;什么都不剩就随机生成。
   *
   * 这个名字会原样进房主的离线推送(chat-push 用 sender.nickname 拼标题/正文)与
   * 在座成员的界面:换行/控制符会把推送标题折成多行,双向覆盖符(U+202E 等)能把
   * 字样倒序伪装。敏感词与聊天正文/编辑同一条闸 —— 命中直接拒、不打码,错误码沿用
   * CHAT_SENSITIVE_WORD_BLOCKED。随机兜底名不是用户输入,不过闸。
   * 必须在占座事务之前判定:拒掉的访客不能先占掉一个座位。
   */
  private resolveGuestDisplayName(raw: string | undefined): string {
    const cleaned = (raw ?? '')
      .replace(UNSAFE_GUEST_NAME_CHARACTERS, '')
      .trim()
      .slice(0, GUEST_DISPLAY_NAME_MAX)
      .trim();
    if (!cleaned) return `访客${randomInt(1000, 10000)}`;
    if (this.sensitiveWords.check(cleaned).blocked) {
      throw new BadRequestException({
        message: '昵称包含敏感词',
        errorCode: ChatErrorCode.SensitiveWord,
      });
    }
    return cleaned;
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
      // 访客页靠 isHost 认房主；账号成员（只有房主）的 UUID 换成房间内别名，
      // 与 chat:msg、访客历史的访客视图一致。
      userId: isGuestUserId(member.userId)
        ? member.userId
        : TEMP_CHAT_HOST_ALIAS,
      nickname: member.nickname,
      avatarUrl: member.avatarUrl,
      isHost: member.userId === room?.hostUserId,
    }));
  }

  /**
   * 访客历史(冷路径)。与 chat:msg 的访客视图同一口径:账号成员(只有房主)的 id 换成
   * 房间内别名;d 是发送者本机的幂等键,只有访客自己发的消息保留。
   */
  async getGuestHistory(
    guest: GuestChatTokenPayload,
    query: { beforeHeight?: number; limit?: number; afterHeight?: number },
  ): Promise<ChatHistoryPageDto> {
    const page = await this.chatService.getHistory(
      guest.guestId,
      guest.conversationId,
      query.beforeHeight,
      query.limit,
      // afterHeight 是重连增量补拉的游标:访客断线期间的消息靠它追平。
      { afterHeight: query.afterHeight },
    );
    return {
      ...page,
      messages: page.messages.map((message) => ({
        ...toGuestMessageView(message),
        d: message.sender?.id === guest.guestId ? message.d : null,
      })),
    };
  }

  async getGuestNote(
    guest: GuestChatTokenPayload,
    messageId: string,
  ): Promise<NoteDetailDto> {
    // 只认房主发出的卡片:访客自己铸的 note-card 不能成为读任意笔记的入口。
    // 房间行没了就没有房主可比对 —— fail closed,与守卫的「链接无效」同口径,
    // 不能退化成「不限发送者」。
    const room = await this.prisma.tempChat.findUnique({
      where: { id: guest.tcId },
      select: { hostUserId: true },
    });
    if (!room) {
      throw new NotFoundException({
        message: '链接无效',
        errorCode: TempChatErrorCode.LinkInvalid,
      });
    }
    const noteId = await this.chatService.getNoteCardNoteId(
      guest.guestId,
      guest.conversationId,
      messageId,
      room.hostUserId,
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
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'temp_chat_ended',
      actorId: hostUserId,
      result: 'success',
      entityType: 'temp_chat',
      entityId: id,
    });
    return { status: finalStatus };
  }

  /**
   * 房主删除房间(软删)。进行中的房间先走 end 那条 teardown —— 访客离座断线,
   * 分享链接随 status 不再是 ACTIVE 一并失效(访客页看到的是「已结束」);
   * 然后打 deletedAt、房主座位离座:房间从房主的临时聊天列表和消息列表里
   * 同时消失。聊天记录不物理删除,与结束后的房间一样留在库里。
   * 幂等:已经删过的直接返回;teardown 之后中途失败,重试会跳过 teardown 补完删除。
   */
  async remove(hostUserId: string, id: string): Promise<void> {
    const room = await this.prisma.tempChat.findUniqueOrThrow({
      where: { id },
    });
    if (room.hostUserId !== hostUserId) {
      throw new ForbiddenException({
        message: '只有创建者可以删除',
        errorCode: TempChatErrorCode.CreatorOnly,
      });
    }
    if (room.deletedAt) return;
    if (room.status === TempChatStatus.ACTIVE) {
      await this.teardown(room, TempChatStatus.ENDED);
    }
    const deletedAt = new Date();
    const { deleted, conversationId } = await this.prisma.$transaction(
      async (tx) => {
        const marked = await tx.tempChat.updateMany({
          where: { id, deletedAt: null },
          data: { deletedAt },
        });
        const conversation = await tx.chatConversation.findUnique({
          where: { tempChatID: id },
          select: { id: true },
        });
        if (conversation) {
          await tx.chatMember.updateMany({
            where: {
              conversationID: conversation.id,
              userID: hostUserId,
              leftAt: null,
            },
            data: { leftAt: deletedAt },
          });
        }
        return {
          deleted: marked.count > 0,
          conversationId: conversation?.id ?? null,
        };
      },
    );
    // 并发的另一次删除已经做完了收尾。
    if (!deleted) return;
    if (conversationId) {
      // 房主其他设备靠这条个人事件把会话从列表里收走。
      void this.chatBroadcast
        .removeUserFromConversation(hostUserId, conversationId)
        .catch(() => undefined);
      this.chatBroadcast.emitConversationChange(hostUserId, {
        kind: 'left',
        conversationId,
        userId: hostUserId,
      });
    }
    logBusinessEvent(this.logger, {
      enabled: this.loggingConfig.businessLogOn,
      businessEvent: 'temp_chat_deleted',
      actorId: hostUserId,
      result: 'success',
      entityType: 'temp_chat',
      entityId: id,
      metadata: { wasActive: room.status === TempChatStatus.ACTIVE },
    });
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

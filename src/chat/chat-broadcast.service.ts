import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatPresenceRegistry } from './chat-presence.registry';
import { CHAT_EVENTS, conversationRoom, userRoom } from './chat.constants';
import type {
  ChatConversationBroadcast,
  ChatDeliveredBroadcast,
  ChatEditBroadcast,
  ChatHistoryClearedBroadcast,
  ChatMessageDto,
  ChatReactionBroadcast,
  ChatReadBroadcast,
  ChatRevokeBroadcast,
  ChatTypingBroadcast,
} from './chat.types';

/**
 * 聊天广播出口(squady socket-broadcast.service 的移植)。
 * 网关 attach 时注入 io Server;其它模块(temp-chat 接线、系统消息)统一
 * 经此服务下发,不直接持有 io。
 */
@Injectable()
export class ChatBroadcastService {
  private readonly logger = new Logger(ChatBroadcastService.name);
  private server: Server | null = null;

  constructor(
    private readonly presence: ChatPresenceRegistry,
    private readonly prisma: PrismaService,
  ) {}

  setServer(server: Server): void {
    this.server = server;
  }

  /**
   * 新消息只投递给当前仍在座成员的个人房。
   *
   * 不能再把 conversation room 当授权边界：跨节点 RemoteSocket.leave()
   * 返回 void，没有 adapter ack 可等；被移除用户的远端 socket 可能暂时还留在
   * 旧会话房。个人房是连接期稳定标识，收件人则每次由当前 ChatMember 校验。
   */
  async emitMessage(message: ChatMessageDto): Promise<void> {
    await this.emitContentToAuthorizedUsers(
      'emitMessage',
      CHAT_EVENTS.message,
      message,
      [],
    );
  }

  /** 新消息 → 当前在座成员个人房，并显式排除指定用户的全部设备。 */
  async emitMessageExcludingUsers(
    message: ChatMessageDto,
    excludeUserIds: readonly string[],
  ): Promise<void> {
    const server = this.requireServer('emitMessageExcludingUsers');
    if (!server) return;
    await this.emitContentToAuthorizedUsers(
      'emitMessageExcludingUsers',
      CHAT_EVENTS.message,
      message,
      excludeUserIds,
      server,
    );
  }

  /** 已读水位推进 → 会话房。 */
  emitRead(payload: ChatReadBroadcast): void {
    const server = this.requireServer('emitRead');
    if (!server) return;
    server
      .to(conversationRoom(payload.conversationId))
      .emit(CHAT_EVENTS.read, payload);
  }

  /** 会话全局历史水位推进 → 会话房内所有在线设备。 */
  emitHistoryCleared(payload: ChatHistoryClearedBroadcast): void {
    const server = this.requireServer('emitHistoryCleared');
    if (!server) return;
    server
      .to(conversationRoom(payload.conversationId))
      .emit(CHAT_EVENTS.historyCleared, payload);
  }

  /** 正在输入 → 会话房内除本人外的成员。 */
  emitTyping(payload: ChatTypingBroadcast, excludeSocketId?: string): void {
    const server = this.requireServer('emitTyping');
    if (!server) return;
    const target = server.to(conversationRoom(payload.conversationId));
    (excludeSocketId ? target.except(excludeSocketId) : target).emit(
      CHAT_EVENTS.typing,
      payload,
    );
  }

  /**
   * 某用户当前是否有在线 socket(个人房占用判定)。
   * G-04:优先问跨实例注册表;Redis 不可用回退本实例 fetchSockets
   * (多实例 + adapter 下 fetchSockets 是跨节点 RPC,大群里很贵)。
   */
  async isUserOnline(userId: string): Promise<boolean> {
    const viaRegistry = await this.presence.isOnline(userId);
    if (viaRegistry !== null) return viaRegistry;
    const server = this.requireServer('isUserOnline');
    if (!server) return false;
    const sockets = await server.in(userRoom(userId)).fetchSockets();
    return sockets.length > 0;
  }

  /** 会话房内当前在线的 userId 集合(离线推送分流用);注册表优先。 */
  async getOnlineUserIdsInConversation(
    conversationId: string,
  ): Promise<Set<string>> {
    const viaRegistry = await this.presence.getOnlineUserIds(conversationId);
    if (viaRegistry !== null) return new Set(viaRegistry);
    const server = this.requireServer('getOnlineUserIdsInConversation');
    if (!server) return new Set();
    const sockets = await server
      .in(conversationRoom(conversationId))
      .fetchSockets();
    const ids = new Set<string>();
    for (const socket of sockets) {
      const userId = (socket.data as { userId?: unknown })?.userId;
      if (typeof userId === 'string') ids.add(userId);
    }
    return ids;
  }

  /** 断开某用户全部在线 socket(临时房结束/访客清退用)。 */
  async disconnectUser(userId: string): Promise<void> {
    const server = this.requireServer('disconnectUser');
    if (!server) return;
    const sockets = await server.in(userRoom(userId)).fetchSockets();
    for (const socket of sockets) {
      socket.disconnect(true);
    }
  }

  /**
   * 上/下线广播到其全部会话房(会话成员可见,与消息可见面一致)。
   *
   * excludeUserIds:与之互相拉黑的人。拉黑不动 ChatMember,座位照旧留着,
   * 所以不排除的话,拉黑双方仍会持续收到对方的上下线事件 —— 查询侧已经按
   * 拉黑收口了(filterVisiblePresenceTargets),广播侧不收口等于把同一份信息
   * 换个通道免费送出去,而且是推的、连轮询都不用。
   *
   * 每个用户都在自己的 u:{userId} 房里,所以用 except 一次覆盖单聊与群聊:
   * 单聊房里对端被排除即无人可收,群聊房里只少发给被拉黑的那几个人。
   */
  emitPresence(
    conversationIds: string[],
    payload: { userId: string; online: boolean },
    excludeUserIds: readonly string[] = [],
  ): void {
    const server = this.requireServer('emitPresence');
    if (!server || conversationIds.length === 0) return;
    const target = server.to(conversationIds.map(conversationRoom));
    const scoped = excludeUserIds.length
      ? target.except(excludeUserIds.map(userRoom))
      : target;
    scoped.emit(CHAT_EVENTS.presence, payload);
  }

  /** 定向下发(如会话新建/成员变更时通知个人房)。 */
  emitToUser(userId: string, event: string, payload: unknown): void {
    const server = this.requireServer('emitToUser');
    if (!server) return;
    server.to(userRoom(userId)).emit(event, payload);
  }

  /** 送达水位推进 → 会话房(发送方靠它渲染「已送达」)。 */
  emitDelivered(payload: ChatDeliveredBroadcast): void {
    const server = this.requireServer('emitDelivered');
    if (!server) return;
    server
      .to(conversationRoom(payload.conversationId))
      .emit(CHAT_EVENTS.delivered, payload);
  }

  /** 表情回应 → 会话房(发起者也收,幂等对账本地乐观状态)。 */
  emitReaction(payload: ChatReactionBroadcast): void {
    const server = this.requireServer('emitReaction');
    if (!server) return;
    server
      .to(conversationRoom(payload.conversationId))
      .emit(CHAT_EVENTS.reaction, payload);
  }

  /** 编辑包含完整新正文，与 chat:msg 共用当前在座成员授权投递。 */
  async emitEdit(payload: ChatEditBroadcast): Promise<void> {
    await this.emitContentToAuthorizedUsers(
      'emitEdit',
      CHAT_EVENTS.edit,
      payload,
      [],
    );
  }

  /** 消息撤回 → 会话房(发起者也收,靠它把本地气泡翻成灰条)。 */
  emitRevoke(payload: ChatRevokeBroadcast): void {
    const server = this.requireServer('emitRevoke');
    if (!server) return;
    server
      .to(conversationRoom(payload.conversationId))
      .emit(CHAT_EVENTS.revoke, payload);
  }

  /** 本人会话成员关系变化(入座/退出/被移出) → 个人房定向。 */
  emitConversationChange(
    userId: string,
    payload: ChatConversationBroadcast,
  ): void {
    this.emitToUser(userId, CHAT_EVENTS.conversation, payload);
  }

  /** 成员进群后把其在线 socket 拉入会话房(否则要重连才收得到消息)。 */
  async joinUserToConversation(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    // 注册表联动:座位变化时在线集合同步(内部会先确认该用户全局在线)。
    await this.presence.conversationJoined(userId, conversationId);
    const server = this.requireServer('joinUserToConversation');
    if (!server) return;
    const sockets = await server.in(userRoom(userId)).fetchSockets();
    // fetchSockets() exposes RemoteSocket.join(): void. Dispatching the room
    // update is best-effort; first-message delivery no longer depends on its
    // completion because chat:msg targets authorized personal rooms.
    for (const socket of sockets) {
      socket.join(conversationRoom(conversationId));
    }
  }

  /** 成员被移出后把其在线 socket 撤出会话房(座位收回即时生效,不等重连)。 */
  async removeUserFromConversation(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    await this.presence.conversationLeft(userId, conversationId);
    const server = this.requireServer('removeUserFromConversation');
    if (!server) return;
    const sockets = await server.in(userRoom(userId)).fetchSockets();
    // Socket.IO RemoteSocket.leave() returns void: calling it dispatches the
    // adapter command but provides no acknowledgement to await. Message
    // privacy therefore does not depend on this best-effort room cleanup;
    // emitMessage re-authorizes recipients against active ChatMember rows.
    for (const socket of sockets) {
      socket.leave(conversationRoom(conversationId));
    }
  }

  /**
   * 兜底驱逐:房间离不掉时直接断掉该用户的全部 socket。
   * 重连后 handleConnection 会按当前座位重新派生房间 —— 已经没座位的会话
   * 自然就不在里面了。
   */
  async disconnectUserSockets(userId: string): Promise<void> {
    const server = this.requireServer('disconnectUserSockets');
    if (!server) return;
    const sockets = await server.in(userRoom(userId)).fetchSockets();
    // RemoteSocket.disconnect() returns the socket itself, not an adapter ack.
    // Dispatch every fallback command; authorized user-room message delivery
    // remains the durable privacy boundary while remote cleanup converges.
    for (const socket of sockets) {
      socket.disconnect(true);
    }
  }

  private async emitContentToAuthorizedUsers(
    caller: string,
    event: string,
    payload: ChatMessageDto | ChatEditBroadcast,
    excludeUserIds: readonly string[],
    attachedServer?: Server,
  ): Promise<void> {
    const server = attachedServer ?? this.requireServer(caller);
    if (!server) return;

    // Presence registration happens after a socket becomes ready and may be
    // temporarily incomplete during Redis recovery. It is therefore never an
    // authorization or recipient filter. Empty user rooms are harmless; the
    // active ChatMember set is the durable delivery boundary.
    const seats = await this.prisma.chatMember.findMany({
      where: {
        conversationID: payload.conversationId,
        leftAt: null,
        // A delayed post-commit broadcast must not replay content below a
        // member's already-committed clear watermark.
        clearedBeforeHeight: { lt: payload.height },
      },
      select: { userID: true },
    });
    const excluded = new Set(excludeUserIds);
    const rooms = [
      ...new Set(
        seats
          .map((seat) => seat.userID)
          .filter((userId) => !excluded.has(userId))
          .map(userRoom),
      ),
    ];
    if (rooms.length === 0) return;
    server.to(rooms).emit(event, payload);
  }

  private requireServer(caller: string): Server | null {
    if (!this.server) {
      // attach 之前不应有业务调用;出现即是接线错误,记下但不崩发送方。
      this.logger.warn(`${caller} called before gateway attach`);
      return null;
    }
    return this.server;
  }
}

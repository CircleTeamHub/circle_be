import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';
import { CHAT_EVENTS, conversationRoom, userRoom } from './chat.constants';
import type {
  ChatMessageDto,
  ChatReadBroadcast,
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

  setServer(server: Server): void {
    this.server = server;
  }

  /** 新消息 → 会话房(发送者自己也收,靠 d 对账去重本地乐观消息)。 */
  emitMessage(message: ChatMessageDto): void {
    const server = this.requireServer('emitMessage');
    if (!server) return;
    server
      .to(conversationRoom(message.conversationId))
      .emit(CHAT_EVENTS.message, message);
  }

  /** 已读水位推进 → 会话房。 */
  emitRead(payload: ChatReadBroadcast): void {
    const server = this.requireServer('emitRead');
    if (!server) return;
    server
      .to(conversationRoom(payload.conversationId))
      .emit(CHAT_EVENTS.read, payload);
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

  /** 某用户当前是否有在线 socket(个人房占用判定)。 */
  async isUserOnline(userId: string): Promise<boolean> {
    const server = this.requireServer('isUserOnline');
    if (!server) return false;
    const sockets = await server.in(userRoom(userId)).fetchSockets();
    return sockets.length > 0;
  }

  /** 会话房内当前在线的 userId 集合(离线推送分流用)。 */
  async getOnlineUserIdsInConversation(
    conversationId: string,
  ): Promise<Set<string>> {
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

  /** 上/下线广播到其全部会话房(会话成员可见,与消息可见面一致)。 */
  emitPresence(
    conversationIds: string[],
    payload: { userId: string; online: boolean },
  ): void {
    const server = this.requireServer('emitPresence');
    if (!server || conversationIds.length === 0) return;
    server
      .to(conversationIds.map(conversationRoom))
      .emit(CHAT_EVENTS.presence, payload);
  }

  /** 定向下发(如会话新建/成员变更时通知个人房)。 */
  emitToUser(userId: string, event: string, payload: unknown): void {
    const server = this.requireServer('emitToUser');
    if (!server) return;
    server.to(userRoom(userId)).emit(event, payload);
  }

  /** 成员进群后把其在线 socket 拉入会话房(否则要重连才收得到消息)。 */
  async joinUserToConversation(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const server = this.requireServer('joinUserToConversation');
    if (!server) return;
    const sockets = await server.in(userRoom(userId)).fetchSockets();
    for (const socket of sockets) {
      socket.join(conversationRoom(conversationId));
    }
  }

  /** 成员被移出后把其在线 socket 撤出会话房(座位收回即时生效,不等重连)。 */
  async removeUserFromConversation(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const server = this.requireServer('removeUserFromConversation');
    if (!server) return;
    const sockets = await server.in(userRoom(userId)).fetchSockets();
    for (const socket of sockets) {
      socket.leave(conversationRoom(conversationId));
    }
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

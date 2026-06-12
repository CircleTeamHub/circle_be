import { Injectable, NotFoundException } from '@nestjs/common';
import { OpenimService, type OpenimMessage } from 'src/openim/openim.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import {
  ChatHistoryMessagePageDto,
  RestorableMessageDto,
} from './dto/chat-history.dto';

/**
 * Reads restorable OpenIM history for a conversation via OpenIM's HTTP API
 * (/msg/pull_msg_by_seq + /msg/get_conversations_has_read_and_max_seq), acting
 * as the conversation member with an admin token. OpenIM applies its own
 * visibility / revoke / "delete for me" filtering, so we never touch its Mongo
 * internals (sharding, seq docs) — that coupling lived here before and is gone.
 */
@Injectable()
export class ChatHistoryService {
  private static readonly MAX_PAGE_SIZE = 200;

  constructor(
    private readonly openim: OpenimService,
    private readonly privacySettings: PrivacySettingsService,
  ) {}

  async getMessages(
    userId: string,
    conversationID: string,
    limit = 100,
    beforeSeq?: number,
  ): Promise<ChatHistoryMessagePageDto> {
    const currentImUserID = OpenimService.toImUserId(userId);
    await this.validateConversationAccess(conversationID, currentImUserID);

    const pageSize = Math.max(
      1,
      Math.min(ChatHistoryService.MAX_PAGE_SIZE, Number(limit) || 100),
    );

    const maxSeq = await this.openim.getConversationMaxSeq(
      userId,
      conversationID,
    );
    if (maxSeq <= 0) return this.emptyPage(conversationID);

    // beforeSeq is exclusive: caller wants messages strictly older than it.
    const end =
      beforeSeq == null ? maxSeq : Math.min(maxSeq, Math.floor(beforeSeq) - 1);
    if (end < 1) {
      return { ...this.emptyPage(conversationID), serverMaxSeq: maxSeq };
    }

    const { messages: raw } = await this.openim.pullConversationMessages({
      userID: userId,
      conversationID,
      begin: 1,
      end,
      num: pageSize,
    });

    const selfDestructCutoff = await this.getSelfDestructCutoff(userId);

    const messages = raw
      .map((message) => this.toRestorableMessage(message))
      .filter((message) => Number.isFinite(message.seq) && message.seq <= end)
      .filter((message) =>
        this.isWithinSelfDestructWindow(message, selfDestructCutoff),
      )
      .sort((left, right) => left.seq - right.seq);

    // Cursor pagination: a full page implies older messages may remain; an
    // under-filled page means OpenIM returned everything ≤ end (num caps the
    // count, so under-fill is authoritative) → nothing older to fetch.
    const oldestSeq = messages[0]?.seq ?? 0;
    const hasMore = messages.length >= pageSize && oldestSeq > 1;
    const nextBeforeSeq = hasMore ? oldestSeq : null;

    return {
      conversationID,
      messages,
      hasMore,
      nextBeforeSeq,
      // OpenIM's HTTP API exposes maxSeq but not a conversation-global minSeq.
      serverMinSeq: null,
      serverMaxSeq: maxSeq,
    };
  }

  /**
   * single (si_<a>_<b>): caller must be one of the two participants — a pure
   * string check. group (sg_<groupID>): caller must be a current member, via
   * OpenIM's group API. Anything else → 404.
   */
  private async validateConversationAccess(
    conversationID: string,
    currentImUserID: string,
  ): Promise<void> {
    if (conversationID.startsWith('si_')) {
      const participantIDs = conversationID.slice(3).split('_');
      if (
        participantIDs.length !== 2 ||
        participantIDs.some((participantID) => !participantID) ||
        !participantIDs.includes(currentImUserID)
      ) {
        throw new NotFoundException('会话不存在');
      }
      return;
    }

    if (conversationID.startsWith('sg_')) {
      const groupID = conversationID.slice(3);
      if (!groupID) {
        throw new NotFoundException('会话不存在');
      }
      const isMember = await this.openim.isGroupMember(
        groupID,
        currentImUserID,
      );
      if (!isMember) {
        throw new NotFoundException('会话不存在');
      }
      return;
    }

    throw new NotFoundException('会话不存在');
  }

  private toRestorableMessage(msg: OpenimMessage): RestorableMessageDto {
    return {
      clientMsgID: String(msg.clientMsgID ?? ''),
      serverMsgID: String(msg.serverMsgID ?? ''),
      sendID: String(msg.sendID ?? ''),
      recvID: String(msg.recvID ?? ''),
      groupID: String(msg.groupID ?? ''),
      senderNickname: String(msg.senderNickname ?? ''),
      senderFaceUrl: String(msg.senderFaceURL ?? ''),
      senderPlatformID: Number(msg.senderPlatformID ?? 0),
      sessionType: Number(msg.sessionType ?? 0),
      msgFrom: Number(msg.msgFrom ?? 0),
      contentType: Number(msg.contentType ?? 0),
      status: Number(msg.status ?? 0),
      seq: Number(msg.seq ?? 0),
      sendTime: Number(msg.sendTime ?? 0),
      createTime: Number(msg.createTime ?? 0),
      content: String(msg.content ?? ''),
      attachedInfo: String(msg.attachedInfo ?? ''),
      ex: String(msg.ex ?? ''),
      isRead: Boolean(msg.isRead),
    };
  }

  private async getSelfDestructCutoff(userId: string): Promise<number | null> {
    const { messageSelfDestructDays } =
      await this.privacySettings.getSettings(userId);
    if (!messageSelfDestructDays) return null;
    return Date.now() - messageSelfDestructDays * 24 * 60 * 60 * 1000;
  }

  private isWithinSelfDestructWindow(
    message: RestorableMessageDto,
    cutoff: number | null,
  ) {
    if (cutoff == null) return true;
    const timestamp = message.sendTime || message.createTime;
    if (!Number.isFinite(timestamp) || timestamp <= 0) return true;
    return timestamp >= cutoff;
  }

  private emptyPage(conversationID: string): ChatHistoryMessagePageDto {
    return {
      conversationID,
      messages: [],
      hasMore: false,
      nextBeforeSeq: null,
      serverMinSeq: null,
      serverMaxSeq: null,
    };
  }
}

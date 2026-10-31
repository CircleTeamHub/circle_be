import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatBroadcastService } from 'src/chat/chat-broadcast.service';
import { ChatService } from 'src/chat/chat.service';
import { ChatSystemMessageService } from 'src/chat/chat-system-message.service';
import type { ChatConversationDto, ChatMessageDto } from 'src/chat/chat.types';
import {
  ASSISTANT_AVATAR_KEY,
  ASSISTANT_CONVERSATION_PREFIX,
  ASSISTANT_DISPLAY_NAME,
  ASSISTANT_INFO_ALERT_MESSAGE_TYPE,
  ASSISTANT_KEY,
  ASSISTANT_NOTE_STATUS_MESSAGE_TYPE,
  ASSISTANT_SYSTEM_SENDER_ID,
} from './assistant.constants';
import type { InfoAlertPayload } from './assistant-subscription.service';

export type AssistantPreferences = {
  noteStatusAlerts: boolean;
};

type NoteStatusAlert = {
  sourceNoteId: string;
  title: string;
  status: 'CLOSED' | 'WORKING';
  changedAt: string;
};

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly chat: ChatService,
    private readonly systemMessages: ChatSystemMessageService,
  ) {}

  async bootstrap(userId: string): Promise<{
    assistant: {
      key: string;
      displayName: string;
      avatarKey: string;
      conversationId: string;
    };
    conversation: ChatConversationDto;
    unreadCount: number;
  }> {
    const conversationId = await this.ensureConversation(userId);
    const conversation = await this.chat.getConversation(
      userId,
      conversationId,
    );
    return {
      assistant: {
        key: ASSISTANT_KEY,
        displayName: ASSISTANT_DISPLAY_NAME,
        avatarKey: ASSISTANT_AVATAR_KEY,
        conversationId,
      },
      conversation,
      unreadCount: conversation.unreadCount,
    };
  }

  async ensureConversation(userId: string): Promise<string> {
    const directKey = `${ASSISTANT_CONVERSATION_PREFIX}${userId}`;
    const existing = await this.prisma.chatConversation.findUnique({
      where: { directKey },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.chatMember.updateMany({
        where: { conversationID: existing.id, userID: userId },
        data: { leftAt: null, hiddenAt: null, pinned: true },
      });
      await this.joinUser(userId, existing.id);
      return existing.id;
    }

    let conversationId: string;
    try {
      const created = await this.prisma.chatConversation.create({
        data: {
          type: 'SUPPORT',
          directKey,
          name: ASSISTANT_DISPLAY_NAME,
          members: {
            create: {
              userID: userId,
              pinned: true,
            },
          },
        },
        select: { id: true },
      });
      conversationId = created.id;
    } catch (error) {
      if (!this.isUniqueViolation(error)) throw error;
      const raced = await this.prisma.chatConversation.findUnique({
        where: { directKey },
        select: { id: true },
      });
      if (!raced) throw error;
      conversationId = raced.id;
    }

    await this.prisma.chatMember.updateMany({
      where: { conversationID: conversationId, userID: userId },
      data: { leftAt: null, hiddenAt: null, pinned: true },
    });
    await this.joinUser(userId, conversationId);
    return conversationId;
  }

  /** 没有设置行 = 默认值(提醒开启)。 */
  async getPreferences(userId: string): Promise<AssistantPreferences> {
    const row = await this.prisma.assistantPreference.findUnique({
      where: {
        userID_assistantKey: { userID: userId, assistantKey: ASSISTANT_KEY },
      },
      select: { noteStatusAlerts: true },
    });
    return { noteStatusAlerts: row?.noteStatusAlerts ?? true };
  }

  updatePreferences(
    userId: string,
    preferences: AssistantPreferences,
  ): Promise<AssistantPreferences> {
    return this.prisma.assistantPreference.upsert({
      where: {
        userID_assistantKey: { userID: userId, assistantKey: ASSISTANT_KEY },
      },
      create: {
        userID: userId,
        assistantKey: ASSISTANT_KEY,
        noteStatusAlerts: preferences.noteStatusAlerts,
      },
      update: { noteStatusAlerts: preferences.noteStatusAlerts },
      select: { noteStatusAlerts: true },
    });
  }

  /**
   * 先发提醒文字(带推送),再静默附上笔记名片;名片点开就是收藏者自己那份笔记。
   * 两条各有幂等键,整批重试不会重复。
   */
  async sendNoteStatusAlert(
    userId: string,
    alert: NoteStatusAlert,
    noteCard: Record<string, unknown> | null = null,
  ): Promise<void> {
    const conversationId = await this.ensureConversation(userId);
    const alertKey = [
      ASSISTANT_KEY,
      'note-status',
      userId,
      alert.sourceNoteId,
      alert.status,
      alert.changedAt,
    ].join(':');
    await this.systemMessages.insertServerMessage(conversationId, {
      senderID: ASSISTANT_SYSTEM_SENDER_ID,
      type: ASSISTANT_NOTE_STATUS_MESSAGE_TYPE,
      clientMessageId: alertKey,
      push: true,
      content: {
        kind: 'note-status',
        alertKey,
        sourceNoteId: alert.sourceNoteId,
        title: this.clamp(alert.title, 160),
        status: alert.status,
        changedAt: alert.changedAt,
        text: '风信助手有一条笔记状态提醒。',
      },
    });
    if (!noteCard) return;
    await this.systemMessages.insertServerMessage(conversationId, {
      senderID: ASSISTANT_SYSTEM_SENDER_ID,
      type: 'note-card',
      clientMessageId: `${alertKey}:card`,
      push: false,
      content: noteCard,
    });
  }

  async sendInfoAlert(
    userId: string,
    alert: InfoAlertPayload,
    alertKey: string,
  ): Promise<ChatMessageDto> {
    const conversationId = await this.ensureConversation(userId);
    return this.systemMessages.insertServerMessage(conversationId, {
      senderID: ASSISTANT_SYSTEM_SENDER_ID,
      type: ASSISTANT_INFO_ALERT_MESSAGE_TYPE,
      clientMessageId: alertKey,
      push: alert.pushEnabled !== false,
      content: {
        ...alert,
        text: alert.text || '风信助手有一条新的城市信息提醒。',
      },
    });
  }

  private async joinUser(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    await this.broadcast
      .joinUserToConversation(userId, conversationId)
      .catch((error: unknown) => {
        this.logger.warn({
          event: 'assistant_room_join_failed',
          userId,
          conversationId,
          error: error instanceof Error ? error.name : 'unknown',
        });
      });
  }

  private clamp(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}

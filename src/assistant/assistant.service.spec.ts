import { AssistantService } from './assistant.service';

describe('AssistantService', () => {
  const prisma = {
    chatConversation: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    chatMember: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    assistantPreference: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  };
  const broadcast = {
    joinUserToConversation: jest.fn().mockResolvedValue(undefined),
  };
  const chat = {
    getConversation: jest.fn(),
  };
  const systemMessages = {
    insertServerMessage: jest.fn().mockResolvedValue(undefined),
  };

  const service = new AssistantService(
    prisma as never,
    broadcast as never,
    chat as never,
    systemMessages as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.chatConversation.findUnique.mockResolvedValue(null);
    prisma.chatConversation.create.mockResolvedValue({
      id: 'assistant-conversation',
    });
    chat.getConversation.mockResolvedValue({
      id: 'assistant-conversation',
      type: 'SUPPORT',
      name: '风信助手',
      unreadCount: 0,
    });
  });

  it('creates one pinned support conversation and returns its bootstrap payload', async () => {
    const result = await service.bootstrap('user-1');

    expect(prisma.chatConversation.create).toHaveBeenCalledWith({
      data: {
        type: 'SUPPORT',
        directKey: 'assistant:windnote-assistant:user-1',
        name: '风信助手',
        members: {
          create: { userID: 'user-1', pinned: true },
        },
      },
      select: { id: true },
    });
    expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
      'user-1',
      'assistant-conversation',
    );
    expect(result.assistant.conversationId).toBe('assistant-conversation');
    expect(result.conversation.type).toBe('SUPPORT');
  });

  it('deduplicates note status alerts with a stable system sender and client id', async () => {
    prisma.chatConversation.findUnique.mockResolvedValueOnce({
      id: 'assistant-conversation',
    });

    await service.sendNoteStatusAlert('user-1', {
      sourceNoteId: 'source-note',
      title: '北京租房攻略',
      status: 'CLOSED',
      changedAt: '2026-10-29T12:00:00.000Z',
    });

    expect(systemMessages.insertServerMessage).toHaveBeenCalledWith(
      'assistant-conversation',
      expect.objectContaining({
        senderID: 'system:windnote-assistant',
        type: 'assistant-note-status',
        clientMessageId:
          'windnote-assistant:note-status:user-1:source-note:CLOSED:2026-10-29T12:00:00.000Z',
        push: true,
        content: expect.objectContaining({
          kind: 'note-status',
          sourceNoteId: 'source-note',
          title: '北京租房攻略',
          status: 'CLOSED',
        }),
      }),
    );
  });

  it('follows the reminder with a silent card of the note', async () => {
    prisma.chatConversation.findUnique.mockResolvedValueOnce({
      id: 'assistant-conversation',
    });
    const card = {
      noteId: 'copy-note',
      ownerId: 'user-1',
      title: '北京租房攻略',
    };

    await service.sendNoteStatusAlert(
      'user-1',
      {
        sourceNoteId: 'source-note',
        title: '北京租房攻略',
        status: 'CLOSED',
        changedAt: '2026-10-29T12:00:00.000Z',
      },
      card,
    );

    expect(systemMessages.insertServerMessage).toHaveBeenCalledTimes(2);
    expect(systemMessages.insertServerMessage).toHaveBeenLastCalledWith(
      'assistant-conversation',
      {
        senderID: 'system:windnote-assistant',
        type: 'note-card',
        clientMessageId:
          'windnote-assistant:note-status:user-1:source-note:CLOSED:2026-10-29T12:00:00.000Z:card',
        push: false,
        content: card,
      },
    );
  });

  it('writes a city info alert with the stable delivery key', async () => {
    prisma.chatConversation.findUnique.mockResolvedValueOnce({
      id: 'assistant-conversation',
    });
    systemMessages.insertServerMessage.mockResolvedValueOnce({
      id: 'message-1',
      conversationId: 'assistant-conversation',
    });

    await service.sendInfoAlert(
      'user-1',
      {
        kind: 'info-alert',
        alertKey: 'windnote-assistant:info:user-1:post-1:1',
        subscriptionIds: ['subscription-1'],
        circleId: 'circle-1',
        circleName: '北京生活圈',
        sourceType: 'PLAZA_POST',
        sourceId: 'post-1',
        title: '北京周末活动',
        summary: '周末活动报名信息',
        matchedCities: ['北京'],
        publishedAt: '2026-10-30T10:00:00.000Z',
        target: { route: 'plaza-post-detail', id: 'post-1' },
        text: '风信助手有一条新的城市信息提醒。',
      },
      'windnote-assistant:info:user-1:post-1:1',
    );

    expect(systemMessages.insertServerMessage).toHaveBeenCalledWith(
      'assistant-conversation',
      expect.objectContaining({
        senderID: 'system:windnote-assistant',
        type: 'assistant-info-alert',
        clientMessageId: 'windnote-assistant:info:user-1:post-1:1',
        push: true,
      }),
    );
  });
  it('treats a user with no preference row as opted in to note alerts', async () => {
    prisma.assistantPreference.findUnique.mockResolvedValue(null);

    await expect(service.getPreferences('user-1')).resolves.toEqual({
      noteStatusAlerts: true,
    });
    expect(prisma.assistantPreference.findUnique).toHaveBeenCalledWith({
      where: {
        userID_assistantKey: {
          userID: 'user-1',
          assistantKey: 'windnote-assistant',
        },
      },
      select: { noteStatusAlerts: true },
    });
  });

  it('stores the note alert switch per user, not per circle', async () => {
    prisma.assistantPreference.upsert.mockResolvedValue({
      noteStatusAlerts: false,
    });

    await expect(
      service.updatePreferences('user-1', { noteStatusAlerts: false }),
    ).resolves.toEqual({ noteStatusAlerts: false });
    expect(prisma.assistantPreference.upsert).toHaveBeenCalledWith({
      where: {
        userID_assistantKey: {
          userID: 'user-1',
          assistantKey: 'windnote-assistant',
        },
      },
      create: {
        userID: 'user-1',
        assistantKey: 'windnote-assistant',
        noteStatusAlerts: false,
      },
      update: { noteStatusAlerts: false },
      select: { noteStatusAlerts: true },
    });
  });
});

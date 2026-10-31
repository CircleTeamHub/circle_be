import { AssistantAlertDeliveryProcessor } from './assistant-alert-delivery.processor';

describe('AssistantAlertDeliveryProcessor', () => {
  it('claims a pending delivery, sends the assistant message, and marks it sent', async () => {
    const prisma = {
      assistantAlertDelivery: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'delivery-1',
            userID: 'user-1',
            dedupeKey: 'windnote-assistant:info:user-1:post-1:1',
            status: 'PENDING',
            attempts: 0,
            lockedAt: null,
            nextAttemptAt: new Date(),
            payloadSnapshot: {
              kind: 'info-alert',
              alertKey: 'windnote-assistant:info:user-1:post-1:1',
              sourceId: 'post-1',
              title: '北京活动',
              summary: '周末活动',
              target: { route: 'plaza-post-detail', id: 'post-1' },
            },
          },
        ]),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
      },
    };
    const assistant = {
      sendInfoAlert: jest.fn().mockResolvedValue({
        id: 'message-1',
        conversationId: 'conversation-1',
      }),
    };
    const processor = new AssistantAlertDeliveryProcessor(
      prisma as never,
      assistant as never,
    );

    await expect(processor.processPending()).resolves.toBe(1);
    expect(assistant.sendInfoAlert).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ sourceId: 'post-1' }),
      'windnote-assistant:info:user-1:post-1:1',
    );
    expect(prisma.assistantAlertDelivery.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'SENT',
          conversationID: 'conversation-1',
          messageID: 'message-1',
        }),
      }),
    );
  });
});

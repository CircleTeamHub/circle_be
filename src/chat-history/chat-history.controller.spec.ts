import { ChatHistoryController } from './chat-history.controller';

describe('ChatHistoryController', () => {
  it('passes current user, conversation id, and query options to service', async () => {
    const service = { getMessages: jest.fn().mockResolvedValue({ messages: [] }) };
    const controller = new ChatHistoryController(service as any);

    await controller.getMessages(
      { user: { userId: 'user-1' } } as any,
      'si_a_b',
      { limit: 50, beforeSeq: 10 },
    );

    expect(service.getMessages).toHaveBeenCalledWith(
      'user-1',
      'si_a_b',
      50,
      10,
    );
  });
});

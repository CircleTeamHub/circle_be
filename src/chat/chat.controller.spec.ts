import type { Response } from 'express';
import { ChatController } from './chat.controller';

// 会话列表响应体保持数组（已装机 App 按数组解析），被 limit 截断时经 X-Has-More 告知 ——
// 此前超过 100 个会话的用户在 App 里静默少一截，客户端无从得知。
describe('ChatController.listConversations', () => {
  function build(page: { conversations: unknown[]; hasMore: boolean }) {
    const chatService = {
      listConversationsPage: jest.fn().mockResolvedValue(page),
    };
    const controller = new ChatController(
      chatService as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const res = { setHeader: jest.fn() };
    return { chatService, controller, res };
  }

  const req = { user: { userId: 'u1' } } as never;

  it('returns the array and signals truncation through X-Has-More', async () => {
    const conversations = [{ id: 'conv-1' }, { id: 'conv-2' }];
    const { chatService, controller, res } = build({
      conversations,
      hasMore: true,
    });

    await expect(
      controller.listConversations(
        req,
        { limit: 2 },
        res as unknown as Response,
      ),
    ).resolves.toEqual(conversations);

    expect(chatService.listConversationsPage).toHaveBeenCalledWith('u1', 2);
    expect(res.setHeader).toHaveBeenCalledWith('X-Has-More', 'true');
  });

  it('keeps the default page size when the client sends no limit', async () => {
    const { chatService, controller, res } = build({
      conversations: [],
      hasMore: false,
    });

    await controller.listConversations(req, {}, res as unknown as Response);

    expect(chatService.listConversationsPage).toHaveBeenCalledWith(
      'u1',
      undefined,
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-Has-More', 'false');
  });
});

import type { Response } from 'express';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { ChatController } from './chat.controller';

// 按 IP 计数的话,同一运营商 NAT / 公司出口后面的人共享一份额度:发版后所有人
// 同时重连拉会话列表(30 次/分钟),一个出口后面几十个人就互相挤出 429。
describe('ChatController rate limiting', () => {
  it('counts requests per signed-in user, not per IP', () => {
    const guards: unknown[] =
      Reflect.getMetadata(GUARDS_METADATA, ChatController) ?? [];
    expect(guards).toContain(UserThrottlerGuard);
    expect(guards).not.toContain(ThrottlerGuard);
    // 限流按 req.user 计数,JwtGuard 必须先把用户挂上去。
    expect(guards.indexOf(JwtGuard)).toBeLessThan(
      guards.indexOf(UserThrottlerGuard),
    );
  });
});

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

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
describe('ChatController.createGroupConversation', () => {
  it('returns the committed group without waiting for global admission delivery', async () => {
    const group = { id: 'new-group' };
    const admissions = {
      flush: jest.fn().mockRejectedValue(new Error('delivery down')),
    };
    const controller = new ChatController(
      { createGroupConversation: jest.fn().mockResolvedValue(group) } as never,
      admissions as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      controller.createGroupConversation(
        { user: { userId: 'owner' } } as never,
        { name: 'Group', memberIds: [] },
      ),
    ).resolves.toBe(group);
    expect(admissions.flush).not.toHaveBeenCalled();
  });
});

describe('ChatController.listConversations', () => {
  function build(
    page: { conversations: unknown[]; hasMore: boolean },
    keysetPage: {
      conversations: unknown[];
      hasMore: boolean;
      nextCursor: string | null;
    } = { conversations: [], hasMore: false, nextCursor: null },
  ) {
    const chatService = {
      listConversationsPage: jest.fn().mockResolvedValue(page),
      listConversationsKeysetPage: jest.fn().mockResolvedValue(keysetPage),
    };
    const controller = new ChatController(
      chatService as never,
      {} as never,
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
    // 旧模式（不带 cursor）不走键集，也绝不发游标头：老客户端行为一字不改。
    expect(chatService.listConversationsKeysetPage).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalledWith(
      'X-Next-Cursor',
      expect.anything(),
    );
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

  // 带 cursor = 键集分页（按 conversationID 升序）：活跃度排序下翻页，新消息会把
  // 会话在页之间挪来挪去，造成漏行/重复；键集按稳定的 id 走，一个不落。
  describe('keyset cursor mode', () => {
    const NEXT = '3f2a9c1e-7b4d-4e8a-9c0f-1a2b3c4d5e6f';

    it('pages by conversation id and hands back the next cursor while more rows remain', async () => {
      const conversations = [{ id: 'a' }, { id: NEXT }];
      const { chatService, controller, res } = build(
        { conversations: [], hasMore: false },
        { conversations, hasMore: true, nextCursor: NEXT },
      );

      await expect(
        controller.listConversations(
          req,
          { cursor: '', limit: 2 },
          res as unknown as Response,
        ),
      ).resolves.toEqual(conversations);

      expect(chatService.listConversationsKeysetPage).toHaveBeenCalledWith(
        'u1',
        '',
        2,
      );
      expect(chatService.listConversationsPage).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-Has-More', 'true');
      expect(res.setHeader).toHaveBeenCalledWith('X-Next-Cursor', NEXT);
    });

    it('omits X-Next-Cursor on the last page', async () => {
      const { chatService, controller, res } = build(
        { conversations: [], hasMore: false },
        { conversations: [{ id: NEXT }], hasMore: false, nextCursor: null },
      );

      await controller.listConversations(
        req,
        { cursor: NEXT },
        res as unknown as Response,
      );

      expect(chatService.listConversationsKeysetPage).toHaveBeenCalledWith(
        'u1',
        NEXT,
        undefined,
      );
      expect(res.setHeader).toHaveBeenCalledWith('X-Has-More', 'false');
      expect(res.setHeader).not.toHaveBeenCalledWith(
        'X-Next-Cursor',
        expect.anything(),
      );
    });

    it('documents the cursor mode and both paging headers in Swagger', () => {
      const operation = Reflect.getMetadata(
        'swagger/apiOperation',
        ChatController.prototype.listConversations,
      ) as { description: string };
      const responses = Reflect.getMetadata(
        'swagger/apiResponse',
        ChatController.prototype.listConversations,
      ) as Record<string, { headers?: Record<string, unknown> }>;

      expect(operation.description).toContain('cursor');
      expect(operation.description).toContain('X-Next-Cursor');
      expect(Object.keys(responses['200']?.headers ?? {})).toEqual(
        expect.arrayContaining(['X-Has-More', 'X-Next-Cursor']),
      );
    });
  });
});

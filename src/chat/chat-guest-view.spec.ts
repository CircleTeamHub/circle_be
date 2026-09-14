import { newGuestId } from 'src/temp-chat/temp-chat.ids';
import {
  TEMP_CHAT_HOST_ALIAS,
  isGuestUserId,
  toGuestMessageView,
} from './chat-guest-view';
import type { ChatMessageDto } from './chat.types';

const GUEST_ID = 'g0123456789abcdef0123456789abcdef';
const HOST_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

function message(overrides: Partial<ChatMessageDto> = {}): ChatMessageDto {
  return {
    id: 'message-1',
    conversationId: 'conv-temp',
    height: 3,
    type: 'text',
    content: { text: 'hi' },
    sender: { id: HOST_ID, nickname: '房主', avatarUrl: null, alias: null },
    replyToId: null,
    revokedAt: null,
    revokedBy: null,
    burnDurationSec: null,
    d: null,
    createdAt: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

describe('isGuestUserId', () => {
  it('recognises the ids temp-chat mints for guests', () => {
    expect(isGuestUserId(newGuestId())).toBe(true);
    expect(isGuestUserId(GUEST_ID)).toBe(true);
  });

  it('never matches an account id or a malformed value', () => {
    expect(isGuestUserId(HOST_ID)).toBe(false);
    expect(isGuestUserId('g-not-hex')).toBe(false);
    expect(isGuestUserId('')).toBe(false);
  });
});

// 临时房里账号成员只有房主。匿名访客拿到房主的账号 UUID，就能在注册后直接发起单聊、
// 好友申请或按 id 拉资料 —— 访客页只需要「这条是房主发的」，房间内别名就够了。
describe('toGuestMessageView', () => {
  it('replaces the host account id on the sender with the room-local alias', () => {
    const original = message();

    const view = toGuestMessageView(original);

    expect(view.sender).toEqual({
      id: TEMP_CHAT_HOST_ALIAS,
      nickname: '房主',
      avatarUrl: null,
      alias: null,
    });
    // 纯函数：同一份 DTO 还要原样发给房主本人。
    expect(original.sender?.id).toBe(HOST_ID);
  });

  it('leaves a guest sender untouched', () => {
    const guestMessage = message({
      sender: { id: GUEST_ID, nickname: '访客', avatarUrl: null, alias: null },
    });

    expect(toGuestMessageView(guestMessage)).toEqual(guestMessage);
  });

  it('aliases the host in revokedBy and reaction user lists, keeping guest ids', () => {
    const view = toGuestMessageView(
      message({
        revokedBy: HOST_ID,
        reactions: [{ emoji: 'like', userIds: [HOST_ID, GUEST_ID] }],
      }),
    );

    expect(view.revokedBy).toBe(TEMP_CHAT_HOST_ALIAS);
    expect(view.reactions).toEqual([
      { emoji: 'like', userIds: [TEMP_CHAT_HOST_ALIAS, GUEST_ID] },
    ]);
  });

  it('keeps a system notice without a sender as it is', () => {
    const notice = message({
      type: 'system',
      sender: null,
      content: { kind: 'notice' },
    });

    expect(toGuestMessageView(notice)).toEqual(notice);
  });
});

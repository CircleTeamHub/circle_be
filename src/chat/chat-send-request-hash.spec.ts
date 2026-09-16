import { chatSendRequestHash } from './chat-send-request-hash';
import type { ChatSendPayload } from './chat.types';

const payload = (
  overrides: Partial<ChatSendPayload> = {},
): ChatSendPayload => ({
  conversationId: 'conv-1',
  type: 'text',
  content: { text: 'hello' },
  d: 'd-1',
  ...overrides,
});

describe('chatSendRequestHash', () => {
  it('is stable for the same request regardless of key order', () => {
    // 客户端重发时对象键序可能不同(重新拼装的载荷),不能因此被当成另一条内容。
    expect(
      chatSendRequestHash(
        payload({ content: { text: 'hi', mentions: [{ userId: 'u2' }] } }),
      ),
    ).toBe(
      chatSendRequestHash(
        payload({ content: { mentions: [{ userId: 'u2' }], text: 'hi' } }),
      ),
    );
  });

  it('changes when anything the message would say changes', () => {
    const base = chatSendRequestHash(payload());
    expect(
      chatSendRequestHash(payload({ content: { text: 'hellO' } })),
    ).not.toBe(base);
    expect(chatSendRequestHash(payload({ type: 'quote' }))).not.toBe(base);
    expect(chatSendRequestHash(payload({ replyToId: 'm-9' }))).not.toBe(base);
    expect(
      chatSendRequestHash(payload({ forwardFromMessageId: 'm-9' })),
    ).not.toBe(base);
  });

  it('ignores the conversation-agnostic delivery id itself and media presentation fields', () => {
    expect(chatSendRequestHash(payload({ d: 'another-d' }))).toBe(
      chatSendRequestHash(payload()),
    );
    // 展示地址本来就不落库(读路径现签),客户端带没带不影响「是不是同一条」。
    expect(
      chatSendRequestHash(
        payload({
          type: 'image',
          content: {
            key: 'chat/u1/a.jpg',
            url: 'https://signed',
            localUri: 'file:///a',
          },
        }),
      ),
    ).toBe(
      chatSendRequestHash(
        payload({ type: 'image', content: { key: 'chat/u1/a.jpg' } }),
      ),
    );
  });
});

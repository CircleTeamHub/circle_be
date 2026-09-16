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

  it('treats a re-uploaded copy of the same media as the same request', () => {
    // 首发已落库、ack 丢了:客户端重发时重新上传,拿到的是新 key。
    const first = payload({
      type: 'image',
      content: {
        key: 'chat/u1/a.jpg',
        thumbKey: 'chat/u1/a-t.jpg',
        width: 800,
      },
    });
    const reuploaded = payload({
      type: 'image',
      content: {
        key: 'chat/u1/b.jpg',
        thumbKey: 'chat/u1/b-t.jpg',
        width: 800,
      },
    });
    expect(chatSendRequestHash(reuploaded)).toBe(chatSendRequestHash(first));

    // 别的字段变了仍然是另一条。
    expect(
      chatSendRequestHash(
        payload({
          type: 'voice',
          content: { key: 'chat/u1/v.m4a', duration: 3 },
        }),
      ),
    ).not.toBe(
      chatSendRequestHash(
        payload({
          type: 'voice',
          content: { key: 'chat/u1/v.m4a', duration: 9 },
        }),
      ),
    );
    // 文本类型里恰好叫 key 的字段不受影响。
    expect(
      chatSendRequestHash(payload({ content: { text: 'a', key: 'x' } })),
    ).not.toBe(
      chatSendRequestHash(payload({ content: { text: 'a', key: 'y' } })),
    );
  });
});

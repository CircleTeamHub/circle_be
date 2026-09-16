import { createHash } from 'crypto';
import { CHAT_MEDIA_KEY_FIELDS, MEDIA_MESSAGE_TYPES } from './chat.constants';
import type { ChatSendPayload } from './chat.types';

/** 媒体 content 里只应持久化 object key;展示地址一律由读路径现签。 */
export const MEDIA_PRESENTATION_FIELDS = [
  'url',
  'thumbUrl',
  'localUri',
] as const;

export function stripMediaPresentationFields(
  content: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = { ...content };
  for (const field of MEDIA_PRESENTATION_FIELDS) delete cleaned[field];
  return cleaned;
}

/** 按码位序比较,不走 localeCompare:指纹不能随运行环境的区域设置变化。 */
function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => compareKeys(a, b));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * 媒体 content 去掉 object key 之后剩下的部分(尺寸、时长、大小……)。
 *
 * 同一份媒体每上传一次就是一个新 key(presign 现生成)。首发其实已经落库、只是
 * ack 丢了,客户端重发时重新上传(图片/语音一直是这么重发的)—— 这是同一条消息的
 * 合法重发,key 不同不能算「内容不同」。
 */
function mediaFingerprintContent(
  type: string,
  content: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned = stripMediaPresentationFields(content);
  for (const { key } of CHAT_MEDIA_KEY_FIELDS[type] ?? []) delete cleaned[key];
  return cleaned;
}

/**
 * 一次客户端发送请求的指纹(存进 ChatMessage.requestHash)。
 *
 * 客户端幂等键 d 撞库时,原来一律把库里那条当成「同一条消息的重发」原样返回。
 * 要是同一个 d 带着另一份内容过来(客户端 bug、确认没回来就改了内容再发),
 * 发送方看到「发送成功」,收件人收到的却是另一段话 —— 两边对不上而且没有任何报错。
 * squady 的做法:按请求指纹判定,内容不同就拒收。
 *
 * 指纹取客户端声明的意图(type / content / 引用 / 转发源),不取服务端加工后的
 * 结果:转发每次都会复制出新的 object key,拿落库内容比会把合法重发误判成冲突。
 * 展示字段本来就不落库,不参与;媒体的 object key 见 mediaFingerprintContent;
 * d 本身是查重的键,也不参与。
 */
export function chatSendRequestHash(payload: ChatSendPayload): string {
  const content = MEDIA_MESSAGE_TYPES.includes(payload.type)
    ? mediaFingerprintContent(payload.type, payload.content)
    : payload.content;
  return createHash('sha256')
    .update(
      canonicalJson({
        type: payload.type,
        content,
        replyToId: payload.replyToId ?? null,
        forwardFromMessageId: payload.forwardFromMessageId ?? null,
      }),
    )
    .digest('hex');
}

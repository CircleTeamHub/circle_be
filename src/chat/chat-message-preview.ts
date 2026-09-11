// 消息的服务端短摘要:文本截断,其余类型用类型标签。
// 引用快照(replyTo.preview)与收藏标题/摘要共用同一份文案表 —— 两处各写一份的话,
// 同一条图片消息在引用里叫「[图片]」、在收藏里叫别的名字。
// 具体文案的本地化仍由前端词表负责,这里只是兜底展示。

/** 引用快照里的文本截断长度(收藏标题沿用它,摘要按 DTO 的上限另传)。 */
const MESSAGE_PREVIEW_MAX = 40;

const MESSAGE_PREVIEW_LABELS: Record<string, string> = {
  image: '[图片]',
  video: '[视频]',
  voice: '[语音]',
  file: '[文件]',
  location: '[位置]',
  'note-card': '[笔记]',
  'friend-card': '[名片]',
  'circle-card': '[圈子]',
  'plaza-post-card': '[帖子]',
  'qr-card': '[二维码]',
  'transfer-card': '[转账]',
  'verification-card': '[验证]',
  'call-record': '[通话]',
};

/** 这个类型的兜底标签(文本类没有标签,返回空串)。 */
function messageTypeLabel(type: string): string {
  if (type === 'text' || type === 'quote') return '';
  return MESSAGE_PREVIEW_LABELS[type] ?? '[消息]';
}

/** 文本类取正文(超长加省略号),其余类型取标签。 */
export function messagePreviewText(
  type: string,
  content: unknown,
  max: number = MESSAGE_PREVIEW_MAX,
): string {
  const record = (content ?? {}) as Record<string, unknown>;
  if (type === 'text' || type === 'quote') {
    const text = typeof record['text'] === 'string' ? record['text'] : '';
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return messageTypeLabel(type);
}

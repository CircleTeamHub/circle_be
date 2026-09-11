// 卡片 content 的服务端收口。
//
// friend-card 在 CLIENT_MESSAGE_TYPES 里:整份 content 由发送方构造,发送路径只
// 校验总字节数、不认识里面的形状。渲染侧(前端 message-mappers 的 sanitizeFriendCard)
// 因此逐字段消毒过一遍才敢进气泡。
//
// 收藏把这份 content 复制进 payload,而「从收藏重发」会把 payload 原样当成新消息的
// content —— 复制那一步若整份照搬,就等于给对端准备了一条绕过渲染侧消毒的通路:
// displayIcons 塞成字符串能把会话页打崩,faceURL 塞成 http://attacker/1x1.gif 让每个
// 看到卡片的人静默发一次 GET。所以复制时按同一套规则重建,只保留消费方真正会读的键。
//
// 规则与前端 src/chat-core/message-mappers.ts 镜像(改这里要同步那边)。

/** 名片上最多展示的图标数(与前端 FriendCardBubble 的 slice(0,4) 对齐)。 */
const FRIEND_CARD_ICON_CAP = 4;
/** URL 字段的长度上限:再长也不是能用的地址,只会把快照撑大。 */
const URL_MAX = 2048;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function clampText(value: unknown, cap: number): string {
  const text = str(value);
  if (!text) return '';
  return text.length > cap ? text.slice(0, cap) : text;
}

/**
 * 只放行 http(s) 绝对地址,且不接受内嵌凭证(它会随请求一起发出去)。
 * 前端还会按对象存储 origin 白名单再收一道 —— 那份配置在端上,服务端这里只能
 * 判到 scheme 这一层,两道叠着用。
 */
function httpUrl(value: unknown): string {
  const raw = str(value);
  if (!raw || raw.length > URL_MAX) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.username || url.password) return '';
    return raw;
  } catch {
    return '';
  }
}

function sanitizeDisplayIcon(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = str(raw['id']);
  if (!id) return null;
  // 只构造消费方真正会读的字段,不整份 spread 对端对象。
  return {
    id: clampText(id, 64),
    type: clampText(raw['type'], 32) || 'SYSTEM',
    title: clampText(raw['title'], 40),
    imageUrl: httpUrl(raw['imageUrl']) || null,
    fallbackIconName: clampText(raw['fallbackIconName'], 64) || null,
    sortOrder: num(raw['sortOrder']) ?? 0,
  };
}

/** friend-card content → 只含允许键的安全副本。 */
export function sanitizeFriendCardContent(
  content: Record<string, unknown>,
): Record<string, unknown> {
  const rawIcons = content['displayIcons'];
  const icons: Record<string, unknown>[] = [];
  if (Array.isArray(rawIcons)) {
    for (const entry of rawIcons) {
      if (icons.length >= FRIEND_CARD_ICON_CAP) break;
      const icon = sanitizeDisplayIcon(entry);
      if (icon) icons.push(icon);
    }
  }
  return {
    userID: clampText(content['userID'], 64),
    nickname: clampText(content['nickname'], 60),
    faceURL: httpUrl(content['faceURL']),
    persona: clampText(content['persona'], 120) || null,
    displayIcons: icons,
  };
}

/** transfer-card content → 只含允许键的安全副本(金额错型/负数归零)。 */
export function sanitizeTransferCardContent(
  content: Record<string, unknown>,
): Record<string, unknown> {
  const amount = num(content['amount']);
  return {
    amount: amount !== undefined && amount >= 0 ? amount : 0,
    message: clampText(content['message'], 120) || null,
  };
}

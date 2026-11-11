/**
 * 聊天媒体保留期(按发送时间算)。过了这个年龄:
 * - 读路径给消息标 `expired: true`、不再签地址(ChatMediaService.attachMediaUrls);
 * - 每日任务清掉正文里的对象 key 并排队删对象(ChatMediaRetentionService)。
 *
 * 不在此列的:笔记自己的素材(notes/ 前缀,不归聊天管);被收藏着的消息(收藏还在
 * 就整条跳过,收藏删了下一轮再清);阅后即焚消息(有自己的销毁与 180 天归档)。
 */
export const CHAT_MEDIA_RETENTION_DAYS: Readonly<Record<string, number>> = {
  video: 30,
  image: 365,
  voice: 365,
  file: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 正文里指向对象或签名地址的字段;过期后一律去掉,只留尺寸、时长等排版信息。 */
const MEDIA_OBJECT_FIELDS = ['key', 'thumbKey', 'coverKey', 'url', 'thumbUrl'];

export function chatMediaRetentionCutoff(type: string, now = Date.now()): Date {
  return new Date(now - CHAT_MEDIA_RETENTION_DAYS[type] * DAY_MS);
}

export function isChatMediaExpired(
  message: {
    type: string;
    createdAt: Date | string;
    burnDurationSec?: number | null;
    burnExpiresAt?: Date | string | null;
  },
  now = Date.now(),
): boolean {
  if (!CHAT_MEDIA_RETENTION_DAYS[message.type]) return false;
  if (message.burnExpiresAt || (message.burnDurationSec ?? 0) > 0) return false;
  return (
    new Date(message.createdAt).getTime() <=
    chatMediaRetentionCutoff(message.type, now).getTime()
  );
}

export function expiredMediaContent(
  content: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...content };
  for (const field of MEDIA_OBJECT_FIELDS) delete rest[field];
  return { ...rest, expired: true };
}

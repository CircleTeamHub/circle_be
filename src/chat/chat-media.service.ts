import { Injectable, Logger } from '@nestjs/common';
import { UploadService } from 'src/upload/upload.service';
import type { ChatMessageDto } from './chat.types';

/**
 * 聊天媒体 presign-on-read(根治 OpenIM「URL 固化进不可变消息体」的 P0)。
 *
 * 契约:媒体消息的 content 持久化只存 object key
 * (image: {key, thumbKey?, width?, height?} / voice: {key, duration}),
 * 读路径(历史 / 广播 / 会话列表末条)在 DTO 上补 url/thumbUrl,永不落库。
 * 上传沿用现有 /upload presign 流程,聊天侧不需要新的上传接口。
 *
 * 签名窗口对齐 note 的做法:同窗口同 key 签出相同 URL,客户端按-URL 缓存
 * 才能命中;TTL 双倍于窗口,保证任一时刻拿到的 URL 至少还有一个窗口期可用。
 */
const CHAT_MEDIA_URL_WINDOW_MS = 60 * 60 * 1000;
const CHAT_MEDIA_URL_TTL_SECONDS = 2 * 60 * 60;

const MEDIA_KEY_FIELDS: Record<string, Array<{ key: string; url: string }>> = {
  image: [
    { key: 'key', url: 'url' },
    { key: 'thumbKey', url: 'thumbUrl' },
  ],
  voice: [{ key: 'key', url: 'url' }],
  file: [{ key: 'key', url: 'url' }],
};

@Injectable()
export class ChatMediaService {
  private readonly logger = new Logger(ChatMediaService.name);

  constructor(private readonly uploadService: UploadService) {}

  /**
   * 就地把 dto.content 换成带签名 URL 的新对象(不改数据库行)。
   * 存储未配置/签名失败时降级:保留 key、缺 url,前端按占位图处理 ——
   * 读路径绝不因媒体签名把整页历史打挂。
   */
  async attachMediaUrls(messages: ChatMessageDto[]): Promise<void> {
    const wanted = new Set<string>();
    for (const message of messages) {
      const fields = MEDIA_KEY_FIELDS[message.type];
      if (!fields) continue;
      for (const field of fields) {
        const value = message.content[field.key];
        if (typeof value === 'string' && value.length > 0) wanted.add(value);
      }
    }
    if (wanted.size === 0) return;

    const signingDate = new Date(
      Math.floor(Date.now() / CHAT_MEDIA_URL_WINDOW_MS) *
        CHAT_MEDIA_URL_WINDOW_MS,
    );
    const signed = new Map<string, string>();
    await Promise.all(
      [...wanted].map(async (key) => {
        try {
          const result = await this.uploadService.createPresignedGetUrl(
            key,
            CHAT_MEDIA_URL_TTL_SECONDS,
            signingDate,
          );
          signed.set(key, result.url);
        } catch (error) {
          this.logger.warn(
            `presign failed key=${key}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }),
    );
    if (signed.size === 0) return;

    for (const message of messages) {
      const fields = MEDIA_KEY_FIELDS[message.type];
      if (!fields) continue;
      const patch: Record<string, unknown> = {};
      for (const field of fields) {
        const value = message.content[field.key];
        if (typeof value === 'string') {
          const url = signed.get(value);
          if (url) patch[field.url] = url;
        }
      }
      if (Object.keys(patch).length > 0) {
        message.content = { ...message.content, ...patch };
      }
    }
  }
}

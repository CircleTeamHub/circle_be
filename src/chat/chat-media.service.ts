import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { UploadService } from 'src/upload/upload.service';
import { CHAT_MEDIA_KEY_FIELDS, CHAT_MEDIA_KEY_PREFIX } from './chat.constants';
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
/** 删除失败的 key 重投上限;超过就是配置/权限问题,再刷也没用,留给存量盘点。 */
const DELETE_RETRY_MAX = 3;
const DELETE_RETRY_INTERVAL_MS = 60_000;
/** 待重试队列上限,防存储长时间不可用时无界堆积。 */
const DELETE_RETRY_QUEUE_MAX = 5_000;

@Injectable()
export class ChatMediaService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatMediaService.name);
  /** key → 已尝试次数。撤回/焚毁的媒体删失败后在这里排队重投。 */
  private readonly deleteRetries = new Map<string, number>();
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly uploadService: UploadService) {}

  onModuleDestroy(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * 撤回/焚毁配套:按 key 删除对象存储里的媒体,只清 DB 等于没撤。
   * 只认 chat/ 前缀,别的目录不替删。
   *
   * 单个失败不让撤回本身失败,但也不能就此撒手 —— 注释里说的「交存量盘点兜底」
   * 并不成立:StorageAudit 明确跳过 chat/,生产的 MinIO 生命周期规则也只覆盖
   * note-exports/。一次瞬时的 MinIO 抖动就足以让被撤回的图片永久留在桶里,
   * 而发送方手上还攥着那个 key。所以失败的 key 进队列,按分钟重投几次。
   */
  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      if (!key.startsWith(CHAT_MEDIA_KEY_PREFIX)) continue;
      await this.deleteOrQueue(key);
    }
  }

  private async deleteOrQueue(key: string): Promise<void> {
    try {
      await this.uploadService.deleteObjectByKey(key);
      this.deleteRetries.delete(key);
    } catch (error) {
      const attempts = (this.deleteRetries.get(key) ?? 0) + 1;
      this.logger.warn(
        `revoked media delete failed key=${key} attempt=${attempts}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      if (attempts >= DELETE_RETRY_MAX) {
        this.deleteRetries.delete(key);
        this.logger.error(
          `revoked media delete gave up key=${key} after ${attempts} attempts`,
        );
        return;
      }
      if (this.deleteRetries.size >= DELETE_RETRY_QUEUE_MAX) return;
      this.deleteRetries.set(key, attempts);
      this.ensureRetryTimer();
    }
  }

  private ensureRetryTimer(): void {
    if (this.retryTimer) return;
    const timer = setInterval(() => {
      void this.drainRetries();
    }, DELETE_RETRY_INTERVAL_MS);
    timer.unref?.();
    this.retryTimer = timer;
  }

  private async drainRetries(): Promise<void> {
    const pending = [...this.deleteRetries.keys()];
    for (const key of pending) await this.deleteOrQueue(key);
    if (this.deleteRetries.size === 0 && this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * 就地把 dto.content 换成带签名 URL 的新对象(不改数据库行)。
   * 存储未配置/签名失败时降级:保留 key、缺 url,前端按占位图处理 ——
   * 读路径绝不因媒体签名把整页历史打挂。
   */
  async attachMediaUrls(messages: ChatMessageDto[]): Promise<void> {
    const wanted = new Set<string>();
    for (const message of messages) {
      const fields = CHAT_MEDIA_KEY_FIELDS[message.type];
      if (!fields) continue;
      for (const field of fields) {
        const value = message.content[field.key];
        // 只给 chat/ 目录下的 key 签名。发送校验已经把新消息收口到
        // chat/{senderId}/,这里是第二道:历史行里若混进别的目录(notes/ 等),
        // 读路径也不会把它变成一条新的可分发签名 URL。
        if (
          typeof value === 'string' &&
          value.startsWith(CHAT_MEDIA_KEY_PREFIX)
        )
          wanted.add(value);
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
      const fields = CHAT_MEDIA_KEY_FIELDS[message.type];
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

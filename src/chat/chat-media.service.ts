import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/upload/upload.service';
import type { Prisma } from 'src/generated/prisma';
import {
  CHAT_MEDIA_KEY_FIELDS,
  CHAT_MEDIA_KEY_PREFIX,
  CHAT_NOTE_IMPORT_RESERVATION_REASON,
  CHAT_NOTE_IMPORT_SEGMENT,
} from './chat.constants';
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
/**
 * 物删失败的退避重试。次数用尽后**不丢弃**,只是停止自动重试并留在表里
 * (`attempts >= DELETE_MAX_ATTEMPTS` 即死信),等运维处理 —— key 一旦从这里
 * 消失就再也无从得知,那张被撤回的图会永久留在桶里。
 */
const DELETE_MAX_ATTEMPTS = 8;
const DELETE_BACKOFF_BASE_MS = 60_000;
const DELETE_BACKOFF_MAX_MS = 60 * 60_000;
const DELETE_SWEEP_INTERVAL_MS = 60_000;
/** 单轮重投的条数上限(存储长时间不可用时不要一口气打爆)。 */
const DELETE_SWEEP_BATCH = 200;
/**
 * 认领租约:事务内把 nextAttemptAt 推后这么久,再到事务外去删对象。
 * 期间别的 sweeper 实例查不到这一条,不会重复删。租约要长于一次对象存储
 * 删除的最坏耗时;真失败了下面的 catch 会立刻按退避改写 nextAttemptAt,
 * 进程中途挂掉最多也就是这一条晚 5 分钟被重投。
 */
const DELETE_CLAIM_LEASE_MS = 5 * 60_000;
const FORWARD_COPY_RESERVATION_MS = 15 * 60_000;

@Injectable()
export class ChatMediaService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatMediaService.name);
  private retryTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly uploadService: UploadService,
    private readonly prisma: PrismaService,
  ) {
    const timer = setInterval(() => {
      void this.drainPendingDeletions();
    }, DELETE_SWEEP_INTERVAL_MS);
    timer.unref?.();
    this.retryTimer = timer;
  }

  onModuleDestroy(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private noteImportKeys(keys: string[]): string[] {
    return [...new Set(keys)]
      .filter((key) => key.includes(`/${CHAT_NOTE_IMPORT_SEGMENT}`))
      .sort((left, right) => left.localeCompare(right));
  }

  private async lockNoteImportKeys(
    tx: Prisma.TransactionClient,
    keys: string[],
  ): Promise<void> {
    for (const key of this.noteImportKeys(keys)) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    }
  }

  async attachNoteImportReferences(
    tx: Prisma.TransactionClient,
    messageId: string,
    keys: string[],
  ): Promise<void> {
    const noteKeys = this.noteImportKeys(keys);
    if (noteKeys.length === 0) return;
    await this.lockNoteImportKeys(tx, noteKeys);
    const now = Date.now();
    for (const objectKey of noteKeys) {
      const [referenceCount, reservation] = await Promise.all([
        tx.chatMediaReference.count({ where: { objectKey } }),
        tx.chatMediaDeletion.findUnique({
          where: { objectKey },
          select: { attempts: true, lastError: true, nextAttemptAt: true },
        }),
      ]);
      const liveReservation =
        reservation?.attempts === 0 &&
        reservation.lastError === CHAT_NOTE_IMPORT_RESERVATION_REASON &&
        reservation.nextAttemptAt.getTime() > now;
      if (referenceCount === 0 && !liveReservation) {
        throw new BadRequestException('Note media import has expired');
      }
    }
    await tx.chatMediaReference.createMany({
      data: noteKeys.map((objectKey) => ({ messageID: messageId, objectKey })),
      skipDuplicates: true,
    });
    await tx.chatMediaDeletion.deleteMany({
      where: { objectKey: { in: noteKeys } },
    });
  }

  async releaseNoteImportReferences(
    tx: Prisma.TransactionClient,
    messageIds: string[],
    keys: string[],
  ): Promise<void> {
    const noteKeys = this.noteImportKeys(keys);
    if (noteKeys.length === 0 || messageIds.length === 0) return;
    await this.lockNoteImportKeys(tx, noteKeys);
    await tx.chatMediaReference.deleteMany({
      where: {
        messageID: { in: messageIds },
        objectKey: { in: noteKeys },
      },
    });
    for (const objectKey of noteKeys) {
      const referenceCount = await tx.chatMediaReference.count({
        where: { objectKey },
      });
      if (referenceCount > 0) {
        await tx.chatMediaDeletion.deleteMany({ where: { objectKey } });
        continue;
      }
      const reservation = await tx.chatMediaDeletion.findUnique({
        where: { objectKey },
        select: { attempts: true, lastError: true, nextAttemptAt: true },
      });
      if (
        reservation?.attempts === 0 &&
        reservation.lastError === CHAT_NOTE_IMPORT_RESERVATION_REASON &&
        reservation.nextAttemptAt.getTime() > Date.now()
      ) {
        continue;
      }
      const nextAttemptAt = new Date();
      await tx.chatMediaDeletion.upsert({
        where: { objectKey },
        create: {
          objectKey,
          attempts: 0,
          lastError: 'last note import reference removed',
          nextAttemptAt,
        },
        update: {
          attempts: 0,
          lastError: 'last note import reference removed',
          nextAttemptAt,
        },
      });
    }
  }

  /**
   * 撤回/焚毁配套:按 key 删除对象存储里的媒体,只清 DB 等于没撤。
   * 只认 chat/ 前缀,别的目录不替删。
   *
   * 单个失败不让撤回本身失败,但也不能就此撒手 —— 注释里曾说的「交存量盘点
   * 兜底」并不成立:StorageAudit 只**报告**孤儿、不删,生产的 MinIO 生命周期
   * 规则也只覆盖 note-exports/。更要命的是消息 content 在撤回那一刻已经清空,
   * key 没有任何业务数据能重建:内存队列一重启就等于永久放弃。
   * 所以失败的 key 落进 ChatMediaDeletion 表,由本服务按退避重投到确认为止。
   */
  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) {
      if (!key.startsWith(CHAT_MEDIA_KEY_PREFIX)) continue;
      try {
        await this.uploadService.deleteObjectByKey(key);
        await this.prisma.chatMediaDeletion.deleteMany({
          where: { objectKey: key },
        });
      } catch (error) {
        await this.enqueueDeletion(key, error);
      }
    }
  }

  /**
   * 转发媒体时复制对象到转发者自己的命名空间。源 key 只从已通过消息可见性
   * 校验的数据库行读取；展示 URL 会被移除，目标消息只持久化新 key。
   */
  async copyForForward(
    type: string,
    sourceContent: Record<string, unknown>,
    userId: string,
  ): Promise<{ content: Record<string, unknown>; copiedKeys: string[] }> {
    const fields = CHAT_MEDIA_KEY_FIELDS[type];
    if (!fields) {
      throw new BadRequestException('Only media messages can be forwarded');
    }

    const content = { ...sourceContent };
    delete content['url'];
    delete content['thumbUrl'];
    delete content['localUri'];
    const plannedCopies: Array<{
      field: string;
      sourceKey: string;
      destinationKey: string;
    }> = [];
    for (const field of fields) {
      const sourceKey = sourceContent[field.key];
      if (sourceKey === undefined && field.key !== 'key') continue;
      if (
        typeof sourceKey !== 'string' ||
        !sourceKey.startsWith(CHAT_MEDIA_KEY_PREFIX) ||
        sourceKey.includes('://') ||
        sourceKey.includes('..')
      ) {
        throw new BadRequestException('Invalid source media object key');
      }
      const fileName = sourceKey.split('/').pop() ?? '';
      const rawExtension = fileName.includes('.')
        ? (fileName.split('.').pop() ?? '')
        : '';
      const extension =
        rawExtension.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'bin';
      plannedCopies.push({
        field: field.key,
        sourceKey,
        destinationKey: `${CHAT_MEDIA_KEY_PREFIX}${userId}/${randomUUID()}.${extension}`,
      });
    }
    if (plannedCopies.length === 0) {
      throw new BadRequestException('Source media is missing its object key');
    }

    const reservedKeys: string[] = [];
    try {
      const nextAttemptAt = new Date(Date.now() + FORWARD_COPY_RESERVATION_MS);
      for (const copy of plannedCopies) {
        await this.prisma.chatMediaDeletion.upsert({
          where: { objectKey: copy.destinationKey },
          create: {
            objectKey: copy.destinationKey,
            attempts: 0,
            lastError: 'forward copy pending message commit',
            nextAttemptAt,
          },
          update: {
            attempts: 0,
            lastError: 'forward copy pending message commit',
            nextAttemptAt,
          },
        });
        reservedKeys.push(copy.destinationKey);
      }
      for (const copy of plannedCopies) {
        await this.uploadService.copyObjectToKey(
          copy.sourceKey,
          copy.destinationKey,
        );
        content[copy.field] = copy.destinationKey;
      }
      return { content, copiedKeys: reservedKeys };
    } catch (error) {
      if (reservedKeys.length > 0) await this.deleteObjects(reservedKeys);
      throw error;
    }
  }

  /** 落一条待删记录(幂等:同 key 重复入队只刷新失败原因)。 */
  private async enqueueDeletion(key: string, error: unknown): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`chat media delete failed key=${key}: ${reason}`);
    try {
      await this.prisma.chatMediaDeletion.upsert({
        where: { objectKey: key },
        create: {
          objectKey: key,
          attempts: 1,
          lastError: reason.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + DELETE_BACKOFF_BASE_MS),
        },
        update: {
          attempts: { increment: 1 },
          lastError: reason.slice(0, 500),
          nextAttemptAt: new Date(Date.now() + DELETE_BACKOFF_BASE_MS),
        },
      });
    } catch (dbError) {
      // 连待办都落不下(库也挂了):只能记日志。这是唯一真正会丢 key 的路径,
      // 所以用 error 级别,让它在告警里看得见。
      this.logger.error(
        `chat media delete could not be queued key=${key}: ${
          dbError instanceof Error ? dbError.message : String(dbError)
        }`,
      );
    }
  }

  /** 到期的待删记录重投一轮。成功即删行,失败按指数退避推后。 */
  async drainPendingDeletions(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.prisma.chatMediaDeletion.findMany({
        where: {
          nextAttemptAt: { lte: new Date() },
          attempts: { lt: DELETE_MAX_ATTEMPTS },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: DELETE_SWEEP_BATCH,
      });
      for (const row of due) {
        // 一、事务内认领。只做数据库的事:复核、按引用计数销行、否则把
        // nextAttemptAt 推后一个租约把这条占住。对象存储调用绝不能放进来 ——
        // Prisma 交互事务默认只有几秒超时,一次慢的 MinIO/S3 删除会让整个事务
        // 超时回滚,行既没删掉也没记下重试状态,还白占一个连接和 advisory lock。
        const claimed = await this.prisma.$transaction(async (tx) => {
          await this.lockNoteImportKeys(tx, [row.objectKey]);
          const current = await tx.chatMediaDeletion.findUnique({
            where: { id: row.id },
          });
          if (
            !current ||
            current.attempts >= DELETE_MAX_ATTEMPTS ||
            current.nextAttemptAt.getTime() > Date.now()
          ) {
            return null;
          }
          const referenceCount = await tx.chatMediaReference.count({
            where: { objectKey: current.objectKey },
          });
          if (referenceCount > 0) {
            await tx.chatMediaDeletion.delete({ where: { id: current.id } });
            return null;
          }
          // 租约:并发 sweeper 的 due 查询按 nextAttemptAt <= now 过滤,推后之后
          // 别的实例就不会在本次删除还在飞的时候重复删同一个 key。
          await tx.chatMediaDeletion.update({
            where: { id: current.id },
            data: {
              nextAttemptAt: new Date(Date.now() + DELETE_CLAIM_LEASE_MS),
            },
          });
          return current;
        });
        if (!claimed) continue;

        // 二、事务外做对象存储删除,再用条件写回落库结果。用 deleteMany/updateMany
        // 而不是 delete/update:行若被并发销掉,这里应当是无操作而不是抛 P2025。
        try {
          await this.uploadService.deleteObjectByKey(claimed.objectKey);
          await this.prisma.chatMediaDeletion.deleteMany({
            where: { id: claimed.id },
          });
        } catch (error) {
          const attempts = claimed.attempts + 1;
          const backoff = Math.min(
            DELETE_BACKOFF_BASE_MS * 2 ** claimed.attempts,
            DELETE_BACKOFF_MAX_MS,
          );
          await this.prisma.chatMediaDeletion.updateMany({
            where: { id: claimed.id },
            data: {
              attempts,
              lastError: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 500),
              nextAttemptAt: new Date(Date.now() + backoff),
            },
          });
          if (attempts >= DELETE_MAX_ATTEMPTS) {
            this.logger.error(
              `chat media delete dead-lettered key=${claimed.objectKey} after ${attempts} attempts`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.warn(
        `chat media deletion sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.sweeping = false;
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

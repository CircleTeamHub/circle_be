import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  reportJobSkipped,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import { ChatMediaService } from './chat-media.service';
import {
  CHAT_NOTE_IMPORT_SEGMENT,
  MEDIA_MESSAGE_TYPES,
} from './chat.constants';

/**
 * S-01 会话级阅后即焚的真删器:每分钟扫描开了焚毁的会话,把超龄消息软删
 * (deleted=true + content 清空,height 坐标保留)并删除对象存储里的媒体
 * —— 只软删不删对象等于焚毁只焚了个寂寞。
 *
 * 读路径同时按 burnDurationSec 过滤,盖住「已到期、尚未被扫掉」的 ≤1min 间隙,
 * 所以这里晚一拍无碍;单轮批量有上限,防止长会话首开焚毁时一口气删爆。
 */
const SWEEP_BATCH = 500;
const SWEEP_BATCHES_MAX = 4;
/**
 * 单轮扫描的会话数上限。不封顶的话,开焚毁的会话一多,每分钟一次的全表
 * findMany 会把整份结果拉进内存,后面又逐会话串行查消息 —— 一轮扫描跑过一分钟,
 * 下一轮直接被 running 挡掉,过期消息越积越久。按 id 排序 + 游标续扫,
 * 跨轮次轮转,长期覆盖不丢会话。
 */
const SWEEP_CONVERSATIONS_MAX = 200;

@Injectable()
export class ChatBurnSweeperService {
  private readonly logger = new Logger(ChatBurnSweeperService.name);
  private running = false;
  /** 上一轮扫到的最后一个会话 id(轮转游标);扫完一圈回到开头。 */
  private cursor: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: ChatMediaService,
  ) {}

  @TrackedCron(CronExpression.EVERY_MINUTE, 'chat_burn_sweeper')
  async sweep(): Promise<void> {
    // 跳过不是成功 —— 详见 temp-chat.cleanup 里同一处守卫的注释：卡死的那一轮
    // 会被后续每一次跳过持续刷新心跳，两条 cron 告警一起失明。
    if (this.running) {
      reportJobSkipped();
      return;
    }
    this.running = true;
    try {
      const burning = await this.prisma.chatConversation.findMany({
        where: {
          burnDurationSec: { not: null },
          ...(this.cursor ? { id: { gt: this.cursor } } : {}),
        },
        select: { id: true, burnDurationSec: true },
        orderBy: { id: 'asc' },
        take: SWEEP_CONVERSATIONS_MAX,
      });
      this.cursor =
        burning.length === SWEEP_CONVERSATIONS_MAX
          ? burning[burning.length - 1].id
          : null;
      for (const conversation of burning) {
        const seconds = conversation.burnDurationSec;
        if (!seconds || seconds <= 0) continue;
        await this.sweepConversation(conversation.id, seconds);
      }
    } catch (error) {
      this.logger.error(
        `burn sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      reportHandledJobFailure();
    } finally {
      this.running = false;
    }
  }

  private async sweepConversation(
    conversationId: string,
    seconds: number,
  ): Promise<void> {
    for (let round = 0; round < SWEEP_BATCHES_MAX; round += 1) {
      // 每一批都重读当前策略,而不是复用进入本轮时的那份。批与批之间可能过了
      // 好几秒,期间 POST /burn 完全可能把时长改长或关掉 —— 拿旧 cutoff 接着删,
      // 删掉的就是用户刚刚决定要留下的消息,而且不可逆。
      const current = await this.prisma.chatConversation.findUnique({
        where: { id: conversationId },
        select: { burnDurationSec: true },
      });
      const live = current?.burnDurationSec ?? null;
      if (!live || live <= 0) return;
      if (round === 0 && live !== seconds) {
        this.logger.log(
          `burn duration changed mid-sweep conversation=${conversationId}`,
        );
      }
      const cutoff = new Date(Date.now() - live * 1000);
      const rows = await this.prisma.chatMessage.findMany({
        where: {
          conversationID: conversationId,
          deleted: false,
          createdAt: { lt: cutoff },
        },
        select: { id: true, type: true, content: true },
        take: SWEEP_BATCH,
      });
      if (rows.length === 0) return;
      const allMediaKeys = rows
        .filter((row) => MEDIA_MESSAGE_TYPES.includes(row.type))
        .flatMap((row) => {
          const content = (row.content ?? {}) as Record<string, unknown>;
          return ['key', 'thumbKey']
            .map((field) => content[field])
            .filter((v): v is string => typeof v === 'string' && v.length > 0);
        });
      const messageIds = rows.map((row) => row.id);
      const noteImportKeys = allMediaKeys.filter((key) =>
        key.includes(`/${CHAT_NOTE_IMPORT_SEGMENT}`),
      );
      const ownedMediaKeys = allMediaKeys.filter(
        (key) => !key.includes(`/${CHAT_NOTE_IMPORT_SEGMENT}`),
      );
      await this.prisma.$transaction(async (tx) => {
        await tx.chatMessage.updateMany({
          where: { id: { in: messageIds } },
          // contentHistory 一起清:编辑过的消息把每一版旧正文都留在这里,只清
          // content 的话,「烧掉」的其实只有最后一版,前面几版连同备份长期留在库里。
          data: { deleted: true, content: {}, contentHistory: [] },
        });
        await this.media.releaseNoteImportReferences(
          tx,
          messageIds,
          noteImportKeys,
        );
      });
      if (ownedMediaKeys.length > 0) {
        // deleteObjects 内部逐 key 尽力而为;失败只留孤儿对象,不中断焚毁。
        void this.media.deleteObjects(ownedMediaKeys);
      }
      if (noteImportKeys.length > 0) {
        void this.media.drainPendingDeletions();
      }
      this.logger.log(
        `burned ${rows.length} messages conversation=${conversationId}`,
      );
      if (rows.length < SWEEP_BATCH) return;
    }
  }
}

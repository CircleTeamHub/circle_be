import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from './upload.service';

/**
 * 存量对象盘点（**只报告，不删除**）。
 *
 * 背景：本仓库至今没有任何一处删除 MinIO 对象 —— 删笔记、换头像、注销账号都不释放
 * 一个字节，minio_data 与 Postgres 同机，写满时倒下的是数据库。
 *
 * 为什么先只报告：判错一个对象就是删掉用户的头像或笔记配图，且不可逆。真正的 GC
 * 必须先用真实数据核对过引用清单才能开。这个 cron 每天出一份「疑似无人引用」的
 * 账，人工核对若干天、确认零误判后，才谈自动删除。
 *
 * ⚠️ 绝对不能扫的前缀：`chat/`。
 * 聊天图片的 URL 固化在 OpenIM 的消息体里（Mongo），circle_be 的 Postgres 里
 * **一条引用都没有**（见 upload.service.ts 的 publicPrefixes 注释）。按 Postgres
 * 找孤儿的话，每一张聊天图片都会被判成孤儿 —— 一次「清理」就能删光全站聊天图片。
 * 同理 `note-exports/` 由 MinIO 生命周期规则回收，不归这里管。
 */
@Injectable()
export class StorageAuditService {
  private readonly logger = new Logger(StorageAuditService.name);

  /**
   * 只盘点「引用完全落在 Postgres 里」的前缀。新增前缀时必须同步在
   * collectReferencedKeys 里补上它的引用来源，否则那批对象会被误报成孤儿。
   */
  private static readonly AUDITED_PREFIXES = [
    'avatars/',
    'covers/',
    'posts/',
    'notes/',
    'friends/',
  ] as const;

  /**
   * 宽限期：刚 presign 完还没写库的对象不算孤儿。客户端拿到直传地址后才上传，
   * 上传成功再回调建行，中间有几秒到几分钟的窗口；用户中途放弃也很正常。
   * 24h 远大于任何正常窗口。
   */
  private static readonly GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

  /** 报告里最多列几个样例 key，避免把日志刷爆。 */
  private static readonly SAMPLE_SIZE = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly upload: UploadService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async audit(now: Date = new Date()): Promise<{
    scanned: number;
    orphanCount: number;
    orphanBytes: number;
  } | null> {
    try {
      const referenced = await this.collectReferencedKeys();
      const cutoff = new Date(
        now.getTime() - StorageAuditService.GRACE_PERIOD_MS,
      );

      let scanned = 0;
      let orphanCount = 0;
      let orphanBytes = 0;
      const samples: string[] = [];

      for (const prefix of StorageAuditService.AUDITED_PREFIXES) {
        let token: string | undefined;
        do {
          const page = await this.upload.listObjects(prefix, token);
          token = page.nextContinuationToken;
          for (const object of page.objects) {
            scanned += 1;
            if (object.lastModified && object.lastModified > cutoff) continue;
            if (referenced.has(object.key)) continue;
            orphanCount += 1;
            orphanBytes += object.size;
            if (samples.length < StorageAuditService.SAMPLE_SIZE) {
              samples.push(object.key);
            }
          }
        } while (token);
      }

      this.logger.log(
        `storage audit: scanned=${scanned} orphaned=${orphanCount} ` +
          `bytes=${orphanBytes} (report only, nothing deleted)`,
      );
      if (samples.length > 0) {
        this.logger.log(`orphan samples: ${samples.join(', ')}`);
      }
      return { scanned, orphanCount, orphanBytes };
    } catch (err) {
      // 盘点失败只影响这份账，不影响业务；明天的 cron 会重试。
      this.logger.error(
        'storage audit failed',
        err instanceof Error ? err.stack : String(err),
      );
      return null;
    }
  }

  /**
   * 收集 Postgres 里所有引用到的对象 key。
   *
   * 存的是完整 URL（形如 https://<域名>/circle/<key>），这里统一还原成 key 再比对 ——
   * 域名会随环境变化（dev 是 IP:端口、生产是域名），拿 URL 直接比会把历史对象全判成孤儿。
   *
   * ⚠️ 漏掉任何一处引用来源，那批对象就会被误报。新增存 URL 的字段时必须同步这里。
   */
  private async collectReferencedKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    const add = (value: unknown) => {
      if (typeof value !== 'string' || value.length === 0) return;
      const key = this.toObjectKey(value);
      if (key) keys.add(key);
    };

    // 这份清单是从 schema 里逐个 String 字段筛出来的（名字含 url/avatar/cover/
    // image/photo 的全部 14 个），不是凭印象列的。少一处 = 那批对象被误报成孤儿。
    const [
      users,
      avatarFrameAssets,
      iconAssets,
      friends,
      circles,
      noteMedia,
      traces,
      traceComments,
      circlePosts,
    ] = await Promise.all([
      this.prisma.user.findMany({
        select: { avatarUrl: true, avatarFrame: true, cover: true },
      }),
      this.prisma.avatarFrameAsset.findMany({ select: { imageUrl: true } }),
      this.prisma.iconAsset.findMany({ select: { imageUrl: true } }),
      this.prisma.friend.findMany({ select: { photosA: true, photosB: true } }),
      this.prisma.circle.findMany({ select: { avatarUrl: true, cover: true } }),
      this.prisma.noteMedia.findMany({
        select: { url: true, posterUrl: true },
      }),
      this.prisma.trace.findMany({ select: { images: true } }),
      this.prisma.traceComment.findMany({ select: { images: true } }),
      this.prisma.circlePost.findMany({ select: { images: true } }),
    ]);

    for (const row of users) {
      add(row.avatarUrl);
      add(row.avatarFrame);
      add(row.cover);
    }
    for (const row of avatarFrameAssets) add(row.imageUrl);
    for (const row of iconAssets) add(row.imageUrl);
    for (const row of friends) {
      row.photosA.forEach(add);
      row.photosB.forEach(add);
    }
    for (const row of circles) {
      add(row.avatarUrl);
      add(row.cover);
    }
    for (const row of noteMedia) {
      add(row.url);
      add(row.posterUrl);
    }
    for (const row of traces) row.images.forEach(add);
    for (const row of traceComments) row.images.forEach(add);
    for (const row of circlePosts) row.images.forEach(add);

    return keys;
  }

  /** 从完整 URL 还原对象 key：https://host/<bucket>/<key> → <key>。 */
  private toObjectKey(value: string): string | null {
    try {
      const path = new URL(value).pathname.replace(/^\/+/, '');
      const slash = path.indexOf('/');
      return slash === -1 ? null : path.slice(slash + 1);
    } catch {
      // 不是 URL 而是裸 key 的历史数据，原样当 key 用。
      return value.replace(/^\/+/, '') || null;
    }
  }
}

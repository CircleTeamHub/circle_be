import { Injectable, Logger } from '@nestjs/common';
import { CronExpression } from '@nestjs/schedule';
import {
  reportHandledJobFailure,
  TrackedCron,
} from '../metrics/tracked-cron.decorator';
import { createHash } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CHAT_MEDIA_KEY_FIELDS } from 'src/chat/chat.constants';
import { UploadService } from './upload.service';

/**
 * 存量对象盘点（**只报告，不删除**）。
 *
 * 背景：除聊天栈的撤回/焚毁/清空外，本仓库没有别的删除 MinIO 对象的路径 ——
 * 删笔记、换头像、注销账号都不释放一个字节，minio_data 与 Postgres 同机，
 * 写满时倒下的是数据库。
 *
 * 为什么先只报告：判错一个对象就是删掉用户的头像或笔记配图，且不可逆。真正的 GC
 * 必须先用真实数据核对过引用清单才能开。这个 cron 每天出一份「疑似无人引用」的
 * 账，人工核对若干天、确认零误判后，才谈自动删除。
 *
 * `chat/`（自研聊天栈起）：媒体消息 content 只存 object key
 * （字段表见 chat.constants 的 CHAT_MEDIA_KEY_FIELDS），引用完全落在 Postgres 的
 * ChatMessage 表里，纳入盘点。撤回/焚毁/清空会主动删对象但是尽力而为
 * （ChatMediaService.deleteObjects 单个失败只记日志），删失败的与
 * 「上传成功但消息没发出去」的对象靠这份账兜底；presign 到发消息之间的
 * 正常窗口由 24h 宽限期覆盖。OpenIM 时代这个前缀是绝对不能扫的
 * （引用固化在 Mongo，Postgres 一条都没有），那条禁令随迁移作废。
 * `note-exports/` 由 MinIO 生命周期规则回收，不归这里管。
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
    'chat/',
  ] as const;

  /**
   * 宽限期：刚 presign 完还没写库的对象不算孤儿。客户端拿到直传地址后才上传，
   * 上传成功再回调建行，中间有几秒到几分钟的窗口；用户中途放弃也很正常。
   * 24h 远大于任何正常窗口。
   */
  private static readonly GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

  /** 报告里最多列几个样例，避免把日志刷爆。 */
  private static readonly SAMPLE_SIZE = 20;

  /**
   * 每批从 Postgres 取多少行。十张表同时 findMany 全量物化,大表(聊天媒体、笔记媒体、
   * 朋友圈、帖子、好友照片数组)在生产体量下会同时占掉连接池十条里的九条,
   * 并把整份结果集连同所有引用留在 1 GiB 的容器里 —— 05:00 那一刻要么把请求
   * 饿死,要么直接 OOM。改成逐表、游标分批,并且只留下还原后的 key。
   */
  private static readonly REFERENCE_BATCH_SIZE = 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly upload: UploadService,
  ) {}

  @TrackedCron(CronExpression.EVERY_DAY_AT_5AM, 'storage_audit')
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
              samples.push(this.redactKey(object.key));
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
      reportHandledJobFailure();
      return null;
    }
  }

  /**
   * 样例 key 只记「前缀 + 不可逆摘要」。
   *
   * 原样打进日志有两个问题:key 里带用户 id;而 friends/ 这类前缀是匿名可读的,
   * 拿到 key 就能拼出可直接下载的 URL。更麻烦的是这份账**会误报** ——
   * 被列出来的对象未必真的没人引用,等于把仍在使用的用户媒体地址抄进了日志。
   * 出问题时按前缀计数定位足够,要具体 key 就去查对象存储本身。
   */
  private redactKey(key: string): string {
    const slash = key.indexOf('/');
    const prefix = slash === -1 ? '' : key.slice(0, slash + 1);
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 12);
    return `${prefix}<${digest}>`;
  }

  /**
   * 逐批读一张表并把引用喂给 add,读完即丢 —— 不把 Prisma 行留在内存里。
   * 用 id 游标而不是 skip:大表上 OFFSET 会越翻越慢。
   */
  private async collectFrom<T extends { id: string }>(
    fetchPage: (cursor: string | undefined, take: number) => Promise<T[]>,
    extract: (row: T) => void,
  ): Promise<void> {
    let cursor: string | undefined;
    for (;;) {
      const rows = await fetchPage(
        cursor,
        StorageAuditService.REFERENCE_BATCH_SIZE,
      );
      for (const row of rows) extract(row);
      if (rows.length < StorageAuditService.REFERENCE_BATCH_SIZE) return;
      cursor = rows[rows.length - 1].id;
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
    //
    // 逐表串行、分批读:十张表并发全量物化会一口吃满连接池,
    // 并把整份结果集留在内存里。这份账每天只跑一次,慢一点无所谓,
    // 把生产在 05:00 拖垮才是问题。
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.user.findMany({
          select: { id: true, avatarUrl: true, avatarFrame: true, cover: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        add(row.avatarUrl);
        add(row.avatarFrame);
        add(row.cover);
      },
    );
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.avatarFrameAsset.findMany({
          select: { id: true, imageUrl: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => add(row.imageUrl),
    );
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.iconAsset.findMany({
          select: { id: true, imageUrl: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => add(row.imageUrl),
    );
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.friend.findMany({
          select: {
            id: true,
            photosA: true,
            photosB: true,
            // 建好友申请时带的照片在接受之前一直存在这里。漏掉它的话,
            // 一个挂了超过 24h 宽限期的待处理申请,它那批仍被引用的照片
            // 会被报成孤儿 —— 而这份账正是用来授权后续清理的。
            pendingPhotosBySender: true,
          },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        row.photosA.forEach(add);
        row.photosB.forEach(add);
        row.pendingPhotosBySender.forEach(add);
      },
    );
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.circle.findMany({
          select: { id: true, avatarUrl: true, cover: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        add(row.avatarUrl);
        add(row.cover);
      },
    );
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.noteMedia.findMany({
          select: { id: true, url: true, posterUrl: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        add(row.url);
        add(row.posterUrl);
      },
    );
    // 下面三张刻意逐张写死,不走动态表名:storage-audit.service.spec.ts 用
    // `this.prisma.<table>.findMany` 的字面量守「十张表一个都不能漏」——
    // 漏一处就是那批对象被误报成孤儿,而这份账是用来授权删除的。
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.trace.findMany({
          select: { id: true, images: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => row.images.forEach(add),
    );
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.traceComment.findMany({
          select: { id: true, images: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => row.images.forEach(add),
    );
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.circlePost.findMany({
          select: { id: true, images: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => row.images.forEach(add),
    );
    // 聊天媒体:content 只存裸 key(add 的 toObjectKey 对裸 key 原样放行)。
    // 只扫字段表里有媒体的类型 —— ChatMessage 是全库最大的表,text/卡片类
    // 没有媒体 key,全表扫一遍纯属把 05:00 的账拖慢。
    await this.collectFrom(
      (cursor, take) =>
        this.prisma.chatMessage.findMany({
          where: { type: { in: Object.keys(CHAT_MEDIA_KEY_FIELDS) } },
          select: { id: true, type: true, content: true },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      (row) => {
        const fields = CHAT_MEDIA_KEY_FIELDS[row.type];
        if (!fields) return;
        const content = row.content;
        if (typeof content !== 'object' || content === null) return;
        for (const field of fields) {
          add((content as Record<string, unknown>)[field.key]);
        }
      },
    );

    return keys;
  }

  /**
   * 从完整 URL 还原对象 key，兼容当前配置、历史域名、path-style 与
   * virtual-hosted-style。
   */
  private toObjectKey(value: string): string | null {
    const canonical = this.upload.objectKeyFromPublicUrl(value);
    if (canonical) return canonical;

    try {
      const path = new URL(value).pathname.replace(/^\/+/, '');
      if (
        StorageAuditService.AUDITED_PREFIXES.some((prefix) =>
          path.startsWith(prefix),
        )
      ) {
        return path;
      }
      const slash = path.indexOf('/');
      return slash === -1 ? null : path.slice(slash + 1);
    } catch {
      // 不是 URL 而是裸 key 的历史数据，原样当 key 用。
      return value.replace(/^\/+/, '') || null;
    }
  }
}

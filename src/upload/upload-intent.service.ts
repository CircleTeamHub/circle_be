import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type UploadIntent } from 'src/generated/prisma';
import {
  uploadMetrics,
  type UploadIntentFolder,
  type UploadIntentMode,
} from 'src/metrics/upload-metrics';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  UPLOAD_PURPOSE_FOLDERS,
  type UploadFolder,
  type UploadPurpose,
} from './dto/presign.dto';
import { UploadService } from './upload.service';

const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const DELETE_LEASE_MS = 15 * 60 * 1000;
const DELETE_BACKOFF_BASE_MS = 60 * 1000;
const DELETE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECLAIM_BATCH_SIZE = 100;
const RECLAIM_MAX_ROWS_PER_RUN = 500;
const REFERENCE_SCAN_PAGE_SIZE = 100;
const DELETE_ERROR_MAX_LENGTH = 500;
const TRACKED_FOLDERS: readonly UploadIntentFolder[] = ['avatars', 'posts'];

const EXPIRED_UPLOAD_MESSAGE = '上传已过期，请重新选择';
const INVALID_UPLOAD_MESSAGE = '上传文件与当前用户或用途不匹配';

export interface TrackUploadIntentInput {
  objectKey: string;
  fileUrl: string;
  userID: string;
  purpose?: UploadPurpose;
  folder: UploadFolder;
  sizeBytes: number;
}

@Injectable()
export class UploadIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly upload: UploadService,
    private readonly config: ConfigService,
  ) {}

  async track(input: TrackUploadIntentInput, now = new Date()): Promise<void> {
    if (
      !input.purpose ||
      UPLOAD_PURPOSE_FOLDERS[input.purpose] !== input.folder
    ) {
      return;
    }

    await this.prisma.uploadIntent.create({
      data: {
        objectKey: input.objectKey,
        fileUrl: input.fileUrl,
        userID: input.userID,
        purpose: input.purpose,
        folder: input.folder,
        sizeBytes: input.sizeBytes,
        status: 'PENDING',
        expiresAt: new Date(now.getTime() + INTENT_TTL_MS),
      },
    });
    uploadMetrics.recordIntentEvent(input.folder, 'created', 'request');
  }

  async claim(
    tx: Prisma.TransactionClient,
    userID: string,
    purpose: UploadPurpose,
    values: readonly string[],
    now = new Date(),
  ): Promise<void> {
    const folder = UPLOAD_PURPOSE_FOLDERS[purpose];
    const keys = this.keysForPurpose(folder, values);

    for (const objectKey of keys) {
      const row = await tx.uploadIntent.findUnique({ where: { objectKey } });
      if (!row || row.status === 'CLAIMED') continue;

      if (
        (row.status === 'PENDING' || row.status === 'DELETING') &&
        (row.userID !== userID || row.purpose !== purpose)
      ) {
        throw new BadRequestException(INVALID_UPLOAD_MESSAGE);
      }
      if (row.status === 'DELETING' || row.status === 'DELETED') {
        throw new BadRequestException(EXPIRED_UPLOAD_MESSAGE);
      }

      const claimed = await tx.uploadIntent.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: 'CLAIMED',
          claimedAt: now,
          deleteLeaseUntil: null,
          lastDeleteError: null,
        },
      });
      if (claimed.count === 1) {
        uploadMetrics.recordIntentEvent(
          row.folder as UploadIntentFolder,
          'claimed',
          'request',
        );
        continue;
      }

      const current = await tx.uploadIntent.findUnique({
        where: { objectKey },
      });
      if (!current || current.status === 'CLAIMED') continue;
      if (current.status === 'DELETING' || current.status === 'DELETED') {
        throw new BadRequestException(EXPIRED_UPLOAD_MESSAGE);
      }
      throw new BadRequestException(INVALID_UPLOAD_MESSAGE);
    }
  }

  async reclaim(
    referencedSnapshot: ReadonlySet<string>,
    now = new Date(),
  ): Promise<void> {
    const mode = this.gcMode();
    await this.recordPendingGauges(mode);
    let afterId: string | undefined;
    let processed = 0;
    const dueForRun: UploadIntent[] = [];
    const maxRows = RECLAIM_MAX_ROWS_PER_RUN;
    while (processed < maxRows) {
      const take = Math.min(RECLAIM_BATCH_SIZE, maxRows - processed);
      const due = await this.prisma.uploadIntent.findMany({
        where: afterId
          ? { AND: [this.dueWhere(now), { id: { gt: afterId } }] }
          : this.dueWhere(now),
        orderBy: { id: 'asc' },
        take,
      });
      if (due.length === 0) break;

      processed += due.length;
      dueForRun.push(...due);
      for (const row of due) {
        const folder = this.metricFolder(row.folder);
        if (folder) uploadMetrics.recordIntentEvent(folder, 'due', mode);
      }
      if (due.length < take) break;
      afterId = due[due.length - 1].id;
    }

    await this.processDueBatch(dueForRun, referencedSnapshot, mode, now);

    const dueAfterRun = await this.prisma.uploadIntent.count({
      where: this.dueWhere(now),
    });
    const backlog =
      mode === 'report' ? Math.max(0, dueAfterRun - processed) : dueAfterRun;
    uploadMetrics.setIntentBacklog(mode, backlog);

    if (mode === 'delete') {
      const terminalCutoff = new Date(now.getTime() - TERMINAL_RETENTION_MS);
      await this.prisma.uploadIntent.deleteMany({
        where: {
          OR: [
            { status: 'CLAIMED', claimedAt: { lte: terminalCutoff } },
            { status: 'DELETED', deletedAt: { lte: terminalCutoff } },
          ],
        },
      });
    }
  }

  private dueWhere(now: Date): Prisma.UploadIntentWhereInput {
    return {
      OR: [
        { status: 'PENDING', expiresAt: { lte: now } },
        { status: 'DELETING', deleteLeaseUntil: { lte: now } },
      ],
    };
  }

  private async processDueBatch(
    due: readonly UploadIntent[],
    referencedSnapshot: ReadonlySet<string>,
    mode: Exclude<UploadIntentMode, 'request'>,
    now: Date,
  ): Promise<void> {
    const unreconciled: UploadIntent[] = [];
    for (const row of due) {
      if (referencedSnapshot.has(row.objectKey)) {
        if (mode === 'delete') await this.rescue(row, now);
      } else {
        unreconciled.push(row);
      }
    }

    const freshReferences = await this.collectFreshReferencedKeys(unreconciled);
    if (mode === 'report') {
      for (const row of due) {
        const folder = this.metricFolder(row.folder);
        if (!folder) continue;
        const referenced =
          referencedSnapshot.has(row.objectKey) ||
          freshReferences.has(row.objectKey);
        uploadMetrics.recordIntentEvent(
          folder,
          referenced ? 'would_rescue' : 'would_delete',
          mode,
        );
      }
      return;
    }

    for (const row of unreconciled) {
      if (freshReferences.has(row.objectKey)) {
        await this.rescue(row, now);
      } else {
        await this.deleteUnreferenced(row, now, mode);
      }
    }
  }

  private async deleteUnreferenced(
    row: UploadIntent,
    now: Date,
    mode: 'delete',
  ): Promise<void> {
    const leaseUntil = this.newLeaseUntil(now);
    const lease = await this.prisma.uploadIntent.updateMany({
      where:
        row.status === 'PENDING'
          ? { id: row.id, status: 'PENDING', expiresAt: { lte: now } }
          : {
              id: row.id,
              status: 'DELETING',
              deleteLeaseUntil: row.deleteLeaseUntil,
            },
      data: {
        status: 'DELETING',
        deleteLeaseUntil: leaseUntil,
        lastDeleteError: null,
      },
    });
    if (lease.count !== 1) {
      await this.prisma.uploadIntent.findUnique({ where: { id: row.id } });
      return;
    }

    const ownLease = {
      id: row.id,
      status: 'DELETING' as const,
      deleteLeaseUntil: leaseUntil,
    };
    try {
      await this.upload.deleteObjectByKey(row.objectKey);
    } catch (error) {
      const attempts = row.deleteAttempts + 1;
      const backoff = Math.min(
        DELETE_BACKOFF_BASE_MS * 2 ** row.deleteAttempts,
        DELETE_BACKOFF_MAX_MS,
      );
      try {
        await this.prisma.uploadIntent.updateMany({
          where: ownLease,
          data: {
            status: 'PENDING',
            deleteAttempts: attempts,
            lastDeleteError: this.errorMessage(error),
            expiresAt: new Date(now.getTime() + backoff),
            deleteLeaseUntil: null,
          },
        });
      } catch {
        // Preserve the lease for an idempotent retry after it expires.
      }
      const folder = this.metricFolder(row.folder);
      if (folder)
        uploadMetrics.recordIntentEvent(folder, 'delete_failed', mode);
      return;
    }

    try {
      const written = await this.prisma.uploadIntent.updateMany({
        where: ownLease,
        data: {
          status: 'DELETED',
          deletedAt: now,
          deleteLeaseUntil: null,
          lastDeleteError: null,
        },
      });
      const folder = this.metricFolder(row.folder);
      if (!folder) return;
      uploadMetrics.recordIntentEvent(
        folder,
        written.count === 1 ? 'deleted' : 'delete_failed',
        mode,
      );
    } catch {
      const folder = this.metricFolder(row.folder);
      if (folder)
        uploadMetrics.recordIntentEvent(folder, 'delete_failed', mode);
    }
  }

  private keysForPurpose(
    folder: UploadIntentFolder,
    values: readonly string[],
  ): string[] {
    const prefix = `${folder}/`;
    const keys = new Set<string>();
    for (const value of values) {
      const urlKey = this.upload.objectKeyFromPublicUrl(value);
      if (urlKey?.startsWith(prefix)) {
        keys.add(urlKey);
        continue;
      }
      if (
        !value.includes('://') &&
        value.startsWith(prefix) &&
        !value.split('/').some((part) => part === '.' || part === '..')
      ) {
        keys.add(value);
      }
    }
    return [...keys];
  }

  private async rescue(row: UploadIntent, now: Date): Promise<void> {
    const rescued = await this.prisma.uploadIntent.updateMany({
      where:
        row.status === 'PENDING'
          ? { id: row.id, status: 'PENDING' }
          : {
              id: row.id,
              status: 'DELETING',
              deleteLeaseUntil: row.deleteLeaseUntil,
            },
      data: {
        status: 'CLAIMED',
        claimedAt: now,
        deleteLeaseUntil: null,
        lastDeleteError: null,
      },
    });
    if (rescued.count === 1) {
      const folder = this.metricFolder(row.folder);
      if (folder) uploadMetrics.recordIntentEvent(folder, 'rescued', 'delete');
    }
  }

  private async collectFreshReferencedKeys(
    rows: readonly UploadIntent[],
  ): Promise<Set<string>> {
    const matches = new Set<string>();
    const byPurpose = new Map<UploadPurpose, UploadIntent[]>();
    for (const row of rows) {
      const purpose = row.purpose as UploadPurpose;
      const group = byPurpose.get(purpose) ?? [];
      group.push(row);
      byPurpose.set(purpose, group);
    }

    for (const [purpose, intents] of byPurpose) {
      const targets = new Set(intents.map((intent) => intent.objectKey));
      switch (purpose) {
        case 'PROFILE_AVATAR':
          await this.scanReferencePages(
            (page) =>
              this.prisma.user.findMany({
                ...page,
                select: { id: true, avatarUrl: true },
              }),
            (candidate) =>
              this.addUrlMatch(candidate.avatarUrl, targets, matches),
          );
          break;
        case 'CIRCLE_AVATAR':
          await this.scanReferencePages(
            (page) =>
              this.prisma.circle.findMany({
                ...page,
                select: { id: true, avatarUrl: true },
              }),
            (candidate) =>
              this.addUrlMatch(candidate.avatarUrl, targets, matches),
          );
          break;
        case 'PLAZA_POST':
          await this.scanReferencePages(
            (page) =>
              this.prisma.circlePost.findMany({
                ...page,
                select: { id: true, images: true, videos: true },
              }),
            (candidate) => {
              for (const value of [...candidate.images, ...candidate.videos]) {
                this.addUrlMatch(value, targets, matches);
              }
            },
          );
          break;
        case 'MOMENT':
          await this.scanReferencePages(
            (page) =>
              this.prisma.trace.findMany({
                ...page,
                select: { id: true, images: true, attachments: true },
              }),
            (candidate) => {
              for (const value of candidate.images) {
                this.addUrlMatch(value, targets, matches);
              }
              this.addAttachmentMatches(
                candidate.attachments,
                targets,
                matches,
              );
            },
          );
          break;
        case 'MOMENT_COMMENT':
          await this.scanReferencePages(
            (page) =>
              this.prisma.traceComment.findMany({
                ...page,
                select: { id: true, images: true },
              }),
            (candidate) => {
              for (const value of candidate.images) {
                this.addUrlMatch(value, targets, matches);
              }
            },
          );
          break;
      }
    }
    return matches;
  }

  private async scanReferencePages<T extends { id: string }>(
    load: (page: {
      orderBy: { id: 'asc' };
      take: number;
      cursor?: { id: string };
      skip?: number;
    }) => Promise<T[]>,
    visit: (row: T) => void,
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await load({
        orderBy: { id: 'asc' },
        take: REFERENCE_SCAN_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of page) visit(row);
      if (page.length < REFERENCE_SCAN_PAGE_SIZE) return;
      cursor = page[page.length - 1].id;
    } while (cursor);
  }

  private addUrlMatch(
    value: string | null,
    targets: ReadonlySet<string>,
    matches: Set<string>,
  ): void {
    const key = this.upload.objectKeyFromPublicUrl(value);
    if (key && targets.has(key)) matches.add(key);
  }

  private addAttachmentMatches(
    value: Prisma.JsonValue,
    targets: ReadonlySet<string>,
    matches: Set<string>,
  ): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const attachment = item as Record<string, Prisma.JsonValue>;
      for (const field of ['key', 'posterKey'] as const) {
        const key = attachment[field];
        if (typeof key === 'string' && targets.has(key)) matches.add(key);
      }
    }
  }

  private async recordPendingGauges(
    mode: Exclude<UploadIntentMode, 'request'>,
  ) {
    const grouped = await this.prisma.uploadIntent.groupBy({
      by: ['folder'],
      where: { status: 'PENDING' },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    for (const folder of TRACKED_FOLDERS) {
      const row = grouped.find((item) => item.folder === folder);
      uploadMetrics.setIntentPending(
        folder,
        mode,
        row?._count._all ?? 0,
        row?._sum.sizeBytes ?? 0,
      );
    }
  }

  private gcMode(): Exclude<UploadIntentMode, 'request'> {
    return (
      this.config.get<'report' | 'delete'>('UPLOAD_INTENT_GC_MODE') ?? 'report'
    );
  }

  private newLeaseUntil(now: Date): Date {
    // Add a bounded per-process sequence so two reclaimers given the same clock
    // cannot accidentally share a write-back token.
    UploadIntentService.leaseSequence =
      (UploadIntentService.leaseSequence + 1) % 1000;
    return new Date(
      Math.max(now.getTime(), Date.now()) +
        DELETE_LEASE_MS +
        UploadIntentService.leaseSequence,
    );
  }

  private errorMessage(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      DELETE_ERROR_MAX_LENGTH,
    );
  }

  private metricFolder(folder: string): UploadIntentFolder | null {
    return folder === 'avatars' || folder === 'posts' ? folder : null;
  }

  private static leaseSequence = 0;
}

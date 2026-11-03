import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type { CustomSticker } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/upload/upload.service';
import { ChatService } from 'src/chat/chat.service';
import { CreateStickerDto } from './sticker.dto';

const MAX_STICKERS = 200;
const MAX_STICKER_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
]);

@Injectable()
export class StickerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly upload: UploadService,
    private readonly chat: ChatService,
  ) {}

  private async present(row: CustomSticker) {
    const date = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    const { url } = await this.upload.createPresignedGetUrl(
      row.objectKey,
      7200,
      date,
    );
    return {
      id: row.id,
      url,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async list(userID: string) {
    const rows = await this.prisma.customSticker.findMany({
      where: { userID },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_STICKERS,
    });
    return Promise.all(rows.map((row) => this.present(row)));
  }

  async create(userID: string, dto: CreateStickerDto) {
    if (Boolean(dto.objectKey) === Boolean(dto.messageId))
      throw new BadRequestException('Provide exactly one sticker source');
    let objectKey = dto.objectKey ?? '';
    let width = dto.width ?? null;
    let height = dto.height ?? null;
    let sourceKey: string | undefined;
    if (dto.messageId) {
      const { row } = await this.chat.requireVisibleMessage(
        userID,
        dto.messageId,
      );
      if (row.burnDurationSec || row.burnExpiresAt)
        throw new ForbiddenException(
          'Disappearing images cannot be saved as stickers',
        );
      const content = row.content as Record<string, unknown>;
      if (
        row.type !== 'image' ||
        typeof content?.key !== 'string' ||
        !/^chat\/[^/]+\/[^?#\\]+$/.test(content.key) ||
        content.key.includes('..')
      )
        throw new BadRequestException('Source must be a chat image');
      sourceKey = content.key;
      const extension =
        sourceKey
          .split('.')
          .pop()
          ?.replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 12) || 'bin';
      objectKey = `stickers/${userID}/${createHash('sha256').update(dto.messageId).digest('hex')}.${extension}`;
      width = typeof content.width === 'number' ? content.width : null;
      height = typeof content.height === 'number' ? content.height : null;
    } else if (
      !objectKey.startsWith(`stickers/${userID}/`) ||
      !/^stickers\/[^/]+\/[^/?#\\]+$/.test(objectKey) ||
      objectKey.includes('..') ||
      objectKey.includes('://')
    ) {
      throw new ForbiddenException(
        'Sticker object is not owned by current user',
      );
    }
    const sourceWhere = dto.messageId
      ? { userID, sourceMessageID: dto.messageId }
      : { userID, objectKey };
    const existing = await this.prisma.customSticker.findFirst({
      where: sourceWhere,
    });
    if (existing) return this.present(existing);
    const metadata = await this.upload.headObject(sourceKey ?? objectKey);
    if (
      !IMAGE_TYPES.has(metadata.contentType) ||
      metadata.size < 1 ||
      metadata.size > MAX_STICKER_BYTES
    )
      throw new BadRequestException({
        message: 'Sticker must be an image of at most 5 MiB',
        errorCode: 'STICKER_INVALID_IMAGE',
      });
    if (sourceKey) await this.upload.copyObjectToKey(sourceKey, objectKey);
    const row = await this.prisma.$transaction(async (tx) => {
      const lock = `stickers:${userID}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}))::text`;
      const duplicate = await tx.customSticker.findFirst({
        where: sourceWhere,
      });
      if (duplicate) return duplicate;
      if ((await tx.customSticker.count({ where: { userID } })) >= MAX_STICKERS)
        throw new BadRequestException({
          message: 'Sticker limit reached',
          errorCode: 'STICKER_LIMIT_REACHED',
        });
      return tx.customSticker.create({
        data: {
          userID,
          objectKey,
          width,
          height,
          sourceMessageID: dto.messageId ?? null,
        },
      });
    });
    return this.present(row);
  }

  async remove(userID: string, id: string): Promise<void> {
    const result = await this.prisma.customSticker.deleteMany({
      where: { id, userID },
    });
    if (!result.count) throw new NotFoundException('Sticker not found');
  }

  async prepareMessage(userID: string, id: string) {
    const row = await this.prisma.customSticker.findFirst({
      where: { id, userID },
    });
    if (!row) throw new NotFoundException('Sticker not found');
    const extension = row.objectKey.split('.').pop() || 'bin';
    const key = `chat/${userID}/${randomUUID()}.${extension}`;
    // Like an ordinary presigned chat upload, abandoned copies are visible to
    // the storage audit. A deletion row here would reject the subsequent send.
    await this.upload.copyObjectToKey(row.objectKey, key);
    return {
      key,
      width: row.width ?? undefined,
      height: row.height ?? undefined,
    };
  }
}

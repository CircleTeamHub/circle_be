import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NoteErrorCode } from 'src/common/app-error-codes';
import { randomBytes, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import PDFDocument from 'pdfkit';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/upload/upload.service';
import { assertUrlsFromStorage } from 'src/utils/storage-url';
import { prismaErrorCode } from 'src/utils/prisma-tx';
import {
  CollectNoteDto,
  CollectNoteResultDto,
  CreateNoteExportDto,
  CreateNoteDto,
  CreateNoteGroupDto,
  CreateNoteShareLinkDto,
  ListNoteShareLinksQueryDto,
  ListNotesQueryDto,
  NoteCollectSourceDto,
  NoteDetailDto,
  NoteExportResultDto,
  NoteGroupDto,
  NoteMediaType,
  NoteSectionsDto,
  NoteShareLinkDto,
  NoteStatus,
  NoteSummaryDto,
  NoteWritableStatus,
  SharedNoteListDto,
  UpdateNoteDto,
  UpdateNoteGroupDto,
} from './dto/note.dto';

// ── BlockNote inline content types ───────────────────────────────────────────
// These mirror the BlockNote default schema as documented at
// https://www.blocknotejs.org/docs/editor-basics/document-structure

type BNStyles = Record<string, boolean | string>;

type BNStyledText = {
  type: 'text';
  text: string;
  styles: BNStyles;
};

type BNLink = {
  type: 'link';
  href: string;
  content: BNStyledText[];
};

type BNInlineContent = BNStyledText | BNLink;

// TableContent as returned by BlockNote's table block
type BNTableContent = {
  type: 'tableContent';
  columnWidths?: (number | undefined)[];
  rows: { cells: BNInlineContent[][] }[];
};

type NoteContentBlock = {
  id?: string;
  type?: string;
  props?: Record<string, boolean | number | string>;
  content?: BNInlineContent[] | BNTableContent;
  children?: NoteContentBlock[];
};

function toPrismaJson(
  value: unknown | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  let result: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
  if (value === undefined) {
    result = undefined;
  } else if (value === null) {
    result = Prisma.DbNull;
  } else {
    result = value as Prisma.InputJsonValue;
  }
  return result;
}

// ── Typed row shapes returned by queries that use NOTE_INCLUDE ────────────────

type NoteMediaRow = {
  id: string;
  type: NoteMediaType;
  objectKey: string;
  url: string;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  posterUrl: string | null;
  sortOrder: number;
};

type NoteRow = {
  id: string;
  ownerID: string;
  title: string;
  content: string | null;
  contentJson: unknown;
  sections: unknown;
  status: NoteStatus;
  available: boolean;
  pinned: boolean;
  imageCount: number;
  videoCount: number;
  mediaCount: number;
  collectedFrom?: unknown;
  collectedFromNoteID?: string | null;
  createdAt: Date;
  updatedAt: Date;
  coverMedia: { id: string; type: NoteMediaType; url: string } | null;
  groupMemberships: Array<{ group: { id: string; name: string } }>;
  media: NoteMediaRow[];
};

type NoteLocationSection = {
  title?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
};

type NoteSections = {
  text: {
    content: string | null;
    contentJson: unknown[] | null;
  };
  media: {
    items: Array<Record<string, unknown>>;
  };
  showcase: {
    items: Array<Record<string, unknown>>;
  };
  location: NoteLocationSection | null;
};

type NoteGroupRow = {
  id: string;
  name: string;
  sortOrder: number;
  _count: { memberships: number };
};

const NOTE_INCLUDE = {
  media: {
    orderBy: {
      sortOrder: 'asc',
    },
  },
  coverMedia: {
    select: {
      id: true,
      type: true,
      url: true,
    },
  },
  groupMemberships: {
    where: {
      group: {
        deletedAt: null,
      },
    },
    include: {
      group: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
} as const;

const MAX_GROUPS_PER_USER = 50;

// Keep derived title/content in sync with the DTO's @MaxLength caps — text
// extracted from contentJson blocks otherwise bypasses DTO validation.
const MAX_NOTE_TITLE_LENGTH = 120;
const MAX_NOTE_CONTENT_LENGTH = 20_000;
const NOTE_EXPORT_TTL_SECONDS = 15 * 60;
// 读取时给笔记媒体现签短时 URL。signingDate 舍入到 WINDOW → 同窗口内同一对象签出字节相同的
// URL，客户端(expo-image)按-URL 缓存才命中；TTL = 窗口 + buffer，保证窗口内始终有效。
const NOTE_MEDIA_URL_WINDOW_MS = 60 * 60 * 1000; // 1h
const NOTE_MEDIA_URL_TTL_SECONDS = 2 * 60 * 60; // 2h
const MAX_EXPORT_MEDIA_ITEMS = 50;
const MAX_EXPORT_SINGLE_MEDIA_BYTES = 8 * 1024 * 1024;
const MAX_EXPORT_TOTAL_MEDIA_BYTES = 16 * 1024 * 1024;
const MAX_PDF_EMBEDDED_IMAGES = 4;

/** NoteShareLink 上参与「快照筛选」的列，buildShareLinkNoteFilter 的入参。 */
type NoteShareLinkFilter = {
  ownerID: string;
  status: NoteStatus | null;
  group: string | null;
  groupID: string | null;
  search: string | null;
  noteIDs: string[];
};

// 访客侧解析分享链接时返回的笔记数量上限。与 CreateNoteShareLinkDto.noteIds 的
// @ArrayMaxSize(200) 对齐；「无 noteIDs 快照」的链接（纯筛选条件）本身没有上界，
// 这里兜底避免一次解析拉出笔记主人的全部笔记。
const SHARE_LINK_MAX_NOTES = 200;

// mapSummary 用它来判定「访客不是笔记主人」：ownerID 是 UUID，永远不会等于空串，
// 因此 canEdit 恒为 false、collectedFrom 恒被抹掉。
const SHARE_LINK_GUEST_VIEWER = '';

// 列出分享链接的默认每页条数（对齐 listNotes）。链接行数没有上界（docs 第 3 节的
// 每用户上限还没做），不设 take 会一次性把该用户全部历史链接拉进内存。
// 每页上限 100 由 ListNoteShareLinksQueryDto 的 @Max 兜住。
const SHARE_LINK_LIST_DEFAULT_LIMIT = 50;
// #94：每用户活跃分享链接上限（未撤销且未过期的计数）。
const MAX_ACTIVE_SHARE_LINKS_PER_USER = 200;
const PDF_FONT_CANDIDATES = [
  '/Library/Fonts/Arial Unicode.ttf',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.otf',
  '/usr/share/fonts/opentype/source-han-sans/SourceHanSansCN-Regular.otf',
] as const;

function sanitizeFilenamePart(value: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, '-');
  return (normalized || 'note').slice(0, 80);
}

function mediaExtension(
  item: Pick<NoteMediaRow, 'objectKey' | 'url' | 'mimeType'>,
) {
  const fromMime = item.mimeType?.split('/')[1]?.split(';')[0];
  if (fromMime) return fromMime === 'jpeg' ? 'jpg' : fromMime;
  const source = (item.objectKey || item.url).split('?')[0].split('#')[0];
  const dotIndex = source.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === source.length - 1) return 'bin';
  return source.slice(dotIndex + 1).toLowerCase();
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Array<{ name: string; data: Buffer }>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) |
    (now.getMinutes() << 5) |
    Math.floor(now.getSeconds() / 2);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }

  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class NoteService {
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() private readonly uploadService?: UploadService,
  ) {
    this.minioPublicUrl = this.config.get<string>('MINIO_PUBLIC_URL') ?? null;
  }

  private async requireOwnedGroups(ownerID: string, groupIds: string[]) {
    if (groupIds.length === 0) return [];

    const groups = await this.prisma.noteGroup.findMany({
      where: {
        id: { in: groupIds },
        ownerID,
        deletedAt: null,
      },
      select: {
        id: true,
      },
    });

    if (groups.length !== groupIds.length) {
      throw new NotFoundException({
        message: 'Note group not found',
        errorCode: NoteErrorCode.GroupNotFound,
      });
    }

    return groups;
  }

  private async requireOwnedGroup(ownerID: string, groupId: string) {
    const group = await this.prisma.noteGroup.findFirst({
      where: {
        id: groupId,
        ownerID,
        deletedAt: null,
      },
    });

    if (!group) {
      throw new NotFoundException({
        message: 'Note group not found',
        errorCode: NoteErrorCode.GroupNotFound,
      });
    }

    return group;
  }

  private async requireOwnedNote(ownerID: string, noteId: string) {
    const note = await this.prisma.note.findFirst({
      where: {
        id: noteId,
        ownerID,
        status: { not: 'DELETED' },
      },
      include: NOTE_INCLUDE,
    });

    if (!note) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }

    return note;
  }

  private createShareToken(): string {
    return randomBytes(18).toString('base64url');
  }

  private getExportSectionMedia(sections: NoteSections) {
    const seen = new Set<string>();
    return [...sections.media.items, ...sections.showcase.items].filter(
      (item: any) => {
        const key =
          typeof item.objectKey === 'string'
            ? `${item.objectKey}:${item.url ?? ''}`
            : `url:${item.url ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    );
  }

  /**
   * 长图导出是**纯文字** SVG：不嵌图片字节，`图片 N: <url>` 里的 URL 是对媒体的
   * 唯一引用。桶策略把 notes/* 收归私有后，原始直链对收件人是 403，所以这里必须
   * 和其它读取路径一样发短时签名 URL（presignedUrls）。
   *
   * 已知限制：签名 URL ~2h 过期，而导出件是用户长期留存的。链接终会失效 ——
   * 但「导出后即刻可用」好过「一出生就是死链」。彻底解法是把媒体打包进导出件，
   * 属于更大的改动，不在本次范围。
   */
  private createLongImageSvg(
    note: NoteRow,
    presignedUrls?: Map<string, string>,
  ) {
    const sections = this.buildSectionsFromRow(note, presignedUrls);
    const exportMedia = this.getExportSectionMedia(sections);
    const lines = [
      note.title,
      '',
      sections.text.content ?? '',
      '',
      ...exportMedia.map((item: any, index) => {
        const type = item.type === 'VIDEO' ? '视频' : '图片';
        return `${type} ${index + 1}: ${item.url ?? ''}`;
      }),
      ...(sections.location
        ? [
            '',
            `位置: ${sections.location.title ?? ''}`,
            sections.location.address ?? '',
          ]
        : []),
    ].filter((line) => line != null);
    const height = Math.max(320, 120 + lines.length * 34);
    const text = lines
      .map(
        (line, index) =>
          `<text x="40" y="${60 + index * 34}" font-size="${index === 0 ? 28 : 18}" fill="#111827">${escapeXml(String(line))}</text>`,
      )
      .join('');
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}"><rect width="900" height="${height}" fill="#ffffff"/>${text}</svg>`,
    );
  }

  private resolvePdfFontPath() {
    const configured = this.config.get<string>('NOTE_EXPORT_PDF_FONT_PATH');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (configured && existsSync(configured)) {
      return configured;
    }
    return (
      PDF_FONT_CANDIDATES.find((fontPath) => {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        return existsSync(fontPath);
      }) ?? null
    );
  }

  /** PDF 只嵌前 MAX_PDF_EMBEDDED_IMAGES 张图的字节，之后的媒体同样只剩 URL 可引用。 */
  private async createPdf(note: NoteRow, presignedUrls?: Map<string, string>) {
    const sections = this.buildSectionsFromRow(note, presignedUrls);
    const sectionMedia = this.getExportSectionMedia(sections);
    const mediaUrls = sectionMedia
      .map((item: any) => (typeof item.url === 'string' ? item.url : null))
      .filter((url): url is string => Boolean(url))
      // Keywords 是 PDF 元数据，不是给人点的链接。剥掉签名 query：短时凭据写进
      // 长期留存文件的元数据既没用（会过期）又平白多一处泄漏面。
      .map((url) => url.split('?')[0]);
    const doc = new PDFDocument({
      size: 'A4',
      margin: 48,
      autoFirstPage: true,
      info: {
        Title: note.title,
        Creator: 'Circle IM',
        Producer: 'Circle IM',
        Keywords: mediaUrls.join(' '),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    const fontPath = this.resolvePdfFontPath();
    if (fontPath) {
      try {
        doc.registerFont('noteFont', fontPath);
        doc.font('noteFont');
      } catch {
        doc.font('Helvetica');
      }
    }

    doc.fontSize(22).text(note.title || 'Untitled note', {
      width: 500,
      align: 'left',
    });
    doc.moveDown();
    if (sections.text.content?.trim()) {
      doc.fontSize(11).text(sections.text.content.trim(), {
        width: 500,
        lineGap: 4,
      });
      doc.moveDown();
    }

    const noteMediaByKey = new Map(
      (note.media ?? []).map((item) => [`${item.objectKey}:${item.url}`, item]),
    );
    let embeddedImages = 0;
    for (const [index, rawItem] of sectionMedia.entries()) {
      const item = rawItem as any;
      const type = item.type === 'VIDEO' ? 'Video' : 'Image';
      doc.fontSize(12).text(`${type} ${index + 1}`, { continued: false });
      doc
        .fontSize(9)
        .fillColor('#4b5563')
        .text(String(item.url ?? ''));
      doc.fillColor('#000000');
      const mediaRow =
        noteMediaByKey.get(`${item.objectKey}:${item.url}`) ??
        (note.media ?? []).find((media) => media.objectKey === item.objectKey);

      if (
        item.type === 'IMAGE' &&
        item.objectKey &&
        this.uploadService &&
        embeddedImages < MAX_PDF_EMBEDDED_IMAGES &&
        (mediaRow?.size ?? 0) <= MAX_EXPORT_SINGLE_MEDIA_BYTES
      ) {
        try {
          const image = await this.uploadService.downloadObjectBuffer(
            item.objectKey,
            MAX_EXPORT_SINGLE_MEDIA_BYTES,
          );
          if (image.byteLength > MAX_EXPORT_SINGLE_MEDIA_BYTES) {
            throw new BadRequestException({
              message: 'Image file is too large to embed',
              errorCode: NoteErrorCode.ImageTooLarge,
            });
          }
          doc.moveDown(0.5);
          doc.image(image, {
            fit: [480, 260],
            align: 'center',
          });
          embeddedImages += 1;
          if (mediaRow?.width || mediaRow?.height) {
            doc
              .fontSize(8)
              .fillColor('#6b7280')
              .text(
                [mediaRow.width, mediaRow.height].filter(Boolean).join(' x '),
              );
            doc.fillColor('#000000');
          }
        } catch {
          doc
            .fontSize(9)
            .fillColor('#6b7280')
            .text('Image could not be embedded; use the URL above.');
          doc.fillColor('#000000');
        }
      } else if (item.type === 'IMAGE') {
        doc
          .fontSize(9)
          .fillColor('#6b7280')
          .text(
            'Preview omitted to keep PDF export stable; use the URL above.',
          );
        doc.fillColor('#000000');
      }
      doc.moveDown();
    }

    if (sections.location) {
      doc.fontSize(14).text('Location');
      if (sections.location.title)
        doc.fontSize(11).text(sections.location.title);
      if (sections.location.address)
        doc.fontSize(10).text(sections.location.address);
      if (
        typeof sections.location.latitude === 'number' &&
        typeof sections.location.longitude === 'number'
      ) {
        doc
          .fontSize(9)
          .text(
            `${sections.location.latitude}, ${sections.location.longitude}`,
          );
      }
    }

    doc.end();
    return finished;
  }

  private async uploadExportArtifact(input: {
    ownerID: string;
    noteID: string;
    filename: string;
    mimeType: string;
    body: Buffer;
  }): Promise<NoteExportResultDto> {
    if (!this.uploadService) {
      throw new ServiceUnavailableException('File export is not configured');
    }
    const key = `note-exports/${input.ownerID}/${input.noteID}/${randomUUID()}-${input.filename}`;
    const uploaded = await this.uploadService.uploadBuffer({
      key,
      body: input.body,
      contentType: input.mimeType,
      expiresInSeconds: NOTE_EXPORT_TTL_SECONDS,
    });
    const download = await this.uploadService.createPresignedGetUrl(
      key,
      NOTE_EXPORT_TTL_SECONDS,
    );
    return {
      url: download.url,
      filename: input.filename,
      mimeType: input.mimeType,
      size: uploaded.size,
      expiresAt: download.expiresAt,
    };
  }

  private buildShareUrl(token: string): string {
    const base =
      this.config.get<string>('NOTE_SHARE_WEB_BASE') ??
      this.config.get<string>('TEMP_CHAT_WEB_BASE') ??
      '';
    let trimmedBase = base;
    while (trimmedBase.endsWith('/')) {
      trimmedBase = trimmedBase.slice(0, -1);
    }
    return `${trimmedBase}/s/${token}`;
  }

  private assertMediaOwnership(
    ownerID: string,
    media: CreateNoteDto['media'],
    // 收藏复制来的笔记会携带原作者的 objectKey；编辑时允许"保留笔记上已有的
    // 媒体"，只有新增的 key 必须归属当前用户，防止客户端引用他人上传。
    grandfatheredKeys?: ReadonlySet<string>,
  ) {
    // Presign now generates keys as `notes/{userId}/{uuid}.ext`.
    // Verify both the folder prefix and the user segment so a client cannot
    // reference another user's uploaded media.
    const prefix = `notes/${ownerID}/`;
    const invalid = media.find(
      (item) =>
        !item.objectKey.startsWith(prefix) &&
        !grandfatheredKeys?.has(item.objectKey),
    );
    if (invalid) {
      throw new BadRequestException(
        `objectKey must start with notes/${ownerID}/`,
      );
    }

    // posterUrl 没有独立的 objectKey 列，读取时要从 URL 反推 key 去签名
    // （collectNoteMediaTargets）。若这里只校验同源而不校验属主，客户端就能在
    // 自己的笔记上把 posterUrl 指向别人的对象，读取时换回一个有效签名 URL ——
    // 绕开 presign-on-read 想建立的「私有媒体不可访问」。
    const invalidPoster = media.find((item) =>
      this.isForeignPosterKey(item.objectKey, item.posterUrl),
    );
    if (invalidPoster) {
      throw new BadRequestException(
        'posterUrl must reference the same owner as its objectKey',
      );
    }
  }

  /** `notes/{uid}/{file}` → `notes/{uid}/`；形状不符返回 null（不放行）。 */
  private noteMediaOwnerPrefix(objectKey: unknown): string | null {
    if (typeof objectKey !== 'string') return null;
    const [root, uid] = objectKey.split('/');
    return root === 'notes' && uid ? `notes/${uid}/` : null;
  }

  /**
   * posterUrl 反推出的 key 是否落在该媒体自己 objectKey 的属主目录之外。
   *
   * 判据刻意是「与同一条媒体的 objectKey 同属主」而不是「等于笔记主人」：收藏
   * 复制不搬运对象（collectNote 直接沿用原作者的 objectKey），按笔记主人一刀切
   * 会把所有收藏笔记的封面弄挂。视频封面本就该躺在视频旁边。
   *
   * 反推不出 key（非本站 URL）时返回 false —— 那种情况由 assertMediaUrlsAreSafe
   * 的同源检查负责，不归这里管。
   */
  private isForeignPosterKey(objectKey: unknown, posterUrl: unknown): boolean {
    const posterKey = this.uploadService?.objectKeyFromPublicUrl(
      typeof posterUrl === 'string' ? posterUrl : null,
    );
    if (!posterKey) return false;
    const prefix = this.noteMediaOwnerPrefix(objectKey);
    return !prefix || !posterKey.startsWith(prefix);
  }

  /**
   * Rejects media whose `url` / `posterUrl` is not served from this
   * application's own storage. `objectKey` is already ownership-checked, but
   * `url` is the field that actually gets rendered (and surfaced to other
   * users via circle-plaza), so it must be pinned to MINIO_PUBLIC_URL.
   *
   * Requiring the prefix to be followed by `/` closes the
   * `https://host.attacker.com` bypass that a bare `startsWith` would allow.
   * Skipped entirely when MinIO is not configured (upload disabled anyway).
   */
  private assertMediaUrlsAreSafe(media: CreateNoteDto['media']) {
    const urls: Array<string | null | undefined> = [];
    for (const item of media) {
      urls.push(item.url, item.posterUrl);
    }
    assertUrlsFromStorage(urls, this.minioPublicUrl, 'media url');
  }

  private buildMediaStats(media: CreateNoteDto['media']) {
    const imageCount = media.filter((item) => item.type === 'IMAGE').length;
    const videoCount = media.filter((item) => item.type === 'VIDEO').length;

    return {
      imageCount,
      videoCount,
      mediaCount: media.length,
    };
  }

  private dedupeMedia(media: CreateNoteDto['media']) {
    const seen = new Set<string>();
    const deduped: CreateNoteDto['media'] = [];
    for (const item of media) {
      const key = `${item.objectKey}:${item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
    deduped.sort(
      (left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0),
    );
    return deduped.map((item, index) => ({
      ...item,
      sortOrder: index,
    }));
  }

  private normalizeLocation(
    location: NoteSectionsDto['location'] | null | undefined,
  ): NoteLocationSection | null {
    if (!location) return null;
    const normalized: NoteLocationSection = {};
    if (location.title?.trim()) normalized.title = location.title.trim();
    if (location.address?.trim()) normalized.address = location.address.trim();
    if (typeof location.latitude === 'number')
      normalized.latitude = location.latitude;
    if (typeof location.longitude === 'number')
      normalized.longitude = location.longitude;
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  private mapMediaItemForSection(
    item: Record<string, any>,
    presignedUrls?: Map<string, string>,
  ) {
    // 读路径传 presignedUrls → url/posterUrl 换成短时签名 URL。写路径（resolveSectionMediaItems）
    // 不传 → 存持久 base url。两处都 stripQuery：写路径把客户端 edit 回传的签名 query 去掉只存
    // base；读路径 presign 未命中时也回落到 base（不把过期签名当持久值）。
    const stripQuery = (value: unknown) =>
      typeof value === 'string' ? value.split('?')[0] : value;
    const url =
      presignedUrls && typeof item.url === 'string'
        ? (presignedUrls.get(item.url) ?? stripQuery(item.url))
        : stripQuery(item.url);
    const posterUrl =
      presignedUrls && typeof item.posterUrl === 'string'
        ? (presignedUrls.get(item.posterUrl) ?? stripQuery(item.posterUrl))
        : stripQuery(item.posterUrl);
    return {
      ...(item.id ? { id: item.id } : {}),
      type: item.type,
      objectKey: item.objectKey,
      url,
      ...(item.mimeType != null ? { mimeType: item.mimeType } : {}),
      ...(item.size != null ? { size: item.size } : {}),
      ...(item.width != null ? { width: item.width } : {}),
      ...(item.height != null ? { height: item.height } : {}),
      ...(item.durationMs != null ? { durationMs: item.durationMs } : {}),
      ...(item.posterUrl != null ? { posterUrl } : {}),
      sortOrder: item.sortOrder ?? 0,
    };
  }

  private resolveSectionMediaItems(
    sectionName: 'media' | 'showcase',
    requestedItems: CreateNoteDto['media'] | undefined,
    fallbackItems: CreateNoteDto['media'],
    validatedMedia: CreateNoteDto['media'],
  ) {
    const canonicalByComposite = new Map<string, Record<string, any>>();
    const canonicalByObjectKey = new Map<string, Record<string, any>>();
    const canonicalByUrl = new Map<string, Record<string, any>>();

    for (const item of validatedMedia) {
      const canonical = this.mapMediaItemForSection(
        item as Record<string, any>,
      );
      canonicalByComposite.set(`${item.objectKey}:${item.url}`, canonical);
      canonicalByObjectKey.set(item.objectKey, canonical);
      canonicalByUrl.set(item.url, canonical);
    }

    const source = Array.isArray(requestedItems)
      ? requestedItems
      : fallbackItems;
    return source.map((item) => {
      const resolved =
        canonicalByComposite.get(`${item.objectKey}:${item.url}`) ??
        canonicalByObjectKey.get(item.objectKey) ??
        canonicalByUrl.get(item.url);
      if (!resolved) {
        throw new BadRequestException(
          `${sectionName} section media must reference note media`,
        );
      }
      return resolved;
    });
  }

  private hasSectionMediaItems(items: unknown) {
    return Array.isArray(items);
  }

  private buildSectionsFromInput(
    input: CreateNoteDto | UpdateNoteDto,
    derived: {
      content: string | null;
      contentJson: NoteContentBlock[] | null;
      media: CreateNoteDto['media'];
    },
  ): NoteSections {
    const sectionInput = input.sections;
    const hasExplicitMedia = this.hasSectionMediaItems(
      sectionInput?.media?.items,
    );
    const hasExplicitShowcase = this.hasSectionMediaItems(
      sectionInput?.showcase?.items,
    );
    const mediaItems = this.resolveSectionMediaItems(
      'media',
      sectionInput?.media?.items,
      hasExplicitShowcase ? [] : derived.media,
      derived.media,
    );
    const showcaseItems = this.resolveSectionMediaItems(
      'showcase',
      sectionInput?.showcase?.items,
      hasExplicitMedia
        ? []
        : derived.media.filter((item) => item.type === 'IMAGE'),
      derived.media,
    );

    return {
      text: {
        content: derived.content,
        contentJson: derived.contentJson,
      },
      media: {
        items: mediaItems,
      },
      showcase: {
        items: showcaseItems,
      },
      location: this.normalizeLocation(sectionInput?.location),
    };
  }

  private buildPreview(content: string | null | undefined) {
    if (!content) return null;
    return content.length > 120 ? `${content.slice(0, 120)}...` : content;
  }

  private extractBlockText(
    blocks: NoteContentBlock[] | undefined,
    depth = 0,
  ): string[] {
    if (!blocks?.length || depth > 10) return [];

    const fragments: string[] = [];

    for (const block of blocks) {
      if (!this.isRecord(block)) continue;
      // Table blocks have a BNTableContent object, not an array — skip for text
      const inlines = Array.isArray(block.content) ? block.content : [];

      for (const node of inlines) {
        if (!this.isRecord(node)) continue;
        if (node.type === 'text') {
          // BNStyledText: { type: 'text', text: string, styles: {...} }
          const trimmed = typeof node.text === 'string' ? node.text.trim() : '';
          if (trimmed) fragments.push(trimmed);
        } else if (node.type === 'link') {
          // BNLink: { type: 'link', href: string, content: BNStyledText[] }
          // Extract the visible text from the link's inner StyledText nodes
          const linkContent = Array.isArray(node.content) ? node.content : [];
          for (const inner of linkContent) {
            if (!this.isRecord(inner)) continue;
            const trimmed =
              typeof inner.text === 'string' ? inner.text.trim() : '';
            if (trimmed) fragments.push(trimmed);
          }
        }
      }

      if (Array.isArray(block.children) && block.children.length > 0) {
        fragments.push(...this.extractBlockText(block.children, depth + 1));
      }
    }

    return fragments;
  }

  private deriveMediaFromBlocks(blocks: NoteContentBlock[] | undefined) {
    if (!blocks?.length) return [];

    const media: CreateNoteDto['media'] = [];
    let sortOrder = 0;

    const visit = (items: NoteContentBlock[], depth: number) => {
      if (depth > 10) return;
      for (const block of items) {
        if (!this.isRecord(block)) continue;
        if (block.type === 'image' || block.type === 'video') {
          const props = block.props ?? {};
          const url = typeof props.url === 'string' ? props.url : '';
          const objectKey =
            typeof props.objectKey === 'string' ? props.objectKey : '';

          if (url && objectKey) {
            media.push({
              type: block.type === 'video' ? 'VIDEO' : 'IMAGE',
              objectKey,
              url,
              mimeType:
                typeof props.mimeType === 'string' ? props.mimeType : undefined,
              size: typeof props.size === 'number' ? props.size : undefined,
              width: typeof props.width === 'number' ? props.width : undefined,
              height:
                typeof props.height === 'number' ? props.height : undefined,
              durationMs:
                typeof props.durationMs === 'number'
                  ? props.durationMs
                  : undefined,
              posterUrl:
                typeof props.posterUrl === 'string'
                  ? props.posterUrl
                  : undefined,
              sortOrder,
            });
            sortOrder += 1;
          }
        }

        if (Array.isArray(block.children) && block.children.length > 0) {
          visit(block.children, depth + 1);
        }
      }
    };

    visit(blocks, 0);

    return media;
  }

  private deriveNoteContent(input: CreateNoteDto | UpdateNoteDto) {
    const sectionText = input.sections?.text;
    const textContentJson = sectionText?.contentJson ?? input.contentJson;
    const blocks = Array.isArray(textContentJson) ? textContentJson : [];
    const extractedText =
      blocks.length > 0 ? this.extractBlockText(blocks) : [];
    const sectionMedia = input.sections?.media?.items ?? [];
    const sectionShowcase = input.sections?.showcase?.items ?? [];
    const sectionMediaCombined = this.dedupeMedia([
      ...sectionMedia,
      ...sectionShowcase,
    ]);

    // Prefer explicitly provided media — the client sends full metadata including
    // objectKey. Only fall back to block-derived media when input.media is empty
    // (for future server-side use or migration).
    let derivedMedia = input.media ?? [];
    if (derivedMedia.length === 0) {
      derivedMedia =
        sectionMediaCombined.length > 0
          ? sectionMediaCombined
          : this.deriveMediaFromBlocks(blocks);
    }

    // 客户端 edit 时会回传读到的签名 url；写入前 strip 掉 query，只存持久 base url
    //（读取时才现签短时 URL）。base url 本无 query，strip 无副作用。
    derivedMedia = derivedMedia.map((item) => ({
      ...item,
      url: typeof item.url === 'string' ? item.url.split('?')[0] : item.url,
      ...(typeof (item as { posterUrl?: unknown }).posterUrl === 'string'
        ? {
            posterUrl: (item as { posterUrl: string }).posterUrl.split('?')[0],
          }
        : {}),
    }));

    const derivedContent =
      blocks.length > 0
        ? extractedText.join(' ').trim() ||
          (sectionText?.content ?? input.content ?? '').trim()
        : (sectionText?.content ?? input.content ?? '').trim();
    const derivedTitle =
      blocks.length > 0
        ? (extractedText[0] ?? input.title).trim()
        : input.title.trim();
    const normalized = {
      contentJson: blocks.length > 0 ? blocks : null,
      title: derivedTitle.slice(0, MAX_NOTE_TITLE_LENGTH),
      content: derivedContent
        ? derivedContent.slice(0, MAX_NOTE_CONTENT_LENGTH)
        : null,
      media: derivedMedia,
    };

    return {
      ...normalized,
      sections: this.buildSectionsFromInput(input, normalized),
    };
  }

  private isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  private buildSectionsFromRow(
    note: NoteRow,
    presignedUrls?: Map<string, string>,
  ): NoteSections {
    const stored = this.isRecord(note.sections) ? note.sections : {};
    const storedText = this.isRecord(stored.text) ? stored.text : {};
    const storedMedia = this.isRecord(stored.media) ? stored.media : {};
    const storedShowcase = this.isRecord(stored.showcase)
      ? stored.showcase
      : {};
    const storedLocation = this.isRecord(stored.location)
      ? stored.location
      : null;
    const hasExplicitMedia = Array.isArray(storedMedia.items);
    const hasExplicitShowcase = Array.isArray(storedShowcase.items);
    const mediaItems = hasExplicitMedia
      ? // 坑：已存的 sections JSON items 是原样返回的，其冻结 url 也必须重签。
        this.applyPresignedToItems(storedMedia.items, presignedUrls)
      : hasExplicitShowcase
        ? []
        : (note.media ?? []).map((item) =>
            this.mapMediaItemForSection(item as any, presignedUrls),
          );
    const showcaseItems = hasExplicitShowcase
      ? this.applyPresignedToItems(storedShowcase.items, presignedUrls)
      : hasExplicitMedia
        ? []
        : (note.media ?? [])
            .filter((item) => item.type === 'IMAGE')
            .map((item) =>
              this.mapMediaItemForSection(item as any, presignedUrls),
            );
    let contentJson: unknown[] | null = null;
    if (Array.isArray(storedText.contentJson)) {
      contentJson = storedText.contentJson;
    } else if (Array.isArray(note.contentJson)) {
      contentJson = note.contentJson;
    }
    const content =
      typeof storedText.content === 'string'
        ? storedText.content
        : (note.content ?? null);

    return {
      text: {
        content,
        contentJson,
      },
      media: {
        items: mediaItems,
      },
      showcase: {
        items: showcaseItems,
      },
      location: storedLocation
        ? {
            ...(typeof storedLocation.title === 'string'
              ? { title: storedLocation.title }
              : {}),
            ...(typeof storedLocation.address === 'string'
              ? { address: storedLocation.address }
              : {}),
            ...(typeof storedLocation.latitude === 'number'
              ? { latitude: storedLocation.latitude }
              : {}),
            ...(typeof storedLocation.longitude === 'number'
              ? { longitude: storedLocation.longitude }
              : {}),
          }
        : null,
    };
  }

  private getSectionAvailability(sections: NoteSections) {
    return {
      hasText:
        Boolean(sections.text.content?.trim()) ||
        Boolean(sections.text.contentJson?.length),
      showcaseCount: sections.showcase.items.length,
      hasLocation: Boolean(sections.location),
    };
  }

  private assertExportMediaWithinLimits(media: NoteMediaRow[]) {
    if (media.length > MAX_EXPORT_MEDIA_ITEMS) {
      throw new BadRequestException({
        message: `Cannot export more than ${MAX_EXPORT_MEDIA_ITEMS} media files at once`,
        errorCode: NoteErrorCode.ExportTooManyMedia,
      });
    }
    let totalSize = 0;
    for (const item of media) {
      const size = item.size ?? 0;
      if (size > MAX_EXPORT_SINGLE_MEDIA_BYTES) {
        throw new BadRequestException({
          message: 'Media file is too large to export',
          errorCode: NoteErrorCode.ExportMediaTooLarge,
        });
      }
      totalSize += size;
    }
    if (totalSize > MAX_EXPORT_TOTAL_MEDIA_BYTES) {
      throw new BadRequestException({
        message: 'Selected media are too large to export',
        errorCode: NoteErrorCode.ExportTotalTooLarge,
      });
    }
  }

  private mapSummary(
    note: NoteRow,
    viewerID: string,
    presignedUrls?: Map<string, string>,
  ): NoteSummaryDto {
    const groups = (note.groupMemberships ?? []).map((membership: any) => ({
      id: membership.group.id,
      name: membership.group.name,
    }));
    const fallbackCoverMedia = note.media?.[0] ?? null;
    const coverMedia = note.coverMedia ?? fallbackCoverMedia;
    const sections = this.buildSectionsFromRow(note, presignedUrls);
    const availability = this.getSectionAvailability(sections);

    return {
      id: note.id,
      ownerId: note.ownerID,
      canEdit: note.ownerID === viewerID,
      title: note.title,
      contentPreview: this.buildPreview(note.content),
      status: note.status,
      available: note.available,
      pinned: note.pinned,
      groups,
      cover: coverMedia
        ? {
            id: coverMedia.id,
            type: coverMedia.type,
            url:
              (presignedUrls && typeof coverMedia.url === 'string'
                ? presignedUrls.get(coverMedia.url)
                : undefined) ?? coverMedia.url,
          }
        : null,
      imageCount: note.imageCount,
      videoCount: note.videoCount,
      mediaCount: note.mediaCount,
      ...availability,
      // 来源名片是收藏者的私人定位标记：available=true 的笔记任何人都能打开，
      // 但「从哪个群/谁那里收藏的」不能跟着泄漏 —— 只回给笔记主人本人。
      collectedFrom:
        note.ownerID === viewerID && this.isRecord(note.collectedFrom)
          ? note.collectedFrom
          : null,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  }

  private mapDetail(
    note: NoteRow,
    viewerID: string,
    presignedUrls?: Map<string, string>,
  ): NoteDetailDto {
    const sections = this.buildSectionsFromRow(note, presignedUrls);
    return {
      ...this.mapSummary(note, viewerID, presignedUrls),
      content: note.content ?? null,
      contentJson: Array.isArray(note.contentJson) ? note.contentJson : null,
      media: (note.media ?? []).map((item) => ({
        id: item.id,
        type: item.type,
        objectKey: item.objectKey,
        url:
          (presignedUrls && typeof item.url === 'string'
            ? presignedUrls.get(item.url)
            : undefined) ?? item.url,
        mimeType: item.mimeType ?? null,
        size: item.size ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        durationMs: item.durationMs ?? null,
        posterUrl:
          presignedUrls && typeof item.posterUrl === 'string'
            ? (presignedUrls.get(item.posterUrl) ?? item.posterUrl)
            : (item.posterUrl ?? null),
        sortOrder: item.sortOrder,
      })),
      sections,
    };
  }

  // ── presign-on-read（私有笔记媒体不再匿名公开，读取时现签短时 URL）─────────

  // 从一个 note row 收集所有需现签的 (base url, object key)：media 行的 url/objectKey +
  // poster(从 url 反推 key) + sections JSON verbatim items 里冻结的 url/objectKey。
  private collectNoteMediaTargets(
    note: NoteRow,
  ): { url: string; objectKey: string }[] {
    const out: { url: string; objectKey: string }[] = [];
    const add = (url: unknown, key: unknown) => {
      if (typeof url === 'string' && url && typeof key === 'string' && key) {
        out.push({ url, objectKey: key });
      }
    };
    /**
     * poster 的 key 是从客户端可控的 URL 反推来的，签名前必须确认它没跨出该媒体
     * objectKey 的属主目录。写入侧已经拦了（assertMediaOwnership），这里是纵深
     * 防御，也用于挡住修复前就已落库的脏数据。
     */
    const addPoster = (posterUrl: unknown, objectKey: unknown) => {
      if (typeof posterUrl !== 'string') return;
      if (this.isForeignPosterKey(objectKey, posterUrl)) return;
      add(posterUrl, this.uploadService?.objectKeyFromPublicUrl(posterUrl));
    };
    for (const m of note.media ?? []) {
      add(m.url, m.objectKey);
      addPoster(m.posterUrl, m.objectKey);
    }
    const stored = this.isRecord(note.sections) ? note.sections : {};
    for (const section of ['media', 'showcase'] as const) {
      const s = this.isRecord(stored[section]) ? stored[section] : {};
      if (Array.isArray(s.items)) {
        for (const item of s.items) {
          if (!this.isRecord(item)) continue;
          add(item.url, item.objectKey);
          addPoster(item.posterUrl, item.objectKey);
        }
      }
    }
    return out;
  }

  // 给一批 (base url, object key) 现签短时 URL → Map<base url, signed url>。signingDate 舍入
  // 到窗口 → 同窗口签出字节相同 URL（缓存稳定）。uploadService 未注入/单个失败 → 略过，由
  // map 函数 fallback 回 base url（MinIO 未配置时不崩）。
  private async presignNoteMedia(
    targets: { url: string; objectKey: string }[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.uploadService || !targets.length) return map;
    // 同 base url 去重（同图可能出现在 media 行 + sections JSON 两处）。
    const byUrl = new Map<string, string>();
    for (const t of targets) byUrl.set(t.url, t.objectKey);
    const signingDate = new Date(
      Math.floor(Date.now() / NOTE_MEDIA_URL_WINDOW_MS) *
        NOTE_MEDIA_URL_WINDOW_MS,
    );
    await Promise.all(
      [...byUrl.entries()].map(async ([url, key]) => {
        try {
          const signed = await this.uploadService!.createPresignedGetUrl(
            key,
            NOTE_MEDIA_URL_TTL_SECONDS,
            signingDate,
          );
          map.set(url, signed.url);
        } catch {
          /* MinIO 未配置 / 单个失败 → 略过，fallback base url */
        }
      }),
    );
    return map;
  }

  // 对已存的 sections JSON items（url 是写时冻结的 base url）就地换成签名 URL。
  private applyPresignedToItems(
    items: unknown,
    presignedUrls?: Map<string, string>,
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(items)) return [];
    const rows = items as Array<Record<string, unknown>>;
    if (!presignedUrls) return rows;
    return rows.map((item) => {
      if (!this.isRecord(item)) return item;
      const next: Record<string, unknown> = { ...item };
      if (typeof item.url === 'string') {
        next.url = presignedUrls.get(item.url) ?? item.url;
      }
      if (typeof item.posterUrl === 'string') {
        next.posterUrl = presignedUrls.get(item.posterUrl) ?? item.posterUrl;
      }
      return next;
    });
  }

  // 读取入口用这三个 wrapper：先批量 presign，再同步 map（写路径不经过这里，存 base url）。
  private async mapDetailResolved(
    note: NoteRow,
    viewerID: string,
  ): Promise<NoteDetailDto> {
    const presigned = await this.presignNoteMedia(
      this.collectNoteMediaTargets(note),
    );
    return this.mapDetail(note, viewerID, presigned);
  }

  private async mapSummaryListResolved(
    notes: NoteRow[],
    viewerID: string,
  ): Promise<NoteSummaryDto[]> {
    const presigned = await this.presignNoteMedia(
      notes.flatMap((note) => this.collectNoteMediaTargets(note)),
    );
    return notes.map((note) => this.mapSummary(note, viewerID, presigned));
  }

  private mapGroup(group: NoteGroupRow): NoteGroupDto {
    return {
      id: group.id,
      name: group.name,
      sortOrder: group.sortOrder,
      noteCount: group._count.memberships,
    };
  }

  async createNote(
    ownerID: string,
    input: CreateNoteDto,
  ): Promise<NoteDetailDto> {
    const uniqueGroupIds = [...new Set(input.groupIds ?? [])];
    await this.requireOwnedGroups(ownerID, uniqueGroupIds);

    const derived = this.deriveNoteContent(input);
    this.assertMediaOwnership(ownerID, derived.media);
    this.assertMediaUrlsAreSafe(derived.media);

    const media = derived.media
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((item) => ({
        id: randomUUID(),
        ...item,
      }));

    // Cover is the first image. Videos don't get thumbnails, so a video-only
    // note simply has no cover rather than an unrenderable (mp4) one.
    const coverMediaID =
      media.find((item) => item.type === 'IMAGE')?.id ?? null;
    const counts = this.buildMediaStats(media);

    const created = await this.prisma.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          ownerID,
          title: derived.title,
          content: derived.content,
          contentJson: toPrismaJson(derived.contentJson),
          sections: toPrismaJson(derived.sections),
          groupID: null,
          status: input.status ?? 'ACTIVE',
          available: true,
          pinned: input.pinned ?? false,
          ...counts,
        },
      });

      if (media.length > 0) {
        await tx.noteMedia.createMany({
          data: media.map((item) => ({
            id: item.id,
            noteID: note.id,
            type: item.type,
            objectKey: item.objectKey,
            url: item.url,
            mimeType: item.mimeType ?? null,
            size: item.size ?? null,
            width: item.width ?? null,
            height: item.height ?? null,
            durationMs: item.durationMs ?? null,
            posterUrl: item.posterUrl ?? null,
            sortOrder: item.sortOrder,
          })),
        });
      }

      if (uniqueGroupIds.length > 0) {
        await tx.noteGroupMembership.createMany({
          data: uniqueGroupIds.map((groupID) => ({
            noteID: note.id,
            groupID,
          })),
        });
      }

      return tx.note.update({
        where: { id: note.id },
        data: {
          coverMediaID,
        },
        include: NOTE_INCLUDE,
      });
    });

    return this.mapDetailResolved(created, ownerID);
  }

  async listNotes(
    ownerID: string,
    query: ListNotesQueryDto,
  ): Promise<NoteSummaryDto[]> {
    if (query.groupId) {
      await this.requireOwnedGroup(ownerID, query.groupId);
    }

    const notes = await this.prisma.note.findMany({
      where: {
        ownerID,
        status: query.status ?? { not: 'DELETED' },
        ...(query.groupId
          ? {
              groupMemberships: {
                some: {
                  groupID: query.groupId,
                  group: {
                    deletedAt: null,
                  },
                },
              },
            }
          : {}),
        ...(query.search?.trim()
          ? {
              OR: [
                {
                  title: {
                    contains: query.search.trim(),
                    mode: 'insensitive',
                  },
                },
                {
                  content: {
                    contains: query.search.trim(),
                    mode: 'insensitive',
                  },
                },
              ],
            }
          : {}),
      },
      include: NOTE_INCLUDE,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: query.limit ?? 50,
      skip: ((query.page ?? 1) - 1) * (query.limit ?? 50),
    });

    return this.mapSummaryListResolved(notes, ownerID);
  }

  async createShareLink(
    ownerID: string,
    dto: CreateNoteShareLinkDto,
  ): Promise<NoteShareLinkDto> {
    if (dto.group && dto.groupId) {
      throw new BadRequestException(
        'group and groupId cannot be used together',
      );
    }

    if (dto.groupId) {
      await this.requireOwnedGroup(ownerID, dto.groupId);
    }

    const noteIDs = Array.from(new Set(dto.noteIds ?? []));
    if (noteIDs.length > 0) {
      const notes = await this.prisma.note.findMany({
        where: {
          id: { in: noteIDs },
          ownerID,
          status: { not: 'DELETED' },
        },
        select: { id: true },
      });
      if (notes.length !== noteIDs.length) {
        throw new NotFoundException({
          message: 'Note not found',
          errorCode: NoteErrorCode.NotFound,
        });
      }
    }

    // 不再有 `|| '我的笔记'` 兜底：CreateNoteShareLinkDto 现在会 trim 并拒掉空白
    // 标题，空串到不了这里（docs 第 5 节）。硬编码中文兜底既绕不开 i18n
    // （它是内容不是报错，服务端也不知道调用方 locale），又会把「客户端传了个
    // 空标题」这个 bug 悄悄盖掉。trim/slice 保留为纵深防御。
    const title = dto.title.trim().slice(0, 120);
    const search = dto.search?.trim() || null;
    const expiresAt =
      dto.expiresInDays != null
        ? new Date(Date.now() + dto.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = this.createShareToken();
      try {
        // #94 配额（review 修复为原子）：count 与 create 同事务，并用 per-owner
        // advisory 锁串行化 —— 否则 199 条时并发双请求都读到 199、双双越过
        // 200 护栏。锁按 owner 分片，不同用户互不阻塞；xact 锁随事务自动释放。
        const quotaLockKey = `note-share-link:${ownerID}`;
        const row = await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${quotaLockKey}))`;
          const activeLinks = await tx.noteShareLink.count({
            where: {
              ownerID,
              revokedAt: null,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
          });
          if (activeLinks >= MAX_ACTIVE_SHARE_LINKS_PER_USER) {
            throw new BadRequestException({
              message: `分享链接数量已达上限（${MAX_ACTIVE_SHARE_LINKS_PER_USER}），请先撤销不再使用的链接`,
              errorCode: NoteErrorCode.ShareLinkLimit,
            });
          }
          return tx.noteShareLink.create({
            data: {
              ownerID,
              token,
              title,
              status: dto.status ?? null,
              group: dto.group ?? null,
              groupID: dto.groupId ?? null,
              search,
              noteIDs,
              expiresAt,
            },
          });
        });

        return this.mapShareLink(row);
      } catch (error) {
        if (prismaErrorCode(error) === 'P2002' && attempt < 2) continue;
        throw error;
      }
    }

    throw new ConflictException('Unable to create share link');
  }

  /**
   * 访客侧：把分享 token 解析成链接快照范围内的笔记列表。
   *
   * 规格见 docs/note-share-links-todo.md 第 1、4 节。这是分享功能缺失的「读」
   * 半边 —— 在此之前 NoteShareLink 只写不读，expiresAt / revokedAt 存了但从不
   * 校验，链接一旦发出就无法过期、也无法作废。
   *
   * 授权模型：链接本身即凭据（token 为 18 字节随机数，144 bit，不可枚举），
   * 因此端点不挂 JwtGuard —— 二维码扫描者没有 Circle 会话。
   */
  async resolveShareLink(token: string): Promise<SharedNoteListDto> {
    const link = await this.prisma.noteShareLink.findUnique({
      where: { token },
    });

    // 不存在 / 已吊销 / 已过期 → 同一个 404，且都在查笔记之前短路。
    if (
      !link ||
      link.revokedAt !== null ||
      (link.expiresAt !== null && link.expiresAt.getTime() <= Date.now())
    ) {
      throw this.shareLinkInvalid();
    }

    const notes = await this.prisma.note.findMany({
      where: this.buildShareLinkNoteFilter(link),
      include: NOTE_INCLUDE,
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: SHARE_LINK_MAX_NOTES,
    });

    return {
      title: link.title,
      notes: await this.mapSummaryListResolved(notes, SHARE_LINK_GUEST_VIEWER),
      expiresAt: link.expiresAt,
    };
  }

  /**
   * 链接不存在 / 已吊销 / 已过期共用同一个 404 响应体。三者必须逐字节一致，
   * 否则访客可以据此区分「链接从未存在」与「链接曾存在但已被吊销/过期」。
   */
  private shareLinkInvalid(): NotFoundException {
    return new NotFoundException({
      message: 'Share link not found',
      errorCode: NoteErrorCode.ShareLinkInvalid,
    });
  }

  /**
   * 按链接存下来的快照条件（noteIDs / status / group / groupID / search）过滤。
   *
   * 刻意 **不** 复用 getNote 的 `OR: [{ownerID}, {available:true}]` 放行逻辑
   * （docs 第 1 节）：那条 OR 会让链接范围之外的任意 available 笔记也被读出来。
   * 这里 available / status 是**过滤条件**而非放行条件 —— 链接创建后被删除或被
   * 取消 available 的笔记，解析时必须消失（docs 第 4 节）。
   */
  private buildShareLinkNoteFilter(link: NoteShareLinkFilter) {
    const search = link.search?.trim();
    return {
      ownerID: link.ownerID,
      // status 快照只可能是 ACTIVE / UNLISTED（NOTE_WRITABLE_STATUS），
      // 两者都已排除 DELETED；未设置时显式排除。
      status: link.status ?? { not: 'DELETED' as const },
      available: true,
      ...(link.noteIDs.length > 0 ? { id: { in: link.noteIDs } } : {}),
      // group 与 groupID 在 createShareLink 里互斥，两个分支不会同时命中。
      ...(link.groupID
        ? {
            groupMemberships: {
              some: { groupID: link.groupID, group: { deletedAt: null } },
            },
          }
        : {}),
      ...(link.group === 'ungrouped'
        ? { groupMemberships: { none: { group: { deletedAt: null } } } }
        : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' as const } },
              { content: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
  }

  /**
   * 链接主人侧：把自己的分享链接标记为已吊销（docs 第 2 节）。
   *
   * resolveShareLink 早就会拒绝 `revokedAt != null` 的链接，但在此之前没有任何
   * 代码写入 revokedAt —— enforcement 就位而 writer 缺失，链接一旦发出就作废不掉。
   *
   * 幂等：`revokedAt: null` 写在 where 里而不是先读后判，重复吊销匹配 0 行，
   * 原始吊销时间不会被后一次调用覆写（并发的两次吊销也是同样的收敛结果）。
   */
  async revokeShareLink(ownerID: string, linkId: string): Promise<void> {
    // ownerID 进 where = 越权吊销匹配 0 行。条件更新一步到位，不存在
    // 「读到自己的链接 → 期间被改 → 写回」的 TOCTOU 窗口。
    const { count } = await this.prisma.noteShareLink.updateMany({
      where: { id: linkId, ownerID, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0) return;

    // count === 0 有两种可能，必须区分：已经吊销过（幂等成功）vs 不存在 / 不是
    // 你的（404）。兜底查询同样带 ownerID，所以「别人的链接」与「不存在」返回
    // 完全一致的 404，不泄漏 id 是否存在。
    const existing = await this.prisma.noteShareLink.findFirst({
      where: { id: linkId, ownerID },
      select: { id: true },
    });
    if (!existing) throw this.shareLinkInvalid();
  }

  /**
   * 链接主人侧：列出自己创建的分享链接（配合吊销接口 —— 没有列表就拿不到 id）。
   *
   * 已吊销 / 已过期的链接也会返回：revokedAt 与 expiresAt 都在 DTO 上，由客户端
   * 决定怎么展示；服务端先过滤掉会让这两个字段在响应里恒为 null。
   *
   * 分页使用最后一条链接 id 作为 cursor，并按 createdAt/id 稳定排序。吊销只能
   * 靠本接口拿 id，所以每一页必须能稳定抵达较老的有效链接。
   * 与 listNotes 一致返回裸数组、不带 total：客户端按「返回条数 < limit」判末页。
   */
  async listShareLinks(
    ownerID: string,
    query: ListNoteShareLinksQueryDto,
  ): Promise<NoteShareLinkDto[]> {
    const limit = query.limit ?? SHARE_LINK_LIST_DEFAULT_LIMIT;
    const anchor = query.cursor
      ? await this.prisma.noteShareLink.findFirst({
          where: { id: query.cursor, ownerID },
          select: { id: true, createdAt: true },
        })
      : null;
    if (query.cursor && !anchor) {
      throw new BadRequestException({
        message: 'Invalid note share-link cursor',
        errorCode: NoteErrorCode.ShareLinkInvalidCursor,
      });
    }

    const rows = await this.prisma.noteShareLink.findMany({
      where: anchor
        ? {
            ownerID,
            OR: [
              { createdAt: { lt: anchor.createdAt } },
              { createdAt: anchor.createdAt, id: { lt: anchor.id } },
            ],
          }
        : { ownerID },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      // 只取 mapShareLink 用得上的列：title / noteIDs / search 等快照字段不进
      // DTO，没必要拉出来。给 mapShareLink 的入参加字段时这里会编译报错，
      // 正好当作「别忘了同步」的提醒。
      select: {
        id: true,
        token: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    return rows.map((row) => this.mapShareLink(row));
  }

  /** NoteShareLink 行 → 对外 DTO。token 换成可直接打开的 /s/{token} 链接。 */
  private mapShareLink(row: {
    id: string;
    token: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
  }): NoteShareLinkDto {
    return {
      id: row.id,
      token: row.token,
      url: this.buildShareUrl(row.token),
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    };
  }

  async getNote(ownerID: string, noteId: string): Promise<NoteDetailDto> {
    const note = await this.prisma.note.findFirst({
      where: {
        id: noteId,
        status: { not: 'DELETED' },
        OR: [{ ownerID }, { available: true }],
      },
      include: NOTE_INCLUDE,
    });

    if (!note) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }

    return this.mapDetailResolved(note, ownerID);
  }

  private buildCollectedFrom(
    source: NoteCollectSourceDto,
    note: Pick<NoteRow, 'id' | 'ownerID'>,
  ): Record<string, unknown> {
    return {
      kind: 'chat',
      conversationType: source.conversationType,
      conversationID: source.conversationID,
      clientMsgID: source.clientMsgID,
      sender: {
        id: source.sender.id,
        name: source.sender.name,
        faceURL: source.sender.faceURL ?? null,
      },
      group: source.group
        ? {
            id: source.group.id,
            name: source.group.name,
            faceURL: source.group.faceURL ?? null,
          }
        : null,
      sourceNoteId: note.id,
      sourceOwnerId: note.ownerID,
      collectedAt: new Date().toISOString(),
    };
  }

  private rewriteCollectedSectionMediaIds(
    sections: unknown,
    media: Array<{ id: string; sourceMediaID: string }>,
  ): unknown {
    if (!this.isRecord(sections) || media.length === 0) return sections;

    const copiedIdBySourceId = new Map(
      media.map((item) => [item.sourceMediaID, item.id]),
    );
    const rewriteSection = (section: unknown) => {
      if (!this.isRecord(section) || !Array.isArray(section.items)) {
        return section;
      }
      return {
        ...section,
        items: section.items.map((item) => {
          if (!this.isRecord(item) || typeof item.id !== 'string') {
            return item;
          }
          const copiedId = copiedIdBySourceId.get(item.id);
          return copiedId ? { ...item, id: copiedId } : item;
        }),
      };
    };

    return {
      ...sections,
      media: rewriteSection(sections.media),
      showcase: rewriteSection(sections.showcase),
    };
  }

  private async refreshCollectedNote(
    userID: string,
    sourceNoteID: string,
    collectedFrom: Record<string, unknown>,
  ): Promise<CollectNoteResultDto | null> {
    const existing = await this.prisma.note.findFirst({
      where: {
        ownerID: userID,
        collectedFromNoteID: sourceNoteID,
        status: { not: 'DELETED' },
      },
      select: { id: true },
    });
    if (!existing) return null;

    const refreshed = await this.prisma.note.update({
      where: {
        id: existing.id,
        ownerID: userID,
        status: { not: 'DELETED' },
      },
      data: { collectedFrom: toPrismaJson(collectedFrom) },
      include: NOTE_INCLUDE,
    });
    return {
      note: await this.mapDetailResolved(refreshed, userID),
      alreadyCollected: true,
    };
  }

  /**
   * 聊天里收藏笔记 → 直接进"我的笔记"：把可读的他人笔记快照复制成一条自己的
   * 笔记（媒体行复用同一份存储对象，不搬字节），并记录 collectedFrom 来源名片
   * （群聊记群名片、私聊记发送者名片 + 消息 clientMsgID，供跳回聊天定位）。
   *
   * 幂等：自己的笔记不复制直接返回；同一原笔记重复收藏只刷新来源快照。
   * 并发重复收藏由数据库唯一索引兜底，冲突后重读已有副本。
   */
  async collectNote(
    userID: string,
    dto: CollectNoteDto,
  ): Promise<CollectNoteResultDto> {
    const source = await this.prisma.note.findFirst({
      where: {
        id: dto.noteId,
        status: { not: 'DELETED' },
        OR: [{ ownerID: userID }, { available: true }],
      },
      include: NOTE_INCLUDE,
    });

    if (!source) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }

    // 自己的笔记本来就在"我的笔记"里 —— 不复制、不打来源标（来源名片只对
    // 收藏他人笔记有意义）。
    if (source.ownerID === userID) {
      return {
        note: await this.mapDetailResolved(source, userID),
        alreadyCollected: true,
      };
    }

    const collectedFrom = this.buildCollectedFrom(dto.source, source);

    const refreshedExisting = await this.refreshCollectedNote(
      userID,
      dto.noteId,
      collectedFrom,
    );
    if (refreshedExisting) return refreshedExisting;

    const media = (source.media ?? []).map((item) => ({
      id: randomUUID(),
      sourceMediaID: item.id,
      type: item.type,
      objectKey: item.objectKey,
      url: item.url,
      mimeType: item.mimeType ?? null,
      size: item.size ?? null,
      width: item.width ?? null,
      height: item.height ?? null,
      durationMs: item.durationMs ?? null,
      posterUrl: item.posterUrl ?? null,
      sortOrder: item.sortOrder,
    }));

    // 封面对齐原笔记的封面行；原笔记无封面时回退第一张图（与 createNote 一致）。
    const coverMediaID =
      media.find((item) => item.sourceMediaID === source.coverMedia?.id)?.id ??
      media.find((item) => item.type === 'IMAGE')?.id ??
      null;

    const copiedSections = this.rewriteCollectedSectionMediaIds(
      source.sections,
      media,
    );

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const note = await tx.note.create({
          data: {
            ownerID: userID,
            title: source.title,
            content: source.content,
            contentJson: toPrismaJson(source.contentJson),
            sections: toPrismaJson(copiedSections),
            groupID: null,
            status: 'ACTIVE',
            available: true,
            pinned: false,
            imageCount: source.imageCount,
            videoCount: source.videoCount,
            mediaCount: source.mediaCount,
            collectedFrom: toPrismaJson(collectedFrom),
            collectedFromNoteID: source.id,
          },
        });

        if (media.length > 0) {
          await tx.noteMedia.createMany({
            data: media.map(({ sourceMediaID: _sourceMediaID, ...item }) => ({
              ...item,
              noteID: note.id,
            })),
          });
        }

        return tx.note.update({
          where: { id: note.id },
          data: { coverMediaID },
          include: NOTE_INCLUDE,
        });
      });

      return {
        note: await this.mapDetailResolved(created, userID),
        alreadyCollected: false,
      };
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        const refreshed = await this.refreshCollectedNote(
          userID,
          dto.noteId,
          collectedFrom,
        );
        if (refreshed) return refreshed;
      }
      throw error;
    }
  }

  async createNoteExport(
    viewerID: string,
    noteId: string,
    input: CreateNoteExportDto,
  ): Promise<NoteExportResultDto> {
    const note = await this.prisma.note.findFirst({
      where: {
        id: noteId,
        status: { not: 'DELETED' },
        OR: [{ ownerID: viewerID }, { available: true }],
      },
      include: NOTE_INCLUDE,
    });

    if (!note) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }

    const basename = sanitizeFilenamePart(note.title);
    if (input.format === 'IMAGE' || input.format === 'PDF') {
      // 导出件里嵌的 URL 也要现签：notes/* 已不再匿名可读，原始直链对收件人是 403。
      // 与其它读取路径同一条流水线（collect → presign → map）。
      const presignedUrls = await this.presignNoteMedia(
        this.collectNoteMediaTargets(note),
      );
      return input.format === 'IMAGE'
        ? this.uploadExportArtifact({
            ownerID: note.ownerID,
            noteID: note.id,
            filename: `${basename}.svg`,
            mimeType: 'image/svg+xml',
            body: this.createLongImageSvg(note, presignedUrls),
          })
        : this.uploadExportArtifact({
            ownerID: note.ownerID,
            noteID: note.id,
            filename: `${basename}.pdf`,
            mimeType: 'application/pdf',
            body: await this.createPdf(note, presignedUrls),
          });
    }

    const mediaType = input.format === 'IMAGES' ? 'IMAGE' : 'VIDEO';
    const media = (note.media ?? []).filter((item) => item.type === mediaType);
    const scope = input.scope ?? 'ALL';
    const selected =
      scope === 'ALL' ? media : media.filter((item) => item.id === scope);
    if (selected.length === 0) {
      throw new BadRequestException({
        message: 'No exportable media found',
        errorCode: NoteErrorCode.ExportNoMedia,
      });
    }
    this.assertExportMediaWithinLimits(selected);

    if (scope !== 'ALL') {
      const item = selected[0];
      const ext = mediaExtension(item);
      if (!this.uploadService) {
        throw new ServiceUnavailableException('File export is not configured');
      }
      const download = await this.uploadService.createPresignedGetUrl(
        item.objectKey,
        NOTE_EXPORT_TTL_SECONDS,
      );
      return {
        url: download.url,
        filename: `${basename}-${item.id}.${ext}`,
        mimeType:
          item.mimeType ?? (item.type === 'VIDEO' ? 'video/mp4' : 'image/jpeg'),
        size: item.size ?? null,
        expiresAt: download.expiresAt,
      };
    }

    if (!this.uploadService) {
      throw new ServiceUnavailableException('File export is not configured');
    }
    const entries: Array<{ name: string; data: Buffer }> = [];
    let downloadedBytes = 0;
    for (const [index, item] of selected.entries()) {
      const data = await this.uploadService.downloadObjectBuffer(
        item.objectKey,
        MAX_EXPORT_SINGLE_MEDIA_BYTES,
      );
      if (data.byteLength > MAX_EXPORT_SINGLE_MEDIA_BYTES) {
        throw new BadRequestException({
          message: 'Media file is too large to export',
          errorCode: NoteErrorCode.ExportMediaTooLarge,
        });
      }
      if (downloadedBytes + data.byteLength > MAX_EXPORT_TOTAL_MEDIA_BYTES) {
        throw new BadRequestException({
          message: 'Selected media are too large to export',
          errorCode: NoteErrorCode.ExportTotalTooLarge,
        });
      }
      downloadedBytes += data.byteLength;
      entries.push({
        name: `${input.format.toLowerCase()}-${index + 1}.${mediaExtension(item)}`,
        data,
      });
    }
    const filename = `${basename}-${input.format.toLowerCase()}.zip`;
    return this.uploadExportArtifact({
      ownerID: note.ownerID,
      noteID: note.id,
      filename,
      mimeType: 'application/zip',
      body: createZip(entries),
    });
  }

  async updateNote(
    ownerID: string,
    noteId: string,
    input: UpdateNoteDto,
  ): Promise<NoteDetailDto> {
    const uniqueGroupIds = [...new Set(input.groupIds ?? [])];
    await this.requireOwnedGroups(ownerID, uniqueGroupIds);

    const derived = this.deriveNoteContent(input);
    // 收藏复制的笔记媒体沿用原作者的 objectKey；这些 key 是服务端 collectNote
    // 时合法落到本笔记上的，编辑时允许原样保留（新增媒体仍必须归属自己）。
    const existingMedia = await this.prisma.noteMedia.findMany({
      where: { noteID: noteId, note: { ownerID } },
      select: { objectKey: true },
    });
    this.assertMediaOwnership(
      ownerID,
      derived.media,
      new Set(existingMedia.map((item) => item.objectKey)),
    );
    this.assertMediaUrlsAreSafe(derived.media);

    const media = derived.media
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((item) => ({
        id: randomUUID(),
        ...item,
      }));
    // Cover is the first image. Videos don't get thumbnails, so a video-only
    // note simply has no cover rather than an unrenderable (mp4) one.
    const coverMediaID =
      media.find((item) => item.type === 'IMAGE')?.id ?? null;
    const counts = this.buildMediaStats(media);

    const updated = await this.prisma.$transaction(async (tx) => {
      // Re-verify ownership inside the transaction to prevent TOCTOU races
      // where a concurrent delete could cause this update to un-delete the note.
      const existing = await tx.note.findFirst({
        where: { id: noteId, ownerID, status: { not: 'DELETED' } },
        select: { id: true, status: true },
      });
      if (!existing) {
        throw new NotFoundException({
          message: 'Note not found',
          errorCode: NoteErrorCode.NotFound,
        });
      }

      await tx.noteMedia.deleteMany({
        where: { noteID: noteId },
      });

      await tx.noteGroupMembership.deleteMany({
        where: { noteID: noteId },
      });

      if (media.length > 0) {
        await tx.noteMedia.createMany({
          data: media.map((item) => ({
            id: item.id,
            noteID: noteId,
            type: item.type,
            objectKey: item.objectKey,
            url: item.url,
            mimeType: item.mimeType ?? null,
            size: item.size ?? null,
            width: item.width ?? null,
            height: item.height ?? null,
            durationMs: item.durationMs ?? null,
            posterUrl: item.posterUrl ?? null,
            sortOrder: item.sortOrder,
          })),
        });
      }

      if (uniqueGroupIds.length > 0) {
        await tx.noteGroupMembership.createMany({
          data: uniqueGroupIds.map((groupID) => ({
            noteID: noteId,
            groupID,
          })),
        });
      }

      return tx.note.update({
        where: { id: noteId },
        data: {
          title: derived.title,
          content: derived.content,
          contentJson: toPrismaJson(derived.contentJson),
          sections: toPrismaJson(derived.sections),
          groupID: null,
          // Preserve the existing status when the caller omits it — omitting
          // status on a PATCH must not silently promote an UNLISTED note to ACTIVE.
          status: input.status ?? existing.status,
          pinned: input.pinned ?? false,
          coverMediaID,
          ...counts,
        },
        include: NOTE_INCLUDE,
      });
    });

    return this.mapDetailResolved(updated, ownerID);
  }

  /**
   * Replace a note's group memberships in a single round-trip. Used by the
   * group-membership editor on the client which previously had to fetch each
   * note's full detail, spread all the other fields, and PATCH with the full
   * payload just to change group IDs (review #59).
   */
  async updateNoteGroupIds(
    ownerID: string,
    noteId: string,
    groupIds: string[],
  ): Promise<{ id: string; groupIds: string[] }> {
    const uniqueGroupIds = [...new Set(groupIds)];
    await this.requireOwnedGroups(ownerID, uniqueGroupIds);

    const updated = await this.prisma.$transaction(async (tx) => {
      // Re-verify ownership inside the transaction to prevent TOCTOU races
      // where a concurrent delete could un-delete the note via this update.
      const existing = await tx.note.findFirst({
        where: { id: noteId, ownerID, status: { not: 'DELETED' } },
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException({
          message: 'Note not found',
          errorCode: NoteErrorCode.NotFound,
        });
      }

      await tx.noteGroupMembership.deleteMany({
        where: { noteID: noteId },
      });

      if (uniqueGroupIds.length > 0) {
        await tx.noteGroupMembership.createMany({
          data: uniqueGroupIds.map((groupID) => ({
            noteID: noteId,
            groupID,
          })),
        });
      }

      return tx.note.findUniqueOrThrow({
        where: { id: noteId },
        select: {
          id: true,
          groupMemberships: {
            select: { groupID: true },
          },
        },
      });
    });

    return {
      id: updated.id,
      groupIds: updated.groupMemberships.map((item) => item.groupID),
    };
  }

  async setPinned(ownerID: string, noteId: string, pinned: boolean) {
    await this.requireOwnedNote(ownerID, noteId);
    // Include ownerID + status guard in the write to close the TOCTOU window
    // between the ownership check above and this update.
    return this.prisma.note.update({
      where: { id: noteId, ownerID, status: { not: 'DELETED' } },
      data: { pinned },
      select: {
        id: true,
        pinned: true,
      },
    });
  }

  async setAvailable(ownerID: string, noteId: string, available: boolean) {
    await this.requireOwnedNote(ownerID, noteId);
    // Include ownerID + status guard in the write to close the TOCTOU window.
    return this.prisma.note.update({
      where: { id: noteId, ownerID, status: { not: 'DELETED' } },
      data: { available },
      select: {
        id: true,
        available: true,
      },
    });
  }

  async setStatus(ownerID: string, noteId: string, status: NoteWritableStatus) {
    await this.requireOwnedNote(ownerID, noteId);
    // Include ownerID + status guard in the write to close the TOCTOU window.
    return this.prisma.note.update({
      where: { id: noteId, ownerID, status: { not: 'DELETED' } },
      data: { status },
      select: {
        id: true,
        status: true,
      },
    });
  }

  /** FE#92 回收站：已软删笔记列表（新删在前）。 */
  async listDeletedNotes(
    ownerID: string,
    page = 1,
    limit = 50,
  ): Promise<NoteSummaryDto[]> {
    const take = Math.min(limit, 200);
    const notes = await this.prisma.note.findMany({
      where: { ownerID, status: 'DELETED' },
      orderBy: { updatedAt: 'desc' },
      take,
      skip: (page - 1) * take,
      include: NOTE_INCLUDE,
    });
    return this.mapSummaryListResolved(notes, ownerID);
  }

  /**
   * FE#92 回收站：恢复软删笔记 → ACTIVE。deleteNote 未记录删除前状态
   * （UNLISTED/ACTIVE 无从区分），统一回 ACTIVE —— 用户在列表里可再手动隐藏。
   */
  async restoreNote(ownerID: string, noteId: string): Promise<void> {
    // round 3 review：收藏复制的笔记受「同源活跃副本唯一」局部索引约束 ——
    // 删除旧副本→再次收藏→恢复旧副本会撞唯一索引，裂成一个裸 DB 冲突。
    // 先查同源活跃副本，命中给可控 409。
    const target = await this.prisma.note.findFirst({
      where: { id: noteId, ownerID, status: 'DELETED' },
      select: { id: true, collectedFromNoteID: true },
    });
    if (!target) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
    if (target.collectedFromNoteID) {
      const activeDuplicate = await this.prisma.note.findFirst({
        where: {
          ownerID,
          collectedFromNoteID: target.collectedFromNoteID,
          status: { not: 'DELETED' },
          id: { not: noteId },
        },
        select: { id: true },
      });
      if (activeDuplicate) {
        throw new ConflictException({
          message: '该笔记的另一份收藏副本已存在，无需恢复',
          errorCode: NoteErrorCode.AlreadyCollected,
        });
      }
    }
    let result: { count: number };
    try {
      result = await this.prisma.note.updateMany({
        where: { id: noteId, ownerID, status: 'DELETED' },
        data: { status: 'ACTIVE' },
      });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message: '该笔记的另一份收藏副本已存在，无需恢复',
          errorCode: NoteErrorCode.AlreadyCollected,
        });
      }
      throw error;
    }
    if (result.count === 0) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
  }

  async deleteNote(ownerID: string, noteId: string): Promise<void> {
    await this.requireOwnedNote(ownerID, noteId);
    // Include ownerID + status in the write to close the TOCTOU window, for
    // parity with setPinned / setAvailable.
    await this.prisma.note.update({
      where: { id: noteId, ownerID, status: { not: 'DELETED' } },
      data: { status: 'DELETED' },
      select: { id: true },
    });
  }

  async listGroups(ownerID: string): Promise<NoteGroupDto[]> {
    const groups =
      (await this.prisma.noteGroup.findMany({
        where: {
          ownerID,
          deletedAt: null,
        },
        include: {
          _count: {
            select: {
              memberships: {
                where: {
                  note: {
                    status: { not: 'DELETED' },
                  },
                },
              },
            },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: 500, // #108：防爆护栏（分组数已有业务上限，这里兜异常数据）
      })) ?? [];

    return groups.map((group) => this.mapGroup(group));
  }

  async createGroup(
    ownerID: string,
    input: CreateNoteGroupDto,
  ): Promise<NoteGroupDto> {
    const normalizedName = input.name.trim();

    const [existing, groupCount] = await Promise.all([
      this.prisma.noteGroup.findFirst({
        where: { ownerID, name: normalizedName, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.noteGroup.count({
        where: { ownerID, deletedAt: null },
      }),
    ]);

    if (existing) {
      throw new ConflictException({
        message: 'Note group already exists',
        errorCode: NoteErrorCode.GroupExists,
      });
    }

    if (groupCount >= MAX_GROUPS_PER_USER) {
      throw new BadRequestException({
        message: `Cannot create more than ${MAX_GROUPS_PER_USER} note groups`,
        errorCode: NoteErrorCode.GroupLimit,
      });
    }

    // The `findFirst` above is a fast path; the partial unique index
    // `NoteGroup_owner_name_active_key` is the authoritative race backstop.
    let created;
    try {
      created = await this.prisma.noteGroup.create({
        data: {
          ownerID,
          name: normalizedName,
          sortOrder: groupCount,
        },
      });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message: 'Note group already exists',
          errorCode: NoteErrorCode.GroupExists,
        });
      }
      throw error;
    }

    return {
      id: created.id,
      name: created.name,
      sortOrder: created.sortOrder,
      noteCount: 0,
    };
  }

  async updateGroup(
    ownerID: string,
    groupId: string,
    input: UpdateNoteGroupDto,
  ): Promise<NoteGroupDto> {
    const normalizedName = input.name.trim();

    const group = await this.prisma.noteGroup.findFirst({
      where: {
        id: groupId,
        ownerID,
        deletedAt: null,
      },
    });

    if (!group) {
      throw new NotFoundException({
        message: 'Note group not found',
        errorCode: NoteErrorCode.GroupNotFound,
      });
    }

    // Only check for name conflicts when the name is actually changing.
    if (group.name !== normalizedName) {
      const conflict = await this.prisma.noteGroup.findFirst({
        where: { ownerID, name: normalizedName, deletedAt: null },
        select: { id: true },
      });
      if (conflict) {
        throw new ConflictException({
          message: 'Note group already exists',
          errorCode: NoteErrorCode.GroupExists,
        });
      }
    }

    let updated;
    try {
      updated = await this.prisma.noteGroup.update({
        where: { id: groupId },
        data: {
          name: normalizedName,
        },
        include: {
          _count: {
            select: {
              memberships: {
                where: {
                  note: {
                    status: { not: 'DELETED' },
                  },
                },
              },
            },
          },
        },
      });
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        throw new ConflictException({
          message: 'Note group already exists',
          errorCode: NoteErrorCode.GroupExists,
        });
      }
      throw error;
    }

    return this.mapGroup(updated);
  }

  async deleteGroup(ownerID: string, groupId: string): Promise<void> {
    const group = await this.prisma.noteGroup.findFirst({
      where: {
        id: groupId,
        ownerID,
        deletedAt: null,
      },
    });

    if (!group) {
      throw new NotFoundException({
        message: 'Note group not found',
        errorCode: NoteErrorCode.GroupNotFound,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.noteGroupMembership.deleteMany({ where: { groupID: groupId } });

      await tx.noteGroup.update({
        where: { id: groupId },
        data: { deletedAt: new Date() },
      });

      // Rebalance sortOrder in a single UPDATE … FROM (ROW_NUMBER) query instead
      // of N individual updates, keeping the transaction lean regardless of how
      // many groups the user has.
      await tx.$executeRaw`
        UPDATE "NoteGroup"
        SET    "sortOrder" = ordered.rn
        FROM   (
          SELECT id,
                 (ROW_NUMBER() OVER (
                   ORDER BY "sortOrder" ASC, "createdAt" ASC
                 ) - 1)::INT AS rn
          FROM   "NoteGroup"
          WHERE  "ownerID" = ${ownerID}
            AND  "deletedAt" IS NULL
        ) AS ordered
        WHERE  "NoteGroup".id = ordered.id
      `;
    });
  }

  async reorderGroups(
    ownerID: string,
    groupIds: string[],
  ): Promise<NoteGroupDto[]> {
    const uniqueGroupIds = [...new Set(groupIds)];

    // Require the caller to supply every group — partial reorders leave stale
    // sortOrder values that collide with the newly assigned ones.
    const totalCount = await this.prisma.noteGroup.count({
      where: { ownerID, deletedAt: null },
    });
    if (uniqueGroupIds.length !== totalCount) {
      throw new BadRequestException(
        `reorderGroups must include all ${totalCount} group(s); received ${uniqueGroupIds.length}`,
      );
    }

    // Ownership check (also guards against cross-user IDs in the list).
    await this.requireOwnedGroups(ownerID, uniqueGroupIds);

    await this.prisma.$transaction(
      uniqueGroupIds.map((groupId, index) =>
        this.prisma.noteGroup.update({
          where: { id: groupId },
          data: { sortOrder: index },
        }),
      ),
    );

    return this.listGroups(ownerID);
  }
}

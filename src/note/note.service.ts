import { ChatService } from 'src/chat/chat.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MembershipErrorCode, NoteErrorCode } from 'src/common/app-error-codes';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { normalizeUserIdAlias } from 'src/user/user-id-alias';
import { existsSync } from 'fs';
import PDFDocument from 'pdfkit';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { purgeDeletedNote } from './note-purge';
import {
  ChatCircleSyncService,
  DISABLED_ADMIN_STATES,
} from 'src/chat/chat-circle-sync.service';
import { UploadService } from 'src/upload/upload.service';
import {
  CHAT_MEDIA_DELETE_CLAIM_REASON,
  CHAT_MEDIA_KEY_PREFIX,
  CHAT_NOTE_IMPORT_SEGMENT,
  CHAT_NOTE_IMPORT_RESERVATION_MS,
  CHAT_NOTE_IMPORT_RESERVATION_REASON,
} from 'src/chat/chat.constants';
import {
  assertUrlsFromStorage,
  isUrlFromStorage,
  storagePublicObjectBasesFromConfig,
} from 'src/utils/storage-url';
import {
  prismaErrorCode,
  runSerializableTransaction,
} from 'src/utils/prisma-tx';
import {
  CollectNoteDto,
  CollectNoteResultDto,
  NoteSourceStateDto,
  CreateNoteExportDto,
  CreateNoteDto,
  CreateNoteGroupDto,
  CreateNoteShareLinkDto,
  ListNoteShareLinksQueryDto,
  ListNotesQueryDto,
  NOTE_CHAT_MEDIA_SECTION,
  NoteChatMediaImportDto,
  NoteChatMediaItemDto,
  NoteChatMediaSection,
  NoteCollectPeerDto,
  NoteCollectSourceDto,
  NoteDetailDto,
  NoteDraftDto,
  NoteDraftSummaryDto,
  NoteExportResultDto,
  NoteGroupDto,
  NoteMediaType,
  NoteSectionsDto,
  NoteSectionsResponseDto,
  SaveNoteDraftDto,
  NoteShareLinkDto,
  NoteStatus,
  NoteSummaryDto,
  NoteCardPeerDto,
  NoteWritableStatus,
  NoteWorkStatus,
  SharedNoteListDto,
  UpdateNoteDto,
  UpdateNoteGroupDto,
  NOTE_LIST_DEFAULT_LIMIT,
  NOTE_GROUP_CARD_NAME_MAX,
  MAX_NOTE_DRAFT_MEDIA_KEYS,
} from './dto/note.dto';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logBusinessEvent } from 'src/logging/business-event.logger';

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
  rows: {
    cells: (
      | BNInlineContent[]
      | { type: 'tableCell'; content: BNInlineContent[] }
    )[];
  }[];
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

// 笔记媒体导入撞上删除 worker 仍在回收同一个确定性 key:可重试的 409。
// 文案保持笼统,不把 worker 的内部状态透给客户端。
function noteImportRecyclingConflict(): ConflictException {
  return new ConflictException(
    'Note media is being recycled, please retry shortly',
  );
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

type NoteDraftRow = {
  id: string;
  ownerID: string;
  clientDraftID: string;
  sourceNoteID: string | null;
  title: string;
  content: string | null;
  contentJson: unknown;
  sections: unknown;
  groupIDs: string[];
  mediaKeys: string[];
  createdAt: Date;
  updatedAt: Date;
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
  workStatus: NoteWorkStatus | null;
  sourceConversationID?: string | null;
  pinned: boolean;
  remark?: string | null;
  imageCount: number;
  videoCount: number;
  audioCount: number;
  mediaCount: number;
  collectedFrom?: unknown;
  collectedFromNoteID?: string | null;
  rootSourceNoteID?: string | null;
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
  audio: {
    items: Array<Record<string, unknown>>;
  };
  contacts: {
    items: Array<Record<string, unknown>>;
  };
  groups: {
    items: Array<Record<string, unknown>>;
  };
  location: NoteLocationSection | null;
};

type NoteCardSnapshot = {
  id: string;
  name: string;
  faceURL: string | null;
  circleId?: string;
  /** 独立群名片的会话 id：服务端按会话解析出来才写，客户端据此路由到群聊。 */
  conversationID?: string;
};

/** 来源群名片：独立群额外带服务端核实过的会话 id。 */
type OriginGroupCard = NonNullable<NoteCollectSourceDto['group']> & {
  conversationID?: string;
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
// Discarded IDs prevent delayed autosaves for 30 days. Published outcomes never
// expire: their replay remains safe even after the target note is deleted.
const NOTE_DRAFT_DISCARD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_NOTE_DISCARDED_DRAFTS = 1000;
export const MAX_NOTE_EDIT_PUBLICATION_OUTCOMES = 10_000;

// Keep derived title/content in sync with the DTO's @MaxLength caps — text
// extracted from contentJson blocks otherwise bypasses DTO validation.
const MAX_NOTE_TITLE_LENGTH = 120;
const MAX_NOTE_CONTENT_LENGTH = 20_000;

function sliceByCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join('');
}
const MAX_NOTE_PREVIEW_LENGTH = 120;
/** 递归下钻块/行内节点的层数上限，挡住恶意构造的深层嵌套。 */
const MAX_NOTE_BLOCK_DEPTH = 10;
/**
 * Note.content 的行分隔符：块与块之间、表格的行与行之间都用它。
 * 块之间用换行接而不是空格 —— 表格片段本身就是多行的，用空格接会把表格后面的
 * 段落粘到最后一行末尾，导出时被当成多出来的一格。
 */
const NOTE_LINE_SEPARATOR = '\n';
/** 列表卡片每类名片（个人/群）最多带几个摘要。 */
const NOTE_CARD_PREVIEW_LIMIT = 3;
/** 无名独立群的兜底名取几位成员昵称。 */
const UNNAMED_GROUP_LABEL_MEMBERS = 3;
/** 表格同一行内的列分隔符。 */
const NOTE_TABLE_CELL_SEPARATOR = '\t';
/**
 * 预览折叠用：空白 + \s 之外的 C0/C1 控制字符。
 * \t/\n/\v/\f/\r 本来就在 \s 里，所以 C0 只补 \u0000-\u0008 与 \u000e-\u001f。
 */

const NOTE_PREVIEW_WHITESPACE_PATTERN =
  /[\s\u0000-\u0008\u000e-\u001f\u007f-\u009f]+/g;
const NOTE_EXPORT_TTL_SECONDS = 15 * 60;
// 读取时给笔记媒体现签短时 URL。signingDate 舍入到 WINDOW → 同窗口内同一对象签出字节相同的
// URL，客户端(expo-image)按-URL 缓存才命中；TTL = 窗口 + buffer，保证窗口内始终有效。
const NOTE_MEDIA_URL_WINDOW_MS = 60 * 60 * 1000; // 1h
const NOTE_MEDIA_URL_TTL_SECONDS = 2 * 60 * 60; // 2h
/** 单请求内 S3 CopyObject 的并发上限（转发笔记媒体进聊天时）。 */
const NOTE_CHAT_MEDIA_COPY_CONCURRENCY = 5;
const MAX_NOTE_MEDIA_ITEMS = 50;
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

/**
 * 笔记列表的一页。hasMore 由多取的一行判断，controller 放进 X-Has-More 响应头 ——
 * 响应体本身仍是 items 数组（app 依赖这个形状）。
 */
export interface NoteSummaryPage {
  items: NoteSummaryDto[];
  hasMore: boolean;
}

@Injectable()
export class NoteService {
  private readonly logger = new Logger(NoteService.name);
  private readonly loggingConfig = createLoggingConfig();
  private readonly storagePublicObjectBases: readonly string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly membershipPolicy: MembershipPolicyService,
    private readonly chat: ChatService,
    @Optional() private readonly uploadService?: UploadService,
    @Optional() private readonly realtime?: RealtimeService,
    @Optional() private readonly circleSync?: ChatCircleSyncService,
  ) {
    this.storagePublicObjectBases = storagePublicObjectBasesFromConfig(
      this.config,
    );
  }

  private assertClientDraftID(clientDraftID: string): void {
    if (!/^[A-Za-z0-9._:-]{1,180}$/.test(clientDraftID)) {
      throw new BadRequestException('Invalid draft id');
    }
  }

  private mapNoteDraftSummary(row: NoteDraftRow): NoteDraftSummaryDto {
    const sections = this.isRecord(row.sections) ? row.sections : {};
    const text = this.isRecord(sections.text) ? sections.text : {};
    const blockText = (value: unknown) =>
      this.extractBlockText(
        Array.isArray(value) ? (value as NoteContentBlock[]) : undefined,
      ).join(NOTE_LINE_SEPARATOR);
    const previewSource =
      row.content?.trim() ||
      (typeof text.content === 'string' ? text.content.trim() : '') ||
      blockText(text.contentJson) ||
      blockText(row.contentJson) ||
      row.title.trim();
    const items = ['media', 'showcase', 'audio'].flatMap((name) => {
      const section = this.isRecord(sections[name]) ? sections[name] : {};
      return Array.isArray(section.items) ? section.items : [];
    });
    const media = [
      ...items.filter((item) => this.isRecord(item)),
      ...this.draftBlockMedia(row.contentJson),
      ...this.draftBlockMedia(
        this.isRecord(sections.text) ? sections.text.contentJson : undefined,
      ),
    ];
    const primaryKeys = new Set(media.map((item) => item.objectKey));
    const posterKeys = new Set(
      media
        .map((item) =>
          this.uploadService?.objectKeyFromPublicUrl(item.posterUrl),
        )
        .filter(Boolean),
    );
    return {
      id: row.clientDraftID,
      sourceNoteId: row.sourceNoteID ?? null,
      title: row.title,
      contentPreview: this.buildPreview(previewSource),
      mediaCount: row.mediaKeys.filter(
        (key) => !posterKeys.has(key) || primaryKeys.has(key),
      ).length,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapNoteDraft(row: NoteDraftRow): NoteDraftDto {
    return {
      ...this.mapNoteDraftSummary(row),
      content: row.content ?? null,
      contentJson: Array.isArray(row.contentJson)
        ? (row.contentJson as Record<string, unknown>[])
        : null,
      sections:
        row.sections && typeof row.sections === 'object'
          ? (row.sections as NoteDraftDto['sections'])
          : null,
      groupIds: row.groupIDs,
      mediaKeys: row.mediaKeys,
    };
  }

  private draftBlockMedia(blocks: unknown): CreateNoteDto['media'] {
    return this.deriveMediaFromBlocks(
      Array.isArray(blocks) ? (blocks as NoteContentBlock[]) : undefined,
    );
  }

  private async mapNoteDraftResolved(row: NoteDraftRow): Promise<NoteDraftDto> {
    const result = this.mapNoteDraft(row);
    const targets: Array<{ url: string; objectKey: string }> = [];
    // Only the validated inventory may be signed, including nested BlockNote media.
    const keys = new Set(row.mediaKeys);
    const prepareItem = (item: unknown) => {
      if (
        !this.isRecord(item) ||
        typeof item.objectKey !== 'string' ||
        !keys.has(item.objectKey)
      )
        return item;
      const url = this.resolveMediaUrl({ objectKey: item.objectKey });
      targets.push({ url, objectKey: item.objectKey });
      const posterKey = this.uploadService?.objectKeyFromPublicUrl(
        item.posterUrl,
      );
      const posterUrl =
        typeof item.posterUrl === 'string'
          ? item.posterUrl.split('?')[0]
          : undefined;
      if (posterKey && posterUrl && keys.has(posterKey))
        targets.push({ url: posterUrl, objectKey: posterKey });
      return { ...item, url, ...(posterUrl ? { posterUrl } : {}) };
    };
    const mapBlocks = (
      blocks: unknown,
      mapItem: (item: unknown) => unknown,
      depth = 0,
    ): unknown => {
      if (!Array.isArray(blocks) || depth > MAX_NOTE_BLOCK_DEPTH) return blocks;
      return blocks.map((block) => {
        if (!this.isRecord(block)) return block;
        return {
          ...block,
          ...(block.type === 'image' || block.type === 'video'
            ? { props: mapItem(block.props) }
            : {}),
          ...(Array.isArray(block.children)
            ? { children: mapBlocks(block.children, mapItem, depth + 1) }
            : {}),
        };
      });
    };
    const sections = this.isRecord(row.sections) ? row.sections : {};
    const mappedSections: Record<string, any> = { ...sections };
    for (const section of ['media', 'showcase', 'audio'] as const) {
      const stored = this.isRecord(sections[section]) ? sections[section] : {};
      if (Array.isArray(stored.items))
        mappedSections[section] = {
          ...stored,
          items: stored.items.map(prepareItem),
        };
    }
    let contentJson = mapBlocks(result.contentJson, prepareItem);
    if (this.isRecord(sections.text))
      mappedSections.text = {
        ...sections.text,
        contentJson: mapBlocks(sections.text.contentJson, prepareItem),
      };
    if (!targets.length) return result;
    const presigned = await this.presignNoteMedia(targets);
    const signItem = (item: unknown) =>
      this.applyPresignedToItems([item], presigned)[0];
    contentJson = mapBlocks(contentJson, signItem);
    if (mappedSections.text)
      mappedSections.text.contentJson = mapBlocks(
        mappedSections.text.contentJson,
        signItem,
      );
    for (const section of ['media', 'showcase', 'audio'] as const) {
      const stored = mappedSections[section];
      if (Array.isArray(stored?.items))
        mappedSections[section] = {
          ...stored,
          items: this.applyPresignedToItems(stored.items, presigned),
        };
    }
    return {
      ...result,
      contentJson: contentJson as NoteDraftDto['contentJson'],
      sections: mappedSections as NoteDraftDto['sections'],
    };
  }

  async listNoteDrafts(
    ownerID: string,
    page = 1,
    limit = 100,
  ): Promise<NoteDraftSummaryDto[]> {
    const rows = await this.prisma.noteDraft.findMany({
      where: { ownerID, consumedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
    return rows.map((row) => this.mapNoteDraftSummary(row as NoteDraftRow));
  }

  async getNoteDraft(
    ownerID: string,
    clientDraftID: string,
  ): Promise<NoteDraftDto> {
    this.assertClientDraftID(clientDraftID);
    const row = await this.prisma.noteDraft.findFirst({
      where: { ownerID, clientDraftID, consumedAt: null },
    });
    if (!row) {
      throw new NotFoundException({
        message: 'Note draft not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
    return this.mapNoteDraftResolved(row as NoteDraftRow);
  }

  async saveNoteDraft(
    ownerID: string,
    clientDraftID: string,
    input: SaveNoteDraftDto,
  ): Promise<NoteDraftDto> {
    this.assertClientDraftID(clientDraftID);
    const groupIDs = [...new Set(input.groupIds ?? [])];
    await this.requireOwnedGroups(ownerID, groupIDs);

    let sourceMediaKeys = new Set<string>();
    let sourceSections: unknown;
    if (input.sourceNoteId) {
      const sourceNote = await this.prisma.note.findFirst({
        where: { id: input.sourceNoteId, ownerID },
        select: { id: true, sections: true },
      });
      if (!sourceNote) {
        throw new NotFoundException({
          message: 'Source note not found',
          errorCode: NoteErrorCode.NotFound,
        });
      }
      sourceSections = sourceNote.sections;
      const sourceMedia = await this.prisma.noteMedia.findMany({
        where: { noteID: input.sourceNoteId },
        select: { objectKey: true, posterUrl: true },
      });
      sourceMediaKeys = new Set(
        sourceMedia.flatMap((item) => {
          const posterKey = this.uploadService?.objectKeyFromPublicUrl(
            item.posterUrl,
          );
          return [item.objectKey, ...(posterKey ? [posterKey] : [])];
        }),
      );
    }

    // Resolve cards from their ids rather than persisting client-selected
    // profile fields or navigation targets. Retain trusted source-note
    // snapshots when editing after friendship or membership changes.
    const canonicalCards = await this.canonicalizeNoteCards(
      ownerID,
      {
        sections: {
          groups: input.sections?.groups,
          contacts: input.sections?.contacts,
        },
      },
      sourceSections,
    );
    const sections = input.sections
      ? {
          ...input.sections,
          ...(input.sections.groups
            ? { groups: canonicalCards.sections?.groups }
            : {}),
          ...(input.sections.contacts
            ? { contacts: canonicalCards.sections?.contacts }
            : {}),
        }
      : undefined;

    const sectionKeys: string[] = [];
    const posterKeys: string[] = [];
    for (const section of ['media', 'showcase', 'audio'] as const) {
      for (const item of input.sections?.[section]?.items ?? []) {
        if ((section === 'audio') !== (item.type === 'AUDIO'))
          throw new BadRequestException(
            `${section} section has an incompatible media type`,
          );
        sectionKeys.push(item.objectKey);
        if (item.posterUrl) {
          assertUrlsFromStorage(
            [item.posterUrl],
            this.storagePublicObjectBases,
            'draft poster url',
          );
          const key = this.uploadService?.objectKeyFromPublicUrl(
            item.posterUrl,
          );
          if (!key) throw new BadRequestException('Invalid draft poster URL');
          posterKeys.push(key);
        }
      }
    }
    const mediaKeys = [
      ...new Set([...(input.mediaKeys ?? []), ...sectionKeys, ...posterKeys]),
    ];
    const blockMedia = [
      ...this.draftBlockMedia(input.contentJson),
      ...this.draftBlockMedia(input.sections?.text?.contentJson),
    ];
    for (const item of blockMedia) {
      mediaKeys.push(item.objectKey);
      if (item.posterUrl) {
        assertUrlsFromStorage(
          [item.posterUrl],
          this.storagePublicObjectBases,
          'draft poster url',
        );
        const key = this.uploadService?.objectKeyFromPublicUrl(item.posterUrl);
        if (!key) throw new BadRequestException('Invalid draft poster URL');
        mediaKeys.push(key);
      }
    }
    const inventoryKeys = [...new Set(mediaKeys)];
    if (inventoryKeys.length > MAX_NOTE_DRAFT_MEDIA_KEYS)
      throw new BadRequestException(
        `Draft media limit is ${MAX_NOTE_DRAFT_MEDIA_KEYS} objects, including posters`,
      );
    const ownPrefix = `notes/${ownerID}/`;
    if (
      inventoryKeys.some(
        (key) =>
          key.includes('..') ||
          (!key.startsWith(ownPrefix) && !sourceMediaKeys.has(key)),
      )
    ) {
      throw new BadRequestException(
        'Draft media does not belong to the current user',
      );
    }

    const row = await runSerializableTransaction(this.prisma, async (tx) => {
      // Share the owner's lock with publication and quota writes. A committed
      // Note retains the draft id, so even a delayed save cannot resurrect it.
      await this.membershipPolicy.lockUsers(tx, [ownerID]);
      await this.expireDiscardedNoteDrafts(tx, ownerID);
      const published = await tx.note.findFirst({
        where: { ownerID, clientDraftID },
        select: { id: true },
      });
      if (published)
        throw new ConflictException('This draft has already been published');
      const existing = await tx.noteDraft.findUnique({
        where: { ownerID_clientDraftID: { ownerID, clientDraftID } },
        select: { id: true, consumedAt: true },
      });
      if (existing?.consumedAt)
        throw new ConflictException('This draft has been consumed');
      if (!existing) await this.requireDiscardedDraftCapacity(tx, ownerID);
      if (
        !existing &&
        (await tx.noteDraft.count({ where: { ownerID, consumedAt: null } })) >=
          100
      ) {
        throw new ConflictException(
          'Draft limit reached. Delete an existing draft before creating another.',
        );
      }
      const data = {
        sourceNoteID: input.sourceNoteId ?? null,
        title: sliceByCodePoints(
          (input.title ?? '').trim(),
          MAX_NOTE_TITLE_LENGTH,
        ),
        content:
          input.content == null
            ? null
            : sliceByCodePoints(input.content, MAX_NOTE_CONTENT_LENGTH),
        contentJson: toPrismaJson(input.contentJson ?? null),
        sections: toPrismaJson(sections ?? null),
        groupIDs,
        mediaKeys: inventoryKeys,
      };
      return tx.noteDraft.upsert({
        where: { ownerID_clientDraftID: { ownerID, clientDraftID } },
        create: { ownerID, clientDraftID, ...data },
        update: data,
      });
    });
    return this.mapNoteDraftResolved(row as NoteDraftRow);
  }

  private async publishedDraftNote(
    tx: Pick<Prisma.TransactionClient, 'noteDraft' | 'note'>,
    ownerID: string,
    clientDraftID: string | undefined,
    sourceNoteID: string | null,
  ): Promise<NoteRow | null> {
    if (!clientDraftID) return null;
    this.assertClientDraftID(clientDraftID);
    await this.expireDiscardedNoteDrafts(tx, ownerID);
    const draft = await tx.noteDraft.findUnique({
      where: { ownerID_clientDraftID: { ownerID, clientDraftID } },
      select: { consumedAt: true, sourceNoteID: true, publishedNoteID: true },
    });
    if (!draft?.consumedAt) return null;
    if (
      !draft.publishedNoteID ||
      draft.sourceNoteID !== sourceNoteID ||
      (sourceNoteID !== null && draft.publishedNoteID !== sourceNoteID)
    ) {
      throw new ConflictException('This draft has been consumed');
    }
    const note = await tx.note.findFirst({
      where: { id: draft.publishedNoteID, ownerID, status: { not: 'DELETED' } },
      include: NOTE_INCLUDE,
    });
    if (!note)
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    return note;
  }

  private async consumeNoteDraft(
    tx: Prisma.TransactionClient,
    ownerID: string,
    clientDraftID: string,
    sourceNoteID?: string | null,
  ): Promise<void> {
    this.assertClientDraftID(clientDraftID);
    const existing = await tx.noteDraft.findUnique({
      where: { ownerID_clientDraftID: { ownerID, clientDraftID } },
      select: { sourceNoteID: true, consumedAt: true },
    });
    if (existing?.consumedAt && sourceNoteID !== undefined)
      throw new ConflictException('This draft has been consumed');
    // Repeated DELETE neither renews discarded retention nor changes a durable
    // publication result. At capacity, active drafts can still be discarded.
    if (existing?.consumedAt) return;
    if (!existing && sourceNoteID === undefined)
      await this.requireDiscardedDraftCapacity(tx, ownerID);
    if (
      existing &&
      sourceNoteID !== undefined &&
      existing.sourceNoteID !== sourceNoteID
    ) {
      throw new BadRequestException(
        'Draft does not belong to the note being saved',
      );
    }
    // Keep only a tombstone. The owner's lock serializes upserts, and this
    // durable marker rejects autosaves that acquire the lock after consumption.
    const data = {
      consumedAt: new Date(),
      title: '',
      content: null,
      contentJson: Prisma.DbNull,
      sections: Prisma.DbNull,
      groupIDs: [],
      mediaKeys: [],
    };
    await tx.noteDraft.upsert({
      where: { ownerID_clientDraftID: { ownerID, clientDraftID } },
      create: {
        ownerID,
        clientDraftID,
        sourceNoteID: sourceNoteID ?? null,
        ...data,
      },
      update: data,
    });
  }

  async deleteNoteDraft(ownerID: string, clientDraftID: string): Promise<void> {
    this.assertClientDraftID(clientDraftID);
    await runSerializableTransaction(this.prisma, async (tx) => {
      await this.membershipPolicy.lockUsers(tx, [ownerID]);
      await this.expireDiscardedNoteDrafts(tx, ownerID);
      await this.consumeNoteDraft(tx, ownerID, clientDraftID);
    });
  }

  private async expireDiscardedNoteDrafts(
    tx: Pick<Prisma.TransactionClient, 'noteDraft'>,
    ownerID: string,
  ): Promise<void> {
    await tx.noteDraft.deleteMany({
      where: {
        ownerID,
        publishedNoteID: null,
        consumedAt: {
          lt: new Date(Date.now() - NOTE_DRAFT_DISCARD_RETENTION_MS),
        },
      },
    });
  }

  private async requireDiscardedDraftCapacity(
    tx: Pick<Prisma.TransactionClient, 'noteDraft'>,
    ownerID: string,
  ): Promise<void> {
    if (
      (await tx.noteDraft.count({
        where: {
          ownerID,
          publishedNoteID: null,
          consumedAt: { not: null },
        },
      })) >= MAX_NOTE_DISCARDED_DRAFTS
    )
      throw new ConflictException(
        'Draft discard limit reached. Discarded IDs are retained for 30 days; try again after older entries expire.',
      );
  }

  private async assertNoteEditOutcomeCapacity(
    tx: Pick<Prisma.TransactionClient, 'noteDraft'>,
    ownerID: string,
    noteId: string,
  ): Promise<void> {
    // Called under the owner lock, after replay. The sourceNoteID index keeps
    // this count local to the note; create outcomes have no sourceNoteID.
    const current = await tx.noteDraft.count({
      where: {
        ownerID,
        sourceNoteID: noteId,
        publishedNoteID: { not: null },
      },
    });
    if (current >= MAX_NOTE_EDIT_PUBLICATION_OUTCOMES)
      throw new ForbiddenException({
        message:
          'This note has reached its saved edit result limit. Keep your draft and save these edits as a new note.',
        errorCode: NoteErrorCode.PublicationQuotaReached,
        quota: 'notePublicationEdits',
        limit: MAX_NOTE_EDIT_PUBLICATION_OUTCOMES,
        current,
        details: {
          quota: 'notePublicationEdits',
          limit: MAX_NOTE_EDIT_PUBLICATION_OUTCOMES,
          current,
        },
      });
  }

  /**
   * Active storage is one owned, non-deleted Note row. Group memberships do
   * not add slots, and DELETED rows release capacity. Restoring a note must
   * pass this same gate; ordinary writable-note lookups exclude DELETED.
   */
  private async assertNoteStorageAvailable(
    tx: Prisma.TransactionClient,
    ownerID: string,
  ): Promise<void> {
    const membership = await tx.user.findUnique({
      where: { id: ownerID },
      select: { vipLevel: true, vipExpiresAt: true },
    });
    if (!membership) {
      throw new NotFoundException({
        message: 'User not found',
        errorCode: MembershipErrorCode.UserNotFound,
      });
    }

    const current = await tx.note.count({
      where: { ownerID, status: { not: 'DELETED' } },
    });
    const limit =
      // lockForWrite: serialize the rollout-floor read against program
      // enablement so this note-quota decision cannot commit under a stale floor.
      (
        await this.membershipPolicy.resolveEntitlement(
          membership,
          tx,
          new Date(),
          {
            lockForWrite: true,
          },
        )
      ).tier.quotas.notes.actual;
    if (current >= limit) {
      throw new ForbiddenException({
        message: 'Note storage quota reached',
        errorCode: NoteErrorCode.StorageQuotaReached,
        quota: 'notes',
        limit,
        current,
        details: { quota: 'notes', limit, current },
      });
    }
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

  /** 群设置里的来源关联和开工/打烊状态只属于老板的来源笔记。 */
  private async requireOwnedSourceNote(ownerID: string, noteId: string) {
    const note = await this.requireOwnedNote(ownerID, noteId);
    if (note.collectedFromNoteID) {
      throw new ForbiddenException(
        'Only a source note can be managed from its group',
      );
    }
    return note;
  }

  private noteRootID(note: {
    id: string;
    rootSourceNoteID?: string | null;
  }): string {
    return note.rootSourceNoteID ?? note.id;
  }

  /** Coalesce a root's latest state change inside the caller's transaction. */
  private async enqueueSourceStatusFanout(
    tx: Prisma.TransactionClient,
    rootNoteID: string,
  ): Promise<void> {
    const queuedAt = new Date();
    await tx.noteStatusFanoutOutbox.upsert({
      where: { rootNoteID },
      create: {
        rootNoteID,
        status: 'PENDING',
        stage: 'OWNERS',
        queuedAt,
        nextAttemptAt: queuedAt,
      },
      update: {
        status: 'PENDING',
        stage: 'OWNERS',
        generation: { increment: 1 },
        noteCursor: null,
        chatConversationCursor: null,
        chatUserCursor: null,
        attempts: 0,
        lastError: null,
        queuedAt,
        nextAttemptAt: queuedAt,
        lockedAt: null,
        leaseToken: null,
      },
    });
  }

  /** 保留来源群名片快照，避免收录副本或已绑定来源笔记被客户端改成别的群。 */
  private preserveManagedGroupCard(
    nextSections: unknown,
    sourceSections: unknown,
  ): unknown {
    const next = this.isRecord(nextSections) ? { ...nextSections } : {};
    const source = this.isRecord(sourceSections) ? sourceSections : {};
    if (this.isRecord(source.groups)) {
      next.groups = source.groups;
    } else {
      delete next.groups;
    }
    return next;
  }

  private createShareToken(): string {
    return randomBytes(18).toString('base64url');
  }

  private getExportSectionMedia(sections: NoteSections) {
    const seen = new Set<string>();
    return [
      ...sections.media.items,
      ...sections.showcase.items,
      ...(sections.audio?.items ?? []),
    ].filter((item: any) => {
      if (
        item.type !== 'IMAGE' &&
        item.type !== 'VIDEO' &&
        item.type !== 'AUDIO'
      )
        return false;
      const key =
        typeof item.objectKey === 'string'
          ? `${item.objectKey}:${item.url ?? ''}`
          : `url:${item.url ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * 长图导出使用 SVG 容器：正文按文本排版，图片媒体嵌成 data URI，避免把
   * 带权限的短时 URL 写进长期文件。视频不能被 SVG 携带，仍只保留一个媒体标签。
   * presignedUrls 仍用于 buildSectionsFromRow，确保无法嵌入的历史媒体不会回退到
   * 私有原始直链。
   */
  private async createLongImageSvg(
    note: NoteRow,
    presignedUrls?: Map<string, string>,
  ) {
    const sections = this.buildSectionsFromRow(note, presignedUrls);
    const exportMedia = this.getExportSectionMedia(sections);
    const mediaByKey = new Map(
      (note.media ?? []).map((item) => [item.objectKey, item]),
    );
    const textLines = [
      note.title,
      '',
      // 一个换行一个 <text>：SVG 默认 xml:space 会把 <text> 里的换行整个**吞掉**
      // （不是换成空格），整段塞一个 <text> 会让表格行和后面的段落首尾粘在一起。
      ...(sections.text.content ?? '').split(NOTE_LINE_SEPARATOR),
      ...(sections.location
        ? [
            '',
            `位置: ${sections.location.title ?? ''}`,
            sections.location.address ?? '',
          ]
        : []),
    ].filter((line) => line != null);

    const safeImageMime = (item: any, media: NoteMediaRow | undefined) => {
      const mime = media?.mimeType ?? item.mimeType;
      if (
        typeof mime === 'string' &&
        /^(image\/(?:jpeg|jpg|png|gif|webp|avif))$/i.test(mime)
      ) {
        return mime.toLowerCase() === 'image/jpg' ? 'image/jpeg' : mime;
      }
      const source = String(
        media?.objectKey ?? item.objectKey ?? item.url ?? '',
      )
        .split('?')[0]
        .split('#')[0]
        .toLowerCase();
      const extension = source.slice(source.lastIndexOf('.') + 1);
      const byExtension: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        avif: 'image/avif',
      };
      return byExtension[extension] ?? null;
    };

    const text = textLines
      .map(
        (line, index) =>
          `<text x="40" y="${60 + index * 34}" font-size="${index === 0 ? 28 : 18}" fill="#111827">${escapeXml(String(line))}</text>`,
      )
      .join('');
    let cursor = 60 + textLines.length * 34;
    let embeddedBytes = 0;
    const mediaMarkup: string[] = [];
    for (const [index, item] of exportMedia.entries()) {
      const objectKey =
        typeof item.objectKey === 'string' ? item.objectKey : undefined;
      const media = objectKey ? mediaByKey.get(objectKey) : undefined;
      const label =
        item.type === 'VIDEO' ? `视频 ${index + 1}` : `图片 ${index + 1}`;
      cursor += 18;
      mediaMarkup.push(
        `<text x="40" y="${cursor}" font-size="18" fill="#111827">${escapeXml(label)}</text>`,
      );
      cursor += 18;

      const mime = safeImageMime(item, media);
      const canEmbed =
        item.type === 'IMAGE' &&
        mime &&
        media?.objectKey &&
        embeddedBytes < MAX_EXPORT_TOTAL_MEDIA_BYTES &&
        (media.size == null || media.size <= MAX_EXPORT_SINGLE_MEDIA_BYTES);
      if (!canEmbed || !this.uploadService) {
        cursor += 22;
        continue;
      }

      try {
        const image = await this.uploadService.downloadObjectBuffer(
          media.objectKey,
          MAX_EXPORT_SINGLE_MEDIA_BYTES,
        );
        if (
          !Buffer.isBuffer(image) ||
          image.byteLength === 0 ||
          embeddedBytes + image.byteLength > MAX_EXPORT_TOTAL_MEDIA_BYTES
        ) {
          cursor += 22;
          continue;
        }
        embeddedBytes += image.byteLength;
        const width = 820;
        const sourceWidth = Number(item.width ?? media.width ?? width);
        const sourceHeight = Number(
          item.height ?? media.height ?? width * 0.75,
        );
        const ratio =
          Number.isFinite(sourceWidth) &&
          Number.isFinite(sourceHeight) &&
          sourceWidth > 0 &&
          sourceHeight > 0
            ? sourceHeight / sourceWidth
            : 0.75;
        const imageHeight = Math.min(
          900,
          Math.max(160, Math.round(width * ratio)),
        );
        const dataUri = `data:${mime};base64,${image.toString('base64')}`;
        mediaMarkup.push(
          `<image x="40" y="${cursor}" width="${width}" height="${imageHeight}" preserveAspectRatio="xMidYMid meet" href="${dataUri}" />`,
        );
        cursor += imageHeight + 24;
      } catch {
        // Keep the export usable when one stale/deleted media object cannot be
        // embedded; the remaining note content should still be exported.
        cursor += 22;
      }
    }

    const height = Math.max(320, cursor + 40);
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}"><rect width="900" height="${height}" fill="#ffffff"/>${text}${mediaMarkup.join('')}</svg>`,
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
      const type =
        ({ IMAGE: 'Image', VIDEO: 'Video', AUDIO: 'Audio' } as const)[
          item.type as 'IMAGE' | 'VIDEO' | 'AUDIO'
        ] ?? 'Media';
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

  /**
   * 对象 key 的内容指纹。
   *
   * 不能拿导出件的字节去算:带媒体的笔记在导出前会现签一批预签名 URL(签名与
   * 过期参数每次都不同),这些 URL 直接嵌在 SVG/PDF 里 —— 于是同一篇没改过的
   * 笔记每次导出 body 都不同、哈希都不同、key 都不同,每导出一次就多留一个
   * 永久对象。这正是内容哈希本来要堵掉的那条磁盘耗尽路径,等于白做。
   *
   * 改用稳定量:笔记修订时间 + 参与导出的媒体对象 key(排序后)。
   *
   * 复用 key 不会让导出件里的签名 URL 过期:body 每次仍然重新生成并 PUT 覆盖
   * 同一个 key,key 只用于给存储去重,不用于跳过生成。
   */
  private exportFingerprint(
    note: { updatedAt: Date | null },
    objectKeys: readonly string[],
  ): string {
    return JSON.stringify({
      revision: note.updatedAt?.toISOString() ?? null,
      media: [...objectKeys].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    });
  }

  private async uploadExportArtifact(input: {
    ownerID: string;
    noteID: string;
    filename: string;
    mimeType: string;
    body: Buffer;
    /** 见 {@link exportFingerprint} —— 必须是稳定量,不能由 body 派生。 */
    contentFingerprint: string;
  }): Promise<NoteExportResultDto> {
    if (!this.uploadService) {
      throw new ServiceUnavailableException('File export is not configured');
    }
    // key 用内容哈希而不是 randomUUID：同一篇笔记、同一种格式、同样的内容重复导出
    // 时复用同一个对象，而不是每次落一个新的永久对象。
    //
    // 之前是每调用一次就新建一个 key，而后端没有任何删除对象的代码路径，于是一个
    // 循环调用导出的脚本能持续往磁盘里堆几十上百 GiB —— 和 Postgres 同机，写满时
    // 倒下的是数据库。now 生命周期规则（docker-compose minio-init）把上限压到一天，
    // 这里再把「同样的内容反复占新空间」这条也堵掉：内容不变则 key 不变，PUT 覆盖
    // 同一个对象。内容变了哈希才变，所以不会返回过期的导出。
    const contentHash = createHash('sha256')
      .update(input.mimeType)
      .update(input.filename)
      .update(input.contentFingerprint)
      .digest('hex')
      .slice(0, 32);
    const key = `note-exports/${input.ownerID}/${input.noteID}/${contentHash}-${input.filename}`;
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

  /**
   * 分享链接功能开关：只认 NOTE_SHARE_WEB_BASE。`/s/{token}` 落地页必须由它指向的
   * 站点提供；TEMP_CHAT_WEB_BASE 那个站（temp-chat-web）只路由 /t/:token，拿它兜底
   * 只会生成打不开的链接，所以不算「已配置」。
   */
  private shareLinksEnabled(): boolean {
    const base = this.config.get<string>('NOTE_SHARE_WEB_BASE');
    return typeof base === 'string' && base.trim().length > 0;
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
    assertUrlsFromStorage(urls, this.storagePublicObjectBases, 'media url');
  }

  /**
   * 落库用的持久 url。NoteMedia.url 是非空列，而 presign 对私有目录（notes/）不再返回
   * fileUrl —— 客户端只拿得到 objectKey，这里按站内对象基址（写入恒用 canonical，即
   * storagePublicObjectBases[0]，与 UploadService 的 publicObjectBase 同源）补出来。
   * 读取路径本来就按 objectKey 现签短时 GET，这个值只用于归一、去重与存量数据兼容。
   *
   * 客户端给了 url 就照旧，只 strip 掉 edit 回传的签名 query；来源校验仍归
   * {@link assertMediaUrlsAreSafe}，归属校验仍归 {@link assertMediaOwnership}。
   */
  private resolveMediaUrl(item: { url?: string; objectKey?: string }): string {
    if (typeof item.url === 'string' && item.url) {
      return item.url.split('?')[0];
    }
    const base = this.storagePublicObjectBases[0];
    // 对象存储没配时上传本来就是关的，拿不到合法 objectKey —— 与其写一条拼不出来的
    // 地址进非空列，不如当场 400 说清楚。
    if (!base || typeof item.objectKey !== 'string' || !item.objectKey) {
      throw new BadRequestException(
        'media url is required when it cannot be derived from objectKey',
      );
    }
    return `${base}/${item.objectKey}`;
  }

  private buildMediaStats(media: CreateNoteDto['media']) {
    const imageCount = media.filter((item) => item.type === 'IMAGE').length;
    const videoCount = media.filter((item) => item.type === 'VIDEO').length;
    const audioCount = media.filter((item) => item.type === 'AUDIO').length;

    return {
      imageCount,
      videoCount,
      audioCount,
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

  /**
   * Cards are snapshots, but the client may only attach people and circles it
   * can currently address. Resolve the display fields on the server so a
   * crafted request cannot put somebody else's name or avatar in a note.
   */
  private async canonicalizeNoteCards<T extends { sections?: NoteSectionsDto }>(
    ownerID: string,
    input: T,
    existingSections?: unknown,
  ): Promise<T> {
    const contacts = input.sections?.contacts?.items ?? [];
    const groups = input.sections?.groups?.items ?? [];
    if (!contacts.length && !groups.length) return input;

    const stored = this.isRecord(existingSections) ? existingSections : {};
    const existingCards = (section: string) => {
      const value = this.isRecord(stored[section]) ? stored[section] : {};
      return new Map<string, NoteCardSnapshot>(
        (Array.isArray(value.items) ? value.items : [])
          .filter(
            (item) =>
              this.isRecord(item) &&
              typeof item.id === 'string' &&
              typeof item.name === 'string',
          )
          .map((item) => [
            item.id,
            {
              id: item.id,
              name: item.name,
              faceURL: item.faceURL ?? null,
              ...(section === 'groups' && typeof item.circleId === 'string'
                ? { circleId: item.circleId }
                : {}),
              ...(section === 'groups' &&
              typeof item.conversationID === 'string'
                ? { conversationID: item.conversationID }
                : {}),
            },
          ]),
      );
    };
    const contactsById = existingCards('contacts');
    const groupsById = existingCards('groups');
    const contactIds = [...new Set(contacts.map((item) => item.id))].filter(
      (id) => !contactsById.has(id),
    );
    const canonicalContactIds = [
      ...new Set(contactIds.map(normalizeUserIdAlias)),
    ];
    const groupIds = [...new Set(groups.map((item) => item.id))].filter(
      (id) => !groupsById.has(id),
    );
    const [friendRows, circleRows] = await Promise.all([
      contactIds.length
        ? this.prisma.friend.findMany({
            where: {
              state: 'ACCEPTED',
              OR: [
                { userID: ownerID, friendID: { in: canonicalContactIds } },
                { userID: { in: canonicalContactIds }, friendID: ownerID },
              ],
            },
            include: { user: true, friend: true },
          })
        : Promise.resolve([]),
      groupIds.length
        ? this.prisma.circle.findMany({
            where: {
              deleted: false,
              AND: [
                {
                  OR: [{ id: { in: groupIds } }, { groupID: { in: groupIds } }],
                },
                {
                  OR: [
                    { ownerID },
                    {
                      members: { some: { userID: ownerID, status: 'ACTIVE' } },
                    },
                  ],
                },
              ],
            },
            select: { id: true, groupID: true, name: true, avatarUrl: true },
          })
        : Promise.resolve([]),
    ]);

    for (const row of friendRows) {
      const person = row.userID === ownerID ? row.friend : row.user;
      for (const id of contactIds.filter(
        (id) => normalizeUserIdAlias(id) === person.id,
      )) {
        contactsById.set(id, {
          id,
          name: person.nickname || person.accountId,
          faceURL: person.avatarUrl ?? null,
        });
      }
    }
    // A user may add their own card without needing a friendship row.
    if (canonicalContactIds.includes(ownerID)) {
      const self = await this.prisma.user.findUnique({
        where: { id: ownerID },
        select: { id: true, nickname: true, accountId: true, avatarUrl: true },
      });
      if (self) {
        for (const id of contactIds.filter(
          (id) => normalizeUserIdAlias(id) === self.id,
        )) {
          contactsById.set(id, {
            id,
            name: self.nickname || self.accountId,
            faceURL: self.avatarUrl ?? null,
          });
        }
      }
    }
    if (contacts.some((item) => !contactsById.has(item.id))) {
      throw new ForbiddenException(
        'Contact card target is not an accepted friend',
      );
    }

    for (const id of groupIds) {
      const circle = circleRows.find(
        (row) => row.id === id || row.groupID === id,
      );
      if (circle)
        // Never merge the request card: even id === circle.id must drop a
        // forged source.circleId instead of retaining it through a spread.
        groupsById.set(id, {
          id,
          ...(circle.id !== id ? { circleId: circle.id } : {}),
          name: circle.name,
          faceURL: circle.avatarUrl ?? null,
        });
    }
    // 群名片挂的是群聊，不只是圈子群：圈子里没找到的 id 再按独立群聊
    // （circleID 为空的 GROUP 会话）认，卡片 id 就是会话 id，与收藏笔记写入的
    // 来源群名片同一口径。本人还在群里（leftAt 为空）才算可访问。
    const standaloneGroupIds = groupIds.filter((id) => !groupsById.has(id));
    if (standaloneGroupIds.length) {
      const conversations = await this.prisma.chatConversation.findMany({
        where: {
          id: { in: standaloneGroupIds },
          type: 'GROUP',
          circleID: null,
          members: { some: { userID: ownerID, leftAt: null } },
        },
        select: { id: true, name: true, avatarUrl: true },
      });
      for (const conversation of conversations) {
        // 独立群可以没有群名（客户端按成员昵称兜底），这时沿用请求里展示的名字；
        // 能走到这里已经证明本人在群里，名字不涉及越权。
        const requestedName = groups
          .find((item) => item.id === conversation.id)
          ?.name.trim();
        const name = conversation.name?.trim() || requestedName;
        if (!name) continue;
        groupsById.set(conversation.id, {
          id: conversation.id,
          name,
          faceURL: conversation.avatarUrl ?? null,
          // 卡片 id 本身就是会话 id；显式标出来，客户端才分得清这是独立群
          // 而不是圈子 id（圈子群名片永远不带这个字段）。
          conversationID: conversation.id,
        });
      }
    }
    if (groups.some((item) => !groupsById.has(item.id))) {
      throw this.groupBindForbidden();
    }

    return {
      ...input,
      sections: {
        ...input.sections,
        contacts: contacts.length
          ? { items: contacts.map((item) => contactsById.get(item.id)!) }
          : input.sections?.contacts,
        groups: groups.length
          ? { items: groups.map((item) => groupsById.get(item.id)!) }
          : input.sections?.groups,
      },
    };
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
    sectionName: 'media' | 'showcase' | 'audio',
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
      if ((sectionName === 'audio') !== (resolved.type === 'AUDIO')) {
        throw new BadRequestException(
          `${sectionName} section has an incompatible media type`,
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
    const hasExplicitAudio = this.hasSectionMediaItems(
      sectionInput?.audio?.items,
    );
    const ordinaryFallback = derived.media.filter(
      (item) => item.type !== 'AUDIO',
    );
    const mediaItems = this.resolveSectionMediaItems(
      'media',
      sectionInput?.media?.items,
      hasExplicitShowcase ? [] : ordinaryFallback,
      derived.media,
    );
    const showcaseItems = this.resolveSectionMediaItems(
      'showcase',
      sectionInput?.showcase?.items,
      hasExplicitMedia
        ? []
        : ordinaryFallback.filter((item) => item.type === 'IMAGE'),
      derived.media,
    );
    const audioItems = this.resolveSectionMediaItems(
      'audio',
      sectionInput?.audio?.items,
      hasExplicitAudio
        ? []
        : derived.media.filter((item) => item.type === 'AUDIO'),
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
      ...(sectionInput?.audio || audioItems.length > 0
        ? { audio: { items: audioItems } }
        : {}),
      ...(sectionInput?.contacts
        ? {
            contacts: {
              items: (sectionInput.contacts.items ?? []).map((item) => ({
                id: item.id,
                name: item.name,
                faceURL: item.faceURL ?? null,
              })),
            },
          }
        : {}),
      ...(sectionInput?.groups
        ? {
            groups: {
              items: (sectionInput.groups.items ?? []).map((item) => ({
                id: item.id,
                ...((item as unknown as NoteCardSnapshot).circleId
                  ? { circleId: (item as unknown as NoteCardSnapshot).circleId }
                  : {}),
                ...((item as unknown as NoteCardSnapshot).conversationID
                  ? {
                      conversationID: (item as unknown as NoteCardSnapshot)
                        .conversationID,
                    }
                  : {}),
                name: item.name,
                faceURL: item.faceURL ?? null,
              })),
            },
          }
        : {}),
      location: this.normalizeLocation(sectionInput?.location),
    } as NoteSections;
  }

  /**
   * 卡片预览是**单行**文案（客户端 numberOfLines=2）。正文里的 \t（表格列分隔）、
   * \n（块分隔）和任何控制字符一律先折成一个空格再切 —— 否则表格开头的笔记预览
   * 会被换行撑掉，两行里看不到任何有效内容。
   */
  private buildPreview(content: string | null | undefined) {
    if (!content) return null;
    const flattened = content
      .replace(NOTE_PREVIEW_WHITESPACE_PATTERN, ' ')
      .trim();
    if (!flattened) return null;
    const preview = sliceByCodePoints(flattened, MAX_NOTE_PREVIEW_LENGTH);
    return preview.length < flattened.length ? `${preview}...` : preview;
  }

  /**
   * 行内节点 → 可见文本，段落与表格单元格共用这一套语义。
   * 只认 BlockNote 的两种行内节点：`text` 取 text，`link` 只取内文（href 不进正文）；
   * mention 之类的未知节点一律空串，免得把 props/href 漏进正文。
   * 相邻片段直接拼接不补空格 —— 它们本来就是同一段文字的连续样式片段。
   */
  private extractInlineText(node: unknown, depth = 0): string {
    if (depth > MAX_NOTE_BLOCK_DEPTH) return '';
    if (Array.isArray(node)) {
      return node
        .map((item) => this.extractInlineText(item, depth + 1))
        .join('');
    }
    if (!this.isRecord(node)) return '';
    // BNStyledText: { type: 'text', text: string, styles: {...} }
    if (node.type === 'text') {
      return typeof node.text === 'string' ? node.text : '';
    }
    // BNLink: { type: 'link', href: string, content: BNStyledText[] }
    if (node.type === 'link') {
      return this.extractInlineText(node.content, depth + 1);
    }
    return '';
  }

  /** 单元格既可能是行内数组（旧结构），也可能是 tableCell 包装（新结构）。 */
  private extractTableCellText(cell: unknown): string {
    const inline =
      this.isRecord(cell) && cell.type === 'tableCell' ? cell.content : cell;
    return this.extractInlineText(inline).trim();
  }

  /**
   * 表格 → 一行一个 \t 分隔的文本行。**逐格 trim，每个 \t 都留着**：整行 trim 会
   * 吃掉首/尾空单元格的分隔符，两列表就退化成一列，导出与预览全部错位。
   * 整行皆空才丢掉这一行。
   */
  private extractTableText(content: unknown): string {
    if (!this.isRecord(content)) return '';
    const rows = Array.isArray(content.rows) ? content.rows : [];
    const lines: string[] = [];

    for (const row of rows) {
      if (!this.isRecord(row) || !Array.isArray(row.cells)) continue;
      const cells = row.cells.map((cell) => this.extractTableCellText(cell));
      if (cells.some(Boolean)) {
        lines.push(cells.join(NOTE_TABLE_CELL_SEPARATOR));
      }
    }

    return lines.join(NOTE_LINE_SEPARATOR);
  }

  /** 每个块产出至多一个片段，调用方按 \n 拼接（见 {@link NOTE_LINE_SEPARATOR}）。 */
  private extractBlockText(
    blocks: NoteContentBlock[] | undefined,
    depth = 0,
  ): string[] {
    if (!blocks?.length || depth > MAX_NOTE_BLOCK_DEPTH) return [];

    const fragments: string[] = [];

    for (const block of blocks) {
      if (!this.isRecord(block)) continue;
      const text =
        block.type === 'table'
          ? this.extractTableText(block.content)
          : this.extractInlineText(block.content).trim();
      if (text) fragments.push(text);

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

          // 只要有 objectKey 就收下：url 缺省或为 null（App 把私有目录的
          // presign.fileUrl 原样透传时就是 null）由 resolveMediaUrl 按 key 推导，
          // 与 media[] 同一条口径。没有 objectKey 的块无从校验归属，照旧跳过。
          if (objectKey) {
            media.push({
              type: block.type === 'video' ? 'VIDEO' : 'IMAGE',
              objectKey,
              url: url || undefined,
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
    const sectionAudio = input.sections?.audio?.items ?? [];
    const sectionMediaCombined = this.dedupeMedia([
      ...sectionMedia,
      ...sectionShowcase,
      ...sectionAudio,
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
    if (derivedMedia.length > MAX_NOTE_MEDIA_ITEMS) {
      throw new BadRequestException(
        `Note media limit is ${MAX_NOTE_MEDIA_ITEMS} items across all sections`,
      );
    }

    // 客户端 edit 时会回传读到的签名 url；写入前 strip 掉 query，只存持久 base url
    //（读取时才现签短时 URL）。base url 本无 query，strip 无副作用。没带 url 的按
    // objectKey 补出来，见 resolveMediaUrl。
    derivedMedia = derivedMedia.map((item) => ({
      ...item,
      url: this.resolveMediaUrl(item),
      ...(typeof (item as { posterUrl?: unknown }).posterUrl === 'string'
        ? {
            posterUrl: (item as { posterUrl: string }).posterUrl.split('?')[0],
          }
        : {}),
    }));

    // 片段本身已逐块/逐格 trim 过，这里**不能**再 trim 整段：首个单元格为空时正文
    // 以 \t 开头，整段 trim 会把它的列位吃掉，两列表退化成一列。
    const blockContent = extractedText.join(NOTE_LINE_SEPARATOR);
    const derivedContent =
      blocks.length > 0
        ? blockContent || (sectionText?.content ?? input.content ?? '').trim()
        : (sectionText?.content ?? input.content ?? '').trim();
    const derivedTitle = input.title.trim();
    const normalized = {
      contentJson: blocks.length > 0 ? blocks : null,
      title: sliceByCodePoints(derivedTitle, MAX_NOTE_TITLE_LENGTH),
      content: derivedContent
        ? sliceByCodePoints(derivedContent, MAX_NOTE_CONTENT_LENGTH)
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

  private resolvePublishedBlocks(
    blocks: unknown,
    note: NoteRow,
    presignedUrls?: Map<string, string>,
  ): Record<string, unknown>[] | null {
    if (!Array.isArray(blocks)) return null;
    const authorized = new Map(
      (note.media ?? []).map((item) => [item.objectKey, item]),
    );
    const visit = (
      items: unknown[],
      depth: number,
    ): Record<string, unknown>[] => {
      if (depth > MAX_NOTE_BLOCK_DEPTH) return [];
      return items.flatMap((block) => {
        if (!this.isRecord(block)) return [];
        let props = block.props;
        if (
          (block.type === 'image' || block.type === 'video') &&
          this.isRecord(props)
        ) {
          const key =
            typeof props.objectKey === 'string'
              ? props.objectKey
              : this.uploadService?.objectKeyFromPublicUrl(props.url);
          const media = key ? authorized.get(key) : undefined;
          if (media) {
            props = {
              ...props,
              objectKey: media.objectKey,
              url: presignedUrls?.get(media.url) ?? media.url.split('?')[0],
              posterUrl:
                media.posterUrl &&
                !this.isForeignPosterKey(media.objectKey, media.posterUrl)
                  ? (presignedUrls?.get(media.posterUrl) ??
                    media.posterUrl.split('?')[0])
                  : null,
            };
          } else if (key) {
            // Arbitrary legacy JSON must not open another private signing path.
            props = { ...props, url: '', posterUrl: null };
          }
        }
        return [
          {
            ...block,
            ...(props !== undefined ? { props } : {}),
            ...(Array.isArray(block.children)
              ? { children: visit(block.children, depth + 1) }
              : {}),
          },
        ];
      });
    };
    return visit(blocks, 0);
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
    const storedAudio = this.isRecord(stored.audio) ? stored.audio : {};
    const storedContacts = this.isRecord(stored.contacts)
      ? stored.contacts
      : {};
    const storedGroups = this.isRecord(stored.groups) ? stored.groups : {};
    const storedLocation = this.isRecord(stored.location)
      ? stored.location
      : null;
    const hasExplicitMedia = Array.isArray(storedMedia.items);
    const hasExplicitShowcase = Array.isArray(storedShowcase.items);
    const hasExplicitAudio = Array.isArray(storedAudio.items);
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
    const audioItems = hasExplicitAudio
      ? this.applyPresignedToItems(storedAudio.items, presignedUrls)
      : (note.media ?? [])
          .filter((item) => item.type === 'AUDIO')
          .map((item) =>
            this.mapMediaItemForSection(item as any, presignedUrls),
          );
    let contentJson: unknown[] | null = null;
    if (Array.isArray(storedText.contentJson)) {
      contentJson = storedText.contentJson;
    } else if (Array.isArray(note.contentJson)) {
      contentJson = note.contentJson;
    }
    contentJson = this.resolvePublishedBlocks(contentJson, note, presignedUrls);
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
      ...(hasExplicitAudio || audioItems.length > 0
        ? { audio: { items: audioItems } }
        : {}),
      ...(Array.isArray(storedContacts.items)
        ? {
            contacts: {
              items: storedContacts.items.filter((item) => this.isRecord(item)),
            },
          }
        : {}),
      ...(Array.isArray(storedGroups.items)
        ? {
            groups: {
              items: storedGroups.items.filter((item) => this.isRecord(item)),
            },
          }
        : {}),
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
    } as NoteSections;
  }

  /**
   * 列表卡片只需要名片的 id / 名称 / 头像，最多 NOTE_CARD_PREVIEW_LIMIT 个；
   * 缺 id 或名称的历史坏数据直接跳过（点了跳不动，不如不显示）。
   * 群名片额外带 conversationID（独立群才有，否则 null），客户端靠它区分
   * 「打开群聊」还是「打开圈子」；只读库里存的，与详情同一口径。
   */
  private toCardPeers(
    items: Array<Record<string, unknown>> | undefined,
    groups = false,
  ): NoteCardPeerDto[] {
    const peers: NoteCardPeerDto[] = [];
    for (const item of items ?? []) {
      if (peers.length >= NOTE_CARD_PREVIEW_LIMIT) break;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      if (!id || !name) continue;
      const face =
        typeof item.faceURL === 'string' && item.faceURL
          ? item.faceURL
          : typeof item.avatarUrl === 'string' && item.avatarUrl
            ? item.avatarUrl
            : null;
      peers.push({
        id,
        name,
        faceURL: face,
        // 群名片带路由所需的两种 id：独立群的会话 id；旧版圈子卡片的 id 是 OpenIM
        // groupID，规范圈子 UUID 单独存在 circleId（canonicalizeNoteCards 写入）。
        ...(groups
          ? {
              conversationID:
                typeof item.conversationID === 'string' && item.conversationID
                  ? item.conversationID
                  : null,
              circleId:
                typeof item.circleId === 'string' && item.circleId
                  ? item.circleId
                  : null,
            }
          : {}),
      });
    }
    return peers;
  }

  private getSectionAvailability(sections: NoteSections) {
    return {
      hasText:
        Boolean(sections.text.content?.trim()) ||
        Boolean(sections.text.contentJson?.length),
      showcaseCount: sections.showcase.items.length,
      contactCount: sections.contacts?.items.length ?? 0,
      groupCardCount: sections.groups?.items.length ?? 0,
      hasLocation: Boolean(sections.location),
    };
  }

  /** Contact/group blocks are editor-only metadata and must not cross a read projection. */
  private stripPrivateCardBlocks(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value
        .map((item) => this.stripPrivateCardBlocks(item))
        .filter((item) => item !== null);
    }
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (record.type === 'contact' || record.type === 'group') return null;
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        this.stripPrivateCardBlocks(item),
      ]),
    );
  }

  /**
   * A collected copy is a local editing surface, but its availability badge
   * must follow the boss's source note. Resolve the canonical root directly;
   * the bounded chain walk only supports legacy rows without a root key and
   * fails closed if it cannot reach a source.
   */
  private async overlayCollectedSourceState(
    notes: NoteRow[],
  ): Promise<NoteRow[]> {
    const initialIDs = [
      ...new Set(
        notes
          .map((note) => note.rootSourceNoteID ?? note.collectedFromNoteID)
          .filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          ),
      ),
    ];
    if (initialIDs.length === 0) return notes;

    type SourceState = {
      id: string;
      status: NoteStatus;
      available: boolean;
      workStatus: NoteWorkStatus | null;
      collectedFromNoteID: string | null;
      rootSourceNoteID: string | null;
    };
    const states = new Map<string, SourceState>();
    const queried = new Set<string>();
    let frontier = initialIDs;
    for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
      const ids = frontier.filter((id) => !queried.has(id));
      if (ids.length === 0) break;
      ids.forEach((id) => queried.add(id));
      const rows =
        (await this.prisma.note.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            status: true,
            available: true,
            workStatus: true,
            collectedFromNoteID: true,
            rootSourceNoteID: true,
          },
        })) ?? [];
      frontier = rows
        .map((row) => row.rootSourceNoteID ?? row.collectedFromNoteID)
        .filter(
          (id): id is string => typeof id === 'string' && !queried.has(id),
        );
      rows.forEach((row) => states.set(row.id, row));
    }

    // 收录链上的笔记被永久删除（回收站「立即删除」或 30 天到期清理）后整行消失，
    // 但 collectedFromNoteID 是普通列、仍指着它。查过却查不到的来源只能是被硬删了，
    // 按 DELETED 处理：不能因为「找不到父级」就退回副本自己的 ACTIVE 状态，
    // 让第三方在原笔记删除后还能读、分享、导出、再收藏副本。
    const purgedSource = (id: string): SourceState => ({
      id,
      status: 'DELETED',
      available: false,
      workStatus: null,
      collectedFromNoteID: null,
      rootSourceNoteID: null,
    });
    const rootState = (id: string): SourceState | null => {
      let current = states.get(id) ?? null;
      if (!current) return queried.has(id) ? purgedSource(id) : null;
      const seen = new Set<string>();
      while (
        (current.rootSourceNoteID ?? current.collectedFromNoteID) &&
        !seen.has(current.id)
      ) {
        const parentID =
          current.rootSourceNoteID ?? current.collectedFromNoteID!;
        seen.add(current.id);
        const parent = states.get(parentID);
        if (!parent) {
          // A missing parent is either hard-deleted or beyond the bounded
          // legacy walk. Neither may fall back to a local ACTIVE snapshot.
          return purgedSource(parentID);
        }
        current = parent;
      }
      return current;
    };

    return notes.map((note) => {
      if (!note.collectedFromNoteID) return note;
      const source = rootState(
        note.rootSourceNoteID ?? note.collectedFromNoteID,
      );
      return source
        ? {
            ...note,
            status: source.status,
            available: source.available,
            workStatus: source.workStatus,
          }
        : note;
    });
  }

  /**
   * Non-owner gate for collected copies. A copy keeps its own row (stored as
   * ACTIVE/available), so the row-level `readableByViewer` filter alone would
   * let anyone keep reading, exporting, forwarding or re-collecting it after
   * the boss unlisted or deleted the source. The live root state decides:
   * outside the owner, a copy is only reachable while its root is ACTIVE and
   * available. CLOSED is a work-status reminder, not a distribution block.
   * Returns the note with the root state overlaid.
   */
  private async requireDistributableForViewer(
    note: NoteRow,
    viewerID: string | null,
  ): Promise<NoteRow> {
    const [effective] = await this.overlayCollectedSourceState([note]);
    if (viewerID !== null && note.ownerID === viewerID) return effective;
    if (!this.isDistributable(effective)) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
    return effective;
  }

  /** Root-overlaid state check shared by single reads and share-link lists. */
  private isDistributable(effective: NoteRow): boolean {
    if (!effective.collectedFromNoteID) return true;
    return effective.status === 'ACTIVE' && effective.available;
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
    // 置顶与分组是主人整理自己笔记本的私人标记，与 remark / collectedFrom 一样
    // 不随笔记内容外发：非主人（含分享链接的访客 viewer）恒为 pinned=false、
    // groups=[]。字段名保留，DTO 形状不变。
    const isOwner = note.ownerID === viewerID;
    const groups = isOwner
      ? (note.groupMemberships ?? []).map((membership: any) => ({
          id: membership.group.id,
          name: membership.group.name,
        }))
      : [];
    const fallbackCoverMedia =
      note.media?.find((item) => item.type === 'IMAGE') ?? null;
    const coverMedia =
      note.coverMedia?.type === 'IMAGE' ? note.coverMedia : fallbackCoverMedia;
    const sections = this.buildSectionsFromRow(note, presignedUrls);
    const visibleSections = isOwner
      ? sections
      : ({
          ...sections,
          contacts: { items: [] },
          groups: { items: [] },
        } as NoteSections);
    const availability = this.getSectionAvailability(visibleSections);
    const cardPreview = {
      contacts: this.toCardPeers(visibleSections.contacts?.items),
      groups: this.toCardPeers(visibleSections.groups?.items, true),
    };

    return {
      id: note.id,
      ownerId: note.ownerID,
      canEdit: isOwner,
      title: note.title,
      contentPreview: this.buildPreview(note.content),
      status: note.status,
      available: note.available,
      workStatus: note.workStatus ?? null,
      sourceConversationID: isOwner
        ? (note.sourceConversationID ?? null)
        : null,
      pinned: isOwner ? note.pinned : false,
      // 备注与来源名片同属笔记主人的私人标注，绝不随分享/访客视图外发。
      remark: isOwner ? (note.remark ?? null) : null,
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
      audioCount: note.audioCount ?? 0,
      mediaCount: note.mediaCount,
      ...availability,
      cardPreview,
      // 来源名片是收藏者的私人定位标记：available=true 的笔记任何人都能打开，
      // 但「从哪个群/谁那里收藏的」不能跟着泄漏 —— 只回给笔记主人本人。
      collectedFrom:
        isOwner && this.isRecord(note.collectedFrom)
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
    const visibleSections =
      note.ownerID === viewerID
        ? sections
        : ({
            ...sections,
            contacts: { items: [] },
            groups: { items: [] },
          } as NoteSections);
    const publishedBlocks = this.resolvePublishedBlocks(
      note.contentJson,
      note,
      presignedUrls,
    );
    return {
      ...this.mapSummary(note, viewerID, presignedUrls),
      content: note.content ?? null,
      contentJson: (note.ownerID === viewerID
        ? publishedBlocks
        : this.stripPrivateCardBlocks(
            publishedBlocks,
          )) as NoteDetailDto['contentJson'],
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
      sections: visibleSections as unknown as NoteSectionsResponseDto,
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
    for (const section of ['media', 'showcase', 'audio'] as const) {
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
  // 到窗口 → 同窗口签出字节相同 URL（缓存稳定）。签名失败必须 fail closed，避免把私有
  // 对象的未签名持久 URL 返回给客户端。
  private async presignNoteMedia(
    targets: { url: string; objectKey: string }[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!targets.length) return map;
    if (!this.uploadService) {
      throw new ServiceUnavailableException(
        'Private note media is temporarily unavailable',
      );
    }
    // 同 base url 去重（同图可能出现在 media 行 + sections JSON 两处）。
    const byUrl = new Map<string, string>();
    for (const t of targets) byUrl.set(t.url, t.objectKey);
    const signingDate = new Date(
      Math.floor(Date.now() / NOTE_MEDIA_URL_WINDOW_MS) *
        NOTE_MEDIA_URL_WINDOW_MS,
    );
    try {
      await Promise.all(
        [...byUrl.entries()].map(async ([url, key]) => {
          const signed = await this.uploadService!.createPresignedGetUrl(
            key,
            NOTE_MEDIA_URL_TTL_SECONDS,
            signingDate,
          );
          map.set(url, signed.url);
        }),
      );
    } catch {
      throw new ServiceUnavailableException(
        'Private note media is temporarily unavailable',
      );
    }
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
  /**
   * 旧版圈子群名片的 id 是 OpenIM groupID，规范圈子 UUID 只有在保存时才会被
   * canonicalizeNoteCards 写进 circleId；从没再保存过的老卡片没有它，客户端就
   * 没法按圈子路由。读取时按 Circle.groupID 批量补上（只改内存里的行，不落库）。
   * 带 circleId 或 conversationID（独立群）的卡片不动。
   */
  private async withLegacyCircleIds(notes: NoteRow[]): Promise<NoteRow[]> {
    const legacyIds = new Set<string>();
    const legacyItems = (note: NoteRow) => {
      const sections = this.isRecord(note.sections) ? note.sections : null;
      const groups =
        sections && this.isRecord(sections.groups) ? sections.groups : null;
      return groups && Array.isArray(groups.items)
        ? groups.items.filter(
            (item): item is Record<string, unknown> =>
              this.isRecord(item) &&
              typeof item.id === 'string' &&
              !item.circleId &&
              !item.conversationID,
          )
        : [];
    };
    for (const note of notes) {
      for (const item of legacyItems(note)) legacyIds.add(item.id as string);
    }
    if (legacyIds.size === 0) return notes;
    const circles =
      (await this.prisma.circle.findMany({
        where: { groupID: { in: [...legacyIds] } },
        select: { id: true, groupID: true },
      })) ?? [];
    const circleIdByGroupID = new Map(
      circles.flatMap((circle) =>
        circle.groupID ? [[circle.groupID, circle.id] as const] : [],
      ),
    );
    if (circleIdByGroupID.size === 0) return notes;
    return notes.map((note) => {
      if (legacyItems(note).length === 0) return note;
      const sections = note.sections as Record<string, unknown>;
      const groups = sections.groups as { items: unknown[] };
      return {
        ...note,
        sections: {
          ...sections,
          groups: {
            ...groups,
            items: groups.items.map((item) => {
              if (!this.isRecord(item) || typeof item.id !== 'string') {
                return item;
              }
              const circleId =
                !item.circleId && !item.conversationID
                  ? circleIdByGroupID.get(item.id)
                  : undefined;
              return circleId ? { ...item, circleId } : item;
            }),
          },
        },
      };
    });
  }

  private async mapDetailResolved(
    note: NoteRow,
    viewerID: string,
  ): Promise<NoteDetailDto> {
    const [overlaid] = await this.overlayCollectedSourceState([note]);
    const [effectiveNote] = await this.withLegacyCircleIds([overlaid]);
    const presigned = await this.presignNoteMedia(
      this.collectNoteMediaTargets(effectiveNote),
    );
    return this.mapDetail(effectiveNote, viewerID, presigned);
  }

  private async mapSummaryListResolved(
    notes: NoteRow[],
    viewerID: string,
  ): Promise<NoteSummaryDto[]> {
    const effectiveNotes = await this.withLegacyCircleIds(
      await this.overlayCollectedSourceState(notes),
    );
    const presigned = await this.presignNoteMedia(
      effectiveNotes.flatMap((note) => this.collectNoteMediaTargets(note)),
    );
    return effectiveNotes.map((note) =>
      this.mapSummary(note, viewerID, presigned),
    );
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
    // A response/signing failure after commit must be safe to retry with the same ID.
    const replay = await this.publishedDraftNote(
      this.prisma,
      ownerID,
      input.clientDraftID,
      null,
    );
    if (replay) return this.mapDetailResolved(replay, ownerID);
    const uniqueGroupIds = [...new Set(input.groupIds ?? [])];
    await this.requireOwnedGroups(ownerID, uniqueGroupIds);

    const binding = await this.resolveGroupCardBinding(ownerID, input);
    const canonicalInput = await this.canonicalizeNoteCards(
      ownerID,
      binding ? this.withGroupCard(input, binding.card) : input,
    );
    const derived = this.deriveNoteContent(canonicalInput);
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

    const created = await runSerializableTransaction(
      this.prisma,
      async (tx) => {
        await this.membershipPolicy.lockUsers(tx, [ownerID]);
        const replay = await this.publishedDraftNote(
          tx,
          ownerID,
          canonicalInput.clientDraftID,
          null,
        );
        if (replay) return replay;
        if (canonicalInput.clientDraftID)
          await this.consumeNoteDraft(
            tx,
            ownerID,
            canonicalInput.clientDraftID,
            null,
          );
        await this.assertNoteStorageAvailable(tx, ownerID);
        if (binding?.conversationID) {
          await this.assertCanBindGroup(ownerID, binding.conversationID, tx);
        }

        const note = await tx.note.create({
          data: {
            ownerID,
            clientDraftID: canonicalInput.clientDraftID ?? null,
            title: derived.title,
            content: derived.content,
            contentJson: toPrismaJson(derived.contentJson),
            sections: toPrismaJson(derived.sections),
            sourceConversationID: binding?.conversationID ?? null,
            groupID: null,
            status: canonicalInput.status ?? 'ACTIVE',
            available: true,
            pinned: canonicalInput.pinned ?? false,
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

        const saved = await tx.note.update({
          where: { id: note.id },
          data: {
            coverMediaID,
          },
          include: NOTE_INCLUDE,
        });
        if (canonicalInput.clientDraftID) {
          await tx.noteDraft.update({
            where: {
              ownerID_clientDraftID: {
                ownerID,
                clientDraftID: canonicalInput.clientDraftID,
              },
            },
            data: { publishedNoteID: saved.id },
          });
        }
        return saved;
      },
    );

    return this.mapDetailResolved(created, ownerID);
  }

  async listNotes(
    ownerID: string,
    query: ListNotesQueryDto,
  ): Promise<NoteSummaryPage> {
    if (query.groupId) {
      await this.requireOwnedGroup(ownerID, query.groupId);
    }

    const limit = query.limit ?? NOTE_LIST_DEFAULT_LIMIT;
    const page = query.page ?? 1;

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
      // 多取一行只为判断 hasMore，不返回给调用方。
      take: limit + 1,
      skip: (page - 1) * limit,
    });

    return this.toSummaryPage(notes, limit, ownerID);
  }

  /** 多取的那一行先截掉再映射：它不返回，也不必为它签名媒体 URL。 */
  private async toSummaryPage(
    notes: NoteRow[],
    limit: number,
    viewerID: string,
  ): Promise<NoteSummaryPage> {
    const hasMore = notes.length > limit;
    const items = await this.mapSummaryListResolved(
      hasMore ? notes.slice(0, limit) : notes,
      viewerID,
    );
    return { items, hasMore };
  }

  async createShareLink(
    ownerID: string,
    dto: CreateNoteShareLinkDto,
  ): Promise<NoteShareLinkDto> {
    // 功能未配置时在写库之前直接 404：不留下一堆打不开的链接行。
    if (!this.shareLinksEnabled()) {
      throw new NotFoundException({
        message: 'Share links are unavailable',
        errorCode: NoteErrorCode.ShareLinkUnavailable,
      });
    }

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
          // pg_advisory_xact_lock returns PostgreSQL `void`. Prisma's PG adapter
          // cannot deserialize a raw `void` column (P2010), so cast the result to
          // a supported scalar while keeping the same transaction-scoped lock.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${quotaLockKey}))::text`;
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

        logBusinessEvent(this.logger, {
          enabled: this.loggingConfig.businessLogOn,
          businessEvent: 'note_share_link_created',
          actorId: ownerID,
          result: 'success',
          entityType: 'note_share_link',
          entityId: row.id,
          metadata: { noteCount: noteIDs.length },
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

    // 不存在 / 已吊销 / 已过期 / 分享功能未配置 → 同一个 404，且都在查笔记之前短路。
    // 功能开关放在查链接之后判断：关闭时与未知 token 走同一条路径（同样一次按 token
    // 的查找、同样的响应体），公开端点探测不出部署是否开了分享。
    if (
      !this.shareLinksEnabled() ||
      !link ||
      link.revokedAt !== null ||
      (link.expiresAt !== null && link.expiresAt.getTime() <= Date.now())
    ) {
      throw this.shareLinkInvalid();
    }

    const notes = await this.prisma.note.findMany({
      where: this.buildShareLinkNoteFilter(link),
      include: NOTE_INCLUDE,
      // 只按新近排序：置顶是主人的私人标记，访客摘要里 pinned 恒为 false；若仍按
      // pinned desc 排，配合摘要里的 updatedAt 就能反推出哪些被置顶。
      orderBy: [{ updatedAt: 'desc' }],
      take: SHARE_LINK_MAX_NOTES,
    });

    // 链接的过滤条件只看每一行自己存的状态；副本还要按来源实时状态过一遍，
    // 来源下架/删除后副本不能再经分享链接外流。
    const effectiveNotes = await this.overlayCollectedSourceState(notes);
    const distributableNotes = notes.filter((_note, index) =>
      this.isDistributable(effectiveNotes[index]),
    );

    return {
      title: link.title,
      notes: await this.mapSummaryListResolved(
        distributableNotes,
        SHARE_LINK_GUEST_VIEWER,
      ),
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
      // status 快照只可能是 ACTIVE / UNLISTED（NOTE_WRITABLE_STATUS）。没存快照时只露
      // ACTIVE：UNLISTED 是主人藏起来的笔记，与 getNote 的非主人分支、访客读卡片同一
      // 口径；主人显式存了 UNLISTED 快照才按快照放行。
      status: link.status ?? ('ACTIVE' as const),
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
    if (count > 0) {
      logBusinessEvent(this.logger, {
        enabled: this.loggingConfig.businessLogOn,
        businessEvent: 'note_share_link_revoked',
        actorId: ownerID,
        result: 'success',
        entityType: 'note_share_link',
        entityId: linkId,
      });
      return;
    }

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

  /**
   * 「谁能凭 UUID 读到这条笔记」的唯一口径：主人读自己的任何未删笔记；其他人
   * 只能读 available 且 ACTIVE 的。UNLISTED 以前只是「不出现在列表里」——
   * available=true 的 UNLISTED 笔记任何人拿到 UUID 就能读、能收藏、能导出、
   * 能复制媒体，主人特意隐藏的内容其实并没有藏住。四条读路径共用这一片段，
   * 免得日后某一条又悄悄放宽。
   */
  private readableByViewer(viewerID: string): Prisma.NoteWhereInput {
    return {
      OR: [{ ownerID: viewerID }, { available: true, status: 'ACTIVE' }],
    };
  }

  async getNote(ownerID: string, noteId: string): Promise<NoteDetailDto> {
    const note = await this.prisma.note.findFirst({
      where: {
        id: noteId,
        status: { not: 'DELETED' },
        ...this.readableByViewer(ownerID),
      },
      include: NOTE_INCLUDE,
    });

    if (!note) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }

    await this.requireDistributableForViewer(note, ownerID);
    return this.mapDetailResolved(note, ownerID);
  }

  /**
   * 把笔记指定分区的媒体复制进请求者的 chat/{userId}/ 命名空间,供其作为
   * 图片/视频消息发送。聊天发送校验只认发送者自己的 key(防「借聊天读路径
   * 给他人私有对象无限续签」),所以转发笔记媒体必须真实拷贝而不是引用。
   * 单请求最多 ~100 个对象(两个分区各 50 上限),复制按下方常量限并发。
   *
   * 读取授权与 getNote 完全一致(readableByViewer:自己的笔记,或 available 且 ACTIVE 的笔记)。
   * sections JSON 里的 item 只有 objectKey 能对回本笔记 media 行时才算数 ——
   * 行在写入侧做过属主/豁免校验,挡住把外部 key 冻进 JSON 借拷贝洗白的路。
   * 拷贝出的对象生命周期归聊天侧:撤回/焚毁按消息 key 删,与笔记原件互不影响。
   */
  async copyNoteMediaForChat(
    viewerID: string,
    noteId: string,
    sections: NoteChatMediaSection[],
  ): Promise<NoteChatMediaImportDto> {
    const uploadService = this.uploadService;
    if (!uploadService) {
      throw new ServiceUnavailableException(
        'Chat media copy is not configured',
      );
    }

    const note = await this.prisma.note.findFirst({
      where: {
        id: noteId,
        status: { not: 'DELETED' },
        ...this.readableByViewer(viewerID),
      },
      include: NOTE_INCLUDE,
    });
    if (!note) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
    await this.requireDistributableForViewer(note, viewerID);

    const rowByKey = new Map<string, NoteMediaRow>();
    for (const row of note.media ?? []) rowByKey.set(row.objectKey, row);

    // buildSectionsFromRow 统一 legacy 语义(没有显式 sections 的老笔记:
    // media=全部行、showcase=图片行),这里不重复发明第二套回退。
    const resolved = this.buildSectionsFromRow(note as NoteRow);
    const requested = NOTE_CHAT_MEDIA_SECTION.filter((section) =>
      sections.includes(section),
    );
    const targets: Array<{
      row: NoteMediaRow;
      section: NoteChatMediaSection;
    }> = [];
    const seen = new Set<string>();
    for (const section of requested) {
      for (const item of resolved[section].items) {
        const objectKey = this.isRecord(item) ? item.objectKey : null;
        if (typeof objectKey !== 'string') continue;
        const row = rowByKey.get(objectKey);
        if (!row || seen.has(objectKey)) continue;
        seen.add(objectKey);
        targets.push({ row, section });
      }
    }

    // 有界并发 + 单条失败不拖垮整批:一条笔记最多 media+showcase 各 50 个对象,
    // 无界 Promise.all 会对 MinIO 一口气开百连接;而任一条 CopyObject 失败若让
    // 整个请求 500,已复制成功的兄弟对象会变成永远无消息引用的孤儿(StorageAudit
    // 只报告不删),客户端重试还会再铸一批新 key 的孤儿。所以逐块复制、单条失败
    // 跳过该条(成功的照常返回并被发送引用);全军覆没才把首个错误抛出去。
    const items: NoteChatMediaItemDto[] = [];
    let firstCopyError: unknown = null;
    for (
      let start = 0;
      start < targets.length;
      start += NOTE_CHAT_MEDIA_COPY_CONCURRENCY
    ) {
      const chunk = targets.slice(
        start,
        start + NOTE_CHAT_MEDIA_COPY_CONCURRENCY,
      );
      const copied = await Promise.all(
        chunk.map(async ({ row, section }) => {
          const ext = /\.([A-Za-z0-9]{1,8})$/.exec(row.objectKey)?.[1];
          const fingerprint = createHash('sha256')
            .update(viewerID)
            .update('\0')
            .update(noteId)
            .update('\0')
            .update(row.id)
            .update('\0')
            .update(row.objectKey)
            .digest('hex');
          const destKey = `${CHAT_MEDIA_KEY_PREFIX}${viewerID}/${CHAT_NOTE_IMPORT_SEGMENT}${fingerprint}${
            ext ? `.${ext.toLowerCase()}` : ''
          }`;
          try {
            const nextAttemptAt = new Date(
              Date.now() + CHAT_NOTE_IMPORT_RESERVATION_MS,
            );
            await this.prisma.$transaction(async (tx) => {
              // 与删除 worker 共用同一把 key 锁。若过期 reservation 正被清理,
              // 先等它结束再续租并复制；否则「刚复制完」的对象可能被旧 worker 删掉。
              await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${destKey}))`;
              // 锁只覆盖 worker 的认领事务,不覆盖它随后在事务外做的对象删除。
              // 认领行带着「删除中」标记和一段未到期租约:此刻复用这行、开始复制,
              // 飞行中的删除就可能把刚复制好的对象删掉。所以直接拒绝,让客户端
              // 稍后重试(租约最多 5 分钟)。已到期的认领说明 worker 中途挂了,
              // 退避中的失败记录则没有在飞的删除,两者都可以照常改写成预留。
              const existing = await tx.chatMediaDeletion.findUnique({
                where: { objectKey: destKey },
                select: { lastError: true, nextAttemptAt: true },
              });
              if (
                existing?.lastError === CHAT_MEDIA_DELETE_CLAIM_REASON &&
                existing.nextAttemptAt.getTime() > Date.now()
              ) {
                throw noteImportRecyclingConflict();
              }
              await tx.chatMediaDeletion.upsert({
                where: { objectKey: destKey },
                create: {
                  objectKey: destKey,
                  attempts: 0,
                  lastError: CHAT_NOTE_IMPORT_RESERVATION_REASON,
                  nextAttemptAt,
                },
                update: {
                  attempts: 0,
                  lastError: CHAT_NOTE_IMPORT_RESERVATION_REASON,
                  nextAttemptAt,
                },
              });
            });
            await uploadService.copyObjectToKey(row.objectKey, destKey);
            // 预留是一行 chatMediaDeletion(不是随事务释放的 advisory lock),所以
            // 复制期间它一直有效。但复制本身要花时间,如果不续租,「写消息 + 建
            // 引用」这一段就得跟复制共用同一个到期时间;复制慢一点就会贴着边缘跑。
            // 复制成功后重新计时,让后续步骤拿到完整窗口。只续我们自己那一行:
            // lastError 不再是预留标记,说明它已经变成一条真的待删记录。
            const renewed = await this.prisma.chatMediaDeletion.updateMany({
              where: {
                objectKey: destKey,
                lastError: CHAT_NOTE_IMPORT_RESERVATION_REASON,
              },
              data: {
                nextAttemptAt: new Date(
                  Date.now() + CHAT_NOTE_IMPORT_RESERVATION_MS,
                ),
              },
            });
            if (renewed.count === 0) {
              // 复制拖过了预留窗口(15 分钟),这行已经到期并被 worker 认领/回收。
              // 返回一个没有可靠预留兜底的 key 只会让随后的发消息撞上
              // 「Note media import has expired」;不如现在就以可重试的冲突失败。
              this.logger.warn({
                message: 'note import reservation lost during copy',
                event: 'note_import_reservation_lost',
                noteId,
                mediaId: row.id,
              });
              throw noteImportRecyclingConflict();
            }
          } catch (error) {
            firstCopyError ??= error;
            this.logger.warn(
              `note chat-media copy failed note=${noteId} media=${row.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          }
          return {
            id: row.id,
            section,
            type: row.type,
            key: destKey,
            width: row.width ?? null,
            height: row.height ?? null,
            durationMs: row.durationMs ?? null,
            size: row.size ?? null,
            mimeType: row.mimeType ?? null,
          };
        }),
      );
      for (const item of copied) {
        if (item) items.push(item);
      }
    }

    if (targets.length > 0 && items.length === 0) {
      // 一条都没复制成功:大概率存储整体不可用,把真实原因抛给统一异常层。
      throw firstCopyError instanceof Error
        ? firstCopyError
        : new ServiceUnavailableException('Chat media copy failed');
    }

    return { items, failedCount: targets.length - items.length };
  }

  /**
   * 已由聊天层证明「请求者持有包含这张卡片的会话」后读取详情。
   * 笔记主人仍可随时通过 available=false 或删除让旧卡片失效。
   */
  async getSharedNoteForGuest(noteId: string): Promise<NoteDetailDto> {
    // 访客没有「自己的笔记」分支：与 readableByViewer 的非主人分支同口径，
    // 只放行 ACTIVE 且 available 的笔记，UNLISTED 不可读。
    const note = await this.prisma.note.findFirst({
      where: {
        id: noteId,
        status: 'ACTIVE',
        available: true,
      },
      include: NOTE_INCLUDE,
    });

    if (!note) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
    // 访客没有主人身份：副本的来源被下架/删除后同样不可读。
    await this.requireDistributableForViewer(note, null);

    // 固定访客 viewer：不可编辑，也不会带出主人私有的 collectedFrom 定位信息。
    return this.mapDetailResolved(note, SHARE_LINK_GUEST_VIEWER);
  }

  /**
   * 来源名片的头像由客户端上报，会原样展示在收藏者的笔记上。不拒绝请求（群 / 好友
   * 头像可能来自任何地方），但只保留本站存储的地址：外链头像是追踪 / 钓鱼载体，
   * 存 null 让客户端回落默认头像。存储未配置时无从判断，原样保留 —— 与
   * assertUrlsFromStorage 的口径一致。
   */
  private storageFaceUrlOrNull(url: string | undefined): string | null {
    if (!url) return null;
    if (this.storagePublicObjectBases.length === 0) return url;
    return isUrlFromStorage(url, this.storagePublicObjectBases) ? url : null;
  }

  /**
   * Prefer the server-stamped cards from the exact chat message that triggered
   * collection. The request still carries a legacy fallback for old messages,
   * but a client cannot replace a newer immutable relay snapshot by editing the
   * collect request body.
   */
  private async resolveCollectedFromMessageSnapshot(
    viewerID: string,
    noteID: string,
    source: NoteCollectSourceDto,
  ): Promise<NoteCollectSourceDto> {
    // A public note does not grant access to the private message that shared it.
    // Reuse the history/forward visibility gate, including membership, clear
    // watermarks, revocation and burn expiry, before reading any card snapshot.
    const { row, conversation } = await this.chat.requireVisibleMessage(
      viewerID,
      source.clientMsgID,
    );
    const content = row.content as Record<string, unknown> | null;
    if (
      row.conversationID !== source.conversationID ||
      row.type !== 'note-card' ||
      !content ||
      Array.isArray(content) ||
      typeof content !== 'object' ||
      content.noteId !== noteID
    ) {
      throw new NotFoundException({
        message: 'Note source message not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }

    const normalizePeer = (
      value: unknown,
      expectedID?: string | null,
    ): NoteCollectPeerDto | null => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
      const card = value as Record<string, unknown>;
      const id = typeof card.id === 'string' ? card.id.trim() : '';
      const name = typeof card.name === 'string' ? card.name.trim() : '';
      if (!id || !name || (expectedID && id !== expectedID)) return null;
      return {
        id,
        name,
        faceURL:
          this.storageFaceUrlOrNull(
            typeof card.faceURL === 'string' ? card.faceURL : undefined,
          ) ?? undefined,
      };
    };

    const sender = normalizePeer(
      content.personalCardSnapshot ?? source.sender,
      typeof row.senderID === 'string' ? row.senderID : null,
    );
    if (!sender || !row.senderID) {
      throw new BadRequestException('Invalid note source sender');
    }
    const group =
      normalizePeer(content.sourceGroupCardSnapshot) ??
      (conversation.type === 'GROUP'
        ? normalizePeer(source.group, conversation.circleID ?? conversation.id)
        : null);
    return {
      conversationType: conversation.type === 'DIRECT' ? 'private' : 'group',
      conversationID: row.conversationID,
      clientMsgID: row.id,
      sender,
      ...(group ? { group } : {}),
    };
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
        faceURL: this.storageFaceUrlOrNull(source.sender.faceURL),
      },
      group: source.group
        ? {
            id: source.group.id,
            name: source.group.name,
            faceURL: this.storageFaceUrlOrNull(source.group.faceURL),
          }
        : null,
      sourceNoteId: note.id,
      sourceOwnerId: note.ownerID,
      collectedAt: new Date().toISOString(),
    };
  }

  /**
   * A collected note carries the previous sender's personal card as its default
   * editable contact card. The chat/group card is an origin snapshot: preserve
   * one that already exists and seed it only on the first collection from a
   * group, so later hops cannot replace the boss group's card with the relay
   * group. These cards stay in the owner's private note sections; read
   * projections strip them for chat/detail viewers.
   */
  /** Resolve the immutable source group when the boss associated the note with
   * a managed group. If the association is absent (legacy notes), the chat
   * collect context remains the only available fallback. */
  private async resolveOriginGroupCard(
    note: Pick<NoteRow, 'sourceConversationID'>,
    fallback: NoteCollectSourceDto['group'],
    unnamedGroupName?: string,
  ): Promise<OriginGroupCard | null | undefined> {
    const chatConversation = (this.prisma as any).chatConversation;
    if (!note.sourceConversationID) {
      if (!fallback) return fallback;
      // 旧笔记没有绑定，只能用聊天里带来的群。它若确实是独立群（按 id 查到
      // circleID 为空的 GROUP 会话），补上服务端核实过的 conversationID；
      // 请求里的字段一律不收。
      const card = {
        id: fallback.id,
        name: fallback.name,
        ...(fallback.faceURL ? { faceURL: fallback.faceURL } : {}),
      };
      const row = chatConversation?.findUnique
        ? await chatConversation.findUnique({
            where: { id: fallback.id },
            select: { type: true, circleID: true },
          })
        : null;
      return row?.type === 'GROUP' && row.circleID === null
        ? { ...card, conversationID: fallback.id }
        : card;
    }
    if (!chatConversation?.findUnique) return null;
    const conversation = await chatConversation.findUnique({
      where: { id: note.sourceConversationID },
      select: { type: true, circleID: true, name: true, avatarUrl: true },
    });
    if (!conversation || conversation.type !== 'GROUP') return null;
    if (conversation.circleID) {
      const circle = (this.prisma as any).circle;
      if (!circle?.findUnique) return null;
      const row = await circle.findUnique({
        where: { id: conversation.circleID },
        select: { id: true, name: true, avatarUrl: true },
      });
      return row
        ? { id: row.id, name: row.name, faceURL: row.avatarUrl ?? undefined }
        : null;
    }
    // 独立群可以没有群名：调用方核实过本人在群里时，会把客户端展示的名字
    // 作为兜底传进来（与 canonicalizeNoteCards 同一口径）；收藏路径不传。
    const name =
      (typeof conversation.name === 'string' ? conversation.name.trim() : '') ||
      unnamedGroupName?.trim();
    if (!name) return null;
    return {
      id: note.sourceConversationID,
      name,
      faceURL: conversation.avatarUrl ?? undefined,
      conversationID: note.sourceConversationID,
    };
  }

  /**
   * 收藏时把原笔记的群名片换成收藏者自己视角的：独立群名片的名字可能是原主人的
   * 私人群备注，或用群成员昵称拼的兜底名（无名群），原样复制会外泄给收藏者。
   * - 收藏者不在那个独立群里：去掉这张名片（回落到他收藏时所在的群）；
   * - 收藏者在群里：群有名字用群名，否则按收藏者自己的备注 / 成员昵称重新兜底。
   * 圈子群的名字是公开信息，原样保留。卡片是不是独立群以库里的会话为准。
   */
  private async groupCardsForCollector(
    collectorID: string,
    sections: unknown,
  ): Promise<unknown> {
    if (!this.isRecord(sections) || !this.isRecord(sections.groups)) {
      return sections;
    }
    const items = Array.isArray(sections.groups.items)
      ? sections.groups.items.filter((item) => this.isRecord(item))
      : [];
    const ids = items
      .map((item) => item.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (ids.length === 0) return sections;
    const standalone =
      (await this.prisma.chatConversation.findMany({
        where: { id: { in: ids }, type: 'GROUP', circleID: null },
        select: { id: true, name: true },
      })) ?? [];
    if (standalone.length === 0) return sections;
    const seats =
      (await this.prisma.chatMember.findMany({
        where: {
          conversationID: { in: standalone.map((row) => row.id) },
          userID: collectorID,
          leftAt: null,
        },
        select: { conversationID: true },
      })) ?? [];
    const memberOf = new Set(seats.map((seat) => seat.conversationID));
    const byId = new Map(standalone.map((row) => [row.id, row]));
    const next: Array<Record<string, unknown>> = [];
    for (const item of items) {
      const conversation =
        typeof item.id === 'string' ? byId.get(item.id) : undefined;
      if (!conversation) {
        next.push(item);
        continue;
      }
      if (!memberOf.has(conversation.id)) continue;
      const name =
        conversation.name?.trim() ||
        (await this.unnamedGroupLabel(collectorID, conversation.id));
      if (!name) continue;
      next.push({ ...item, name, conversationID: conversation.id });
    }
    const { groups: _dropped, ...rest } = sections;
    return next.length > 0 ? { ...rest, groups: { items: next } } : rest;
  }

  private applyCollectSourceCards(
    sections: unknown,
    source: NoteCollectSourceDto,
    originGroup?: OriginGroupCard | null,
    inheritedPersonalCard?: Record<string, unknown> | null,
  ): unknown {
    const stored = this.isRecord(sections) ? sections : {};
    const inheritedId =
      inheritedPersonalCard && typeof inheritedPersonalCard.id === 'string'
        ? inheritedPersonalCard.id.trim()
        : '';
    const inheritedName =
      inheritedPersonalCard && typeof inheritedPersonalCard.name === 'string'
        ? inheritedPersonalCard.name.trim()
        : '';
    const sender =
      inheritedId && inheritedName
        ? {
            id: inheritedId,
            name: inheritedName,
            faceURL: this.storageFaceUrlOrNull(
              typeof inheritedPersonalCard?.faceURL === 'string'
                ? inheritedPersonalCard.faceURL
                : undefined,
            ),
          }
        : {
            id: source.sender.id,
            name: source.sender.name,
            faceURL: this.storageFaceUrlOrNull(source.sender.faceURL),
          };
    const storedGroups = this.isRecord(stored.groups) ? stored.groups : null;
    const groupItems =
      storedGroups && Array.isArray(storedGroups.items)
        ? storedGroups.items.filter((item) => this.isRecord(item))
        : [];
    const groupSource = originGroup === undefined ? source.group : originGroup;
    const seededGroup = groupSource
      ? {
          id: groupSource.id,
          name: groupSource.name,
          faceURL: this.storageFaceUrlOrNull(groupSource.faceURL),
          // 只有 resolveOriginGroupCard 核实过的独立群才带；source.group
          // 是请求体，原样回落时不会有这个字段。
          ...(originGroup?.conversationID
            ? { conversationID: originGroup.conversationID }
            : {}),
        }
      : null;

    return {
      ...stored,
      // Every new hop starts with the person who shared this message. The
      // owner may edit this card afterwards; an idempotent refresh leaves it
      // untouched (see refreshCollectedNote below).
      contacts: { items: [sender] },
      ...(groupItems.length > 0
        ? { groups: storedGroups }
        : seededGroup
          ? { groups: { items: [seededGroup] } }
          : {}),
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
      audio: rewriteSection(sections.audio),
    };
  }

  private async refreshCollectedNote(
    tx: Prisma.TransactionClient,
    userID: string,
    sourceNoteID: string,
    collectedFrom: Record<string, unknown>,
    options?: { title?: string; targetNoteGroupId?: string | null },
  ): Promise<NoteRow | null> {
    const existing = await tx.note.findFirst({
      where: {
        ownerID: userID,
        collectedFromNoteID: sourceNoteID,
        status: { not: 'DELETED' },
      },
      select: { id: true },
    });
    if (!existing) return null;

    if (
      options &&
      Object.prototype.hasOwnProperty.call(options, 'targetNoteGroupId')
    ) {
      if (options.targetNoteGroupId) {
        const group = await tx.noteGroup.findFirst({
          where: {
            id: options.targetNoteGroupId,
            ownerID: userID,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!group) {
          throw new NotFoundException({
            message: 'Note group not found',
            errorCode: NoteErrorCode.GroupNotFound,
          });
        }
        await tx.noteGroupMembership.upsert({
          where: { noteID_groupID: { noteID: existing.id, groupID: group.id } },
          create: { noteID: existing.id, groupID: group.id },
          update: {},
        });
      } else {
        await tx.noteGroupMembership.deleteMany({
          where: { noteID: existing.id },
        });
      }
    }

    return tx.note.update({
      where: {
        id: existing.id,
        ownerID: userID,
        status: { not: 'DELETED' },
      },
      data: {
        collectedFrom: toPrismaJson(collectedFrom),
        ...(options?.title ? { title: options.title } : {}),
      },
      include: NOTE_INCLUDE,
    });
  }

  /**
   * 聊天里收藏笔记 → 直接进"我的笔记"：把可读的他人笔记快照复制成一条自己的
   * 笔记（媒体行复用同一份存储对象，不搬字节），并记录 collectedFrom 来源名片
   * （群聊记群名片、私聊记发送者名片 + 消息 clientMsgID，供跳回聊天定位）。
   *
   * 幂等：自己的笔记不复制直接返回；同一原笔记重复收藏只刷新来源快照。
   * 并发重复收藏由数据库唯一索引兜底，冲突后重读已有副本。
   */
  /**
   * Batched live status for chat note cards. Each id resolves through the
   * collect chain to its root, so a card for any hop reports the boss's
   * current state. Ids the viewer cannot read come back as UNLISTED/UNSET,
   * which is indistinguishable from a missing note.
   */
  async getSourceStates(
    viewerID: string,
    noteIds: string[],
  ): Promise<NoteSourceStateDto[]> {
    const ids = [...new Set(noteIds)];
    const rows = (await this.prisma.note.findMany({
      where: {
        id: { in: ids },
        status: { not: 'DELETED' },
        ...this.readableByViewer(viewerID),
      },
      select: {
        id: true,
        ownerID: true,
        status: true,
        available: true,
        workStatus: true,
        collectedFromNoteID: true,
      },
    })) as unknown as NoteRow[];
    const effective = await this.overlayCollectedSourceState(rows);
    const byId = new Map(effective.map((note) => [note.id, note]));

    return ids.map((noteId) => {
      const note = byId.get(noteId);
      if (!note) {
        return { noteId, workStatus: 'UNSET', publicationStatus: 'UNLISTED' };
      }
      const publicationStatus: NoteSourceStateDto['publicationStatus'] =
        note.status === 'DELETED'
          ? 'DELETED'
          : note.status === 'ACTIVE' && note.available
            ? 'ACTIVE'
            : 'UNLISTED';
      const revealWorkStatus =
        publicationStatus === 'ACTIVE' || note.ownerID === viewerID;
      return {
        noteId,
        workStatus: revealWorkStatus ? (note.workStatus ?? 'UNSET') : 'UNSET',
        publicationStatus,
      };
    });
  }

  async collectNote(
    userID: string,
    dto: CollectNoteDto,
  ): Promise<CollectNoteResultDto> {
    const source = await this.prisma.note.findFirst({
      where: {
        id: dto.noteId,
        status: { not: 'DELETED' },
        ...this.readableByViewer(userID),
      },
      include: NOTE_INCLUDE,
    });

    if (!source) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }

    const effectiveSource = await this.requireDistributableForViewer(
      source,
      userID,
    );

    // 自己的笔记本来就在"我的笔记"里 —— 不复制、不打来源标（来源名片只对
    // 收藏他人笔记有意义）。
    if (source.ownerID === userID) {
      return {
        note: await this.mapDetailResolved(source, userID),
        alreadyCollected: true,
      };
    }

    const effectiveCollectSource =
      await this.resolveCollectedFromMessageSnapshot(
        userID,
        source.id,
        dto.source,
      );
    const collectedFrom = this.buildCollectedFrom(
      effectiveCollectSource,
      source,
    );
    const collectedTitle = dto.title?.trim() || source.title;

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

    const originGroup = await this.resolveOriginGroupCard(
      source,
      effectiveCollectSource.group,
    );
    const rawSourceSections: unknown = source.sections;
    const storedSourceSections = this.isRecord(rawSourceSections)
      ? rawSourceSections
      : null;
    const storedSourceContacts =
      storedSourceSections && this.isRecord(storedSourceSections.contacts)
        ? storedSourceSections.contacts
        : null;
    const sourceContacts = storedSourceContacts?.items;
    const inheritedPersonalCard =
      source.collectedFromNoteID && Array.isArray(sourceContacts)
        ? (sourceContacts.find((item) => this.isRecord(item)) ?? null)
        : null;
    const copiedSections = this.applyCollectSourceCards(
      await this.groupCardsForCollector(
        userID,
        this.rewriteCollectedSectionMediaIds(source.sections, media),
      ),
      effectiveCollectSource,
      originGroup,
      inheritedPersonalCard,
    );

    try {
      const result = await runSerializableTransaction(
        this.prisma,
        async (tx) => {
          await this.membershipPolicy.lockUsers(tx, [userID]);

          const refreshed = await this.refreshCollectedNote(
            tx,
            userID,
            dto.noteId,
            collectedFrom,
            { title: collectedTitle, targetNoteGroupId: dto.targetNoteGroupId },
          );
          if (refreshed) {
            return { note: refreshed, alreadyCollected: true };
          }

          await this.assertNoteStorageAvailable(tx, userID);

          const note = await tx.note.create({
            data: {
              ownerID: userID,
              title: collectedTitle,
              content: source.content,
              contentJson: toPrismaJson(source.contentJson),
              sections: toPrismaJson(copiedSections),
              groupID: null,
              status: 'ACTIVE',
              available: true,
              workStatus: effectiveSource.workStatus ?? null,
              pinned: false,
              imageCount: source.imageCount,
              videoCount: source.videoCount,
              audioCount: source.audioCount ?? 0,
              mediaCount: source.mediaCount,
              collectedFrom: toPrismaJson(collectedFrom),
              collectedFromNoteID: source.id,
              rootSourceNoteID: source.rootSourceNoteID ?? source.id,
            },
          });

          if (dto.targetNoteGroupId) {
            const group = await tx.noteGroup.findFirst({
              where: {
                id: dto.targetNoteGroupId,
                ownerID: userID,
                deletedAt: null,
              },
              select: { id: true },
            });
            if (!group) {
              throw new NotFoundException({
                message: 'Note group not found',
                errorCode: NoteErrorCode.GroupNotFound,
              });
            }
            await tx.noteGroupMembership.create({
              data: { noteID: note.id, groupID: group.id },
            });
          }

          if (media.length > 0) {
            await tx.noteMedia.createMany({
              data: media.map(({ sourceMediaID: _sourceMediaID, ...item }) => ({
                ...item,
                noteID: note.id,
              })),
            });
          }

          const created = await tx.note.update({
            where: { id: note.id },
            data: { coverMediaID },
            include: NOTE_INCLUDE,
          });
          return { note: created, alreadyCollected: false };
        },
      );

      return {
        note: await this.mapDetailResolved(result.note, userID),
        alreadyCollected: result.alreadyCollected,
      };
    } catch (error) {
      if (prismaErrorCode(error) === 'P2002') {
        const refreshed = await runSerializableTransaction(
          this.prisma,
          async (tx) => {
            await this.membershipPolicy.lockUsers(tx, [userID]);
            return this.refreshCollectedNote(
              tx,
              userID,
              dto.noteId,
              collectedFrom,
              {
                title: collectedTitle,
                targetNoteGroupId: dto.targetNoteGroupId,
              },
            );
          },
        );
        if (refreshed) {
          return {
            note: await this.mapDetailResolved(refreshed, userID),
            alreadyCollected: true,
          };
        }
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
        ...this.readableByViewer(viewerID),
      },
      include: NOTE_INCLUDE,
    });

    if (!note) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
    await this.requireDistributableForViewer(note, viewerID);

    const basename = sanitizeFilenamePart(note.title);
    if (input.format === 'IMAGE' || input.format === 'PDF') {
      // 导出件里嵌的 URL 也要现签：notes/* 已不再匿名可读，原始直链对收件人是 403。
      // 与其它读取路径同一条流水线（collect → presign → map）。
      const mediaTargets = this.collectNoteMediaTargets(note);
      const presignedUrls = await this.presignNoteMedia(mediaTargets);
      // 指纹取自笔记修订与媒体对象 key,不能取自 body —— presignedUrls 每次都变。
      const contentFingerprint = this.exportFingerprint(
        note,
        mediaTargets.map((target) => target.objectKey),
      );
      return input.format === 'IMAGE'
        ? this.uploadExportArtifact({
            ownerID: note.ownerID,
            noteID: note.id,
            filename: `${basename}.svg`,
            mimeType: 'image/svg+xml',
            body: await this.createLongImageSvg(note, presignedUrls),
            contentFingerprint,
          })
        : this.uploadExportArtifact({
            ownerID: note.ownerID,
            noteID: note.id,
            filename: `${basename}.pdf`,
            mimeType: 'application/pdf',
            body: await this.createPdf(note, presignedUrls),
            contentFingerprint,
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
      // 这条路径的 body 是真实媒体字节、本来就稳定,但仍走同一套指纹:
      // 免得 createZip 里任何时间戳类字段悄悄把 key 变成一次性的。
      contentFingerprint: this.exportFingerprint(
        note,
        selected.map((item) => item.objectKey),
      ),
    });
  }

  async updateNote(
    ownerID: string,
    noteId: string,
    input: UpdateNoteDto,
  ): Promise<NoteDetailDto> {
    const replay = await this.publishedDraftNote(
      this.prisma,
      ownerID,
      input.clientDraftID,
      noteId,
    );
    if (replay) return this.mapDetailResolved(replay, ownerID);
    const uniqueGroupIds = [...new Set(input.groupIds ?? [])];
    await this.requireOwnedGroups(ownerID, uniqueGroupIds);

    const existingNote = await this.prisma.note.findFirst({
      where: { id: noteId, ownerID, status: { not: 'DELETED' } },
      select: {
        sections: true,
        collectedFromNoteID: true,
        sourceConversationID: true,
      },
    });
    if (!existingNote) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
    // 收藏副本的来源群名片是固定的，不参与绑定；源笔记的群名片即绑定。
    const binding = existingNote.collectedFromNoteID
      ? undefined
      : await this.resolveGroupCardBinding(ownerID, input, existingNote);
    const canonicalInput = await this.canonicalizeNoteCards(
      ownerID,
      binding ? this.withGroupCard(input, binding.card) : input,
      existingNote.sections,
    );
    const derived = this.deriveNoteContent(canonicalInput);
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
      await this.membershipPolicy.lockUsers(tx, [ownerID]);
      const replay = await this.publishedDraftNote(
        tx,
        ownerID,
        canonicalInput.clientDraftID,
        noteId,
      );
      if (replay) return replay;
      // Re-verify ownership inside the transaction to prevent TOCTOU races
      // where a concurrent delete could cause this update to un-delete the note.
      // 锁住笔记行（READ COMMITTED 下等锁后读到最新值）：与「笔记管理」换绑
      // （setSourceConversation 同样锁这一行）互斥，否则这里按旧 sections 保留的
      // 群名片会和对方刚写的 sourceConversationID 错位。笔记行不是热点行。
      const [existing] = await tx.$queryRaw<
        Array<{
          id: string;
          status: NoteStatus;
          sections: unknown;
          collectedFromNoteID: string | null;
          sourceConversationID: string | null;
        }>
      >`
        SELECT "id", "status", "sections", "collectedFromNoteID",
               "sourceConversationID"
        FROM "Note"
        WHERE "id" = ${noteId} AND "ownerID" = ${ownerID}
          AND "status" <> 'DELETED'
        FOR UPDATE`;
      if (!existing) {
        throw new NotFoundException({
          message: 'Note not found',
          errorCode: NoteErrorCode.NotFound,
        });
      }

      if (binding?.conversationID) {
        await this.assertCanBindGroup(ownerID, binding.conversationID, tx);
      }

      if (canonicalInput.clientDraftID) {
        await this.assertNoteEditOutcomeCapacity(tx, ownerID, noteId);
        await this.consumeNoteDraft(
          tx,
          ownerID,
          canonicalInput.clientDraftID,
          noteId,
        );
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

      const saved = await tx.note.update({
        where: { id: noteId },
        data: {
          title: derived.title,
          content: derived.content,
          contentJson: toPrismaJson(derived.contentJson),
          sections: toPrismaJson(
            !binding &&
              (existing.collectedFromNoteID || existing.sourceConversationID)
              ? this.preserveManagedGroupCard(
                  derived.sections,
                  existing.sections,
                )
              : derived.sections,
          ),
          ...(binding ? { sourceConversationID: binding.conversationID } : {}),
          groupID: null,
          // Preserve the existing status when the caller omits it — omitting
          // status on a PATCH must not silently promote an UNLISTED note to ACTIVE.
          status: canonicalInput.status ?? existing.status,
          pinned: canonicalInput.pinned ?? false,
          coverMediaID,
          ...counts,
        },
        include: NOTE_INCLUDE,
      });
      if (canonicalInput.clientDraftID) {
        await tx.noteDraft.update({
          where: {
            ownerID_clientDraftID: {
              ownerID,
              clientDraftID: canonicalInput.clientDraftID,
            },
          },
          data: { publishedNoteID: saved.id },
        });
      }
      return saved;
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

  async setRemark(ownerID: string, noteId: string, remark: string | null) {
    await this.requireOwnedNote(ownerID, noteId);
    const trimmed = remark?.trim() ?? '';
    // Include ownerID + status guard in the write to close the TOCTOU window.
    return this.prisma.note.update({
      where: { id: noteId, ownerID, status: { not: 'DELETED' } },
      data: { remark: trimmed.length > 0 ? trimmed : null },
      select: {
        id: true,
        remark: true,
      },
    });
  }

  async setAvailable(ownerID: string, noteId: string, available: boolean) {
    const owned = await this.requireOwnedNote(ownerID, noteId);
    const rootNoteID = this.noteRootID(owned);
    // Include ownerID + status guard in the write to close the TOCTOU window.
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.note.update({
        where: { id: noteId, ownerID, status: { not: 'DELETED' } },
        data: { available },
        select: {
          id: true,
          available: true,
        },
      });
      await this.enqueueSourceStatusFanout(tx, rootNoteID);
      return result;
    });
  }

  async setWorkStatus(
    ownerID: string,
    noteId: string,
    workStatus: NoteWorkStatus | null,
  ) {
    const owned = await this.requireOwnedSourceNote(ownerID, noteId);
    const rootNoteID = this.noteRootID(owned);
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.note.update({
        where: { id: noteId, ownerID, status: { not: 'DELETED' } },
        data: { workStatus },
        select: { id: true, workStatus: true },
      });
      await this.enqueueSourceStatusFanout(tx, rootNoteID);
      return result;
    });
  }

  /**
   * 没有群名的独立群在「笔记管理」绑定时没有客户端展示名可用：先用本人的群备注
   * （只有自己看得见，与客户端会话列表同一优先级），否则取最早入群的三位成员
   * 昵称拼成名字。只在会话本身没名字时才会被用到。
   */
  private async unnamedGroupLabel(
    viewerID: string,
    conversationID: string,
  ): Promise<string | undefined> {
    const own = await this.prisma.chatMember.findUnique({
      where: { conversationID_userID: { conversationID, userID: viewerID } },
      select: { remark: true },
    });
    const remark = own?.remark?.trim();
    if (remark) return this.clampGroupCardName(remark);
    const seats = await this.prisma.chatMember.findMany({
      where: { conversationID, leftAt: null },
      orderBy: { joinedAt: 'asc' },
      take: UNNAMED_GROUP_LABEL_MEMBERS,
      select: { userID: true },
    });
    if (!seats.length) return undefined;
    const users = await this.prisma.user.findMany({
      where: { id: { in: seats.map((seat) => seat.userID) } },
      select: { id: true, nickname: true, accountId: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    const label = seats
      .map((seat) => {
        const user = byId.get(seat.userID);
        return user ? user.nickname?.trim() || user.accountId : '';
      })
      .filter(Boolean)
      .join('、');
    return label ? this.clampGroupCardName(label) : undefined;
  }

  /**
   * 兜底名会原样回到客户端、下次保存再提交上来；超过 DTO 上限的话这篇笔记就再也
   * 存不进去了（三个 50 字昵称拼起来就超）。按码点截断，与校验同口径。
   */
  private clampGroupCardName(name: string): string {
    return Array.from(name).slice(0, NOTE_GROUP_CARD_NAME_MAX).join('').trim();
  }

  /**
   * 只有群主能把笔记绑到群上：独立群看会话群主且本人座位仍在（解散只置 leftAt、
   * 不动 ownerID），圈子群看圈主且圈子可用（未删除、未处于停用/解散中间态，
   * 与 ensureCircleConversation 同一口径）。
   *
   * 传 tx 时是写笔记那个事务里的复核，用普通读、不加行锁：会话行每发一条消息都会
   * 更新 nextHeight，座位行每次已读/送达都会更新，圈子行随成员数变化 —— 在这些热点
   * 行上 FOR SHARE，SERIALIZABLE 下几乎必然撞序列化失败，READ COMMITTED 下又会和
   * 「先锁会话、后锁用户」的群管理路径成环死锁。普通读在 SERIALIZABLE 里由 SSI 在
   * 提交时检测冲突（P2034，自动重试）；剩下「转让/解散/停用恰好与保存同一瞬间提交」
   * 的窗口只会让笔记挂在一个刚变更的群上，不越权、可由新群主在「笔记管理」解绑。
   * 所有拒绝统一成 GroupBindForbidden：不区分「群不存在 / 不可用 / 不是群主」，
   * 避免借错误探测别人的群。
   */
  private async assertCanBindGroup(
    ownerID: string,
    conversationID: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    const conversation = await db.chatConversation.findUnique({
      where: { id: conversationID },
      select: { type: true, ownerID: true, circleID: true },
    });
    let allowed = false;
    if (conversation?.type === 'GROUP' && conversation.circleID) {
      const circle = await db.circle.findUnique({
        where: { id: conversation.circleID },
        select: { ownerID: true, deleted: true, adminState: true },
      });
      allowed = Boolean(
        circle &&
        !circle.deleted &&
        !DISABLED_ADMIN_STATES.has(circle.adminState) &&
        circle.ownerID === ownerID,
      );
    } else if (conversation?.type === 'GROUP') {
      const seat =
        conversation.ownerID === ownerID
          ? await db.chatMember.findUnique({
              where: {
                conversationID_userID: { conversationID, userID: ownerID },
              },
              select: { leftAt: true },
            })
          : null;
      allowed = Boolean(seat && !seat.leftAt);
    }
    if (!allowed) throw this.groupBindForbidden();
  }

  private groupBindForbidden() {
    return new ForbiddenException({
      message: 'Only the owner of an available group can bind it to a note',
      errorCode: NoteErrorCode.GroupBindForbidden,
    });
  }

  /**
   * 圈子群聊会话是懒创建的（第一次有人打开群聊才建）。圈主给还没建会话的
   * 圈子加群名片时，与他打开群聊一样先把会话建出来再绑定，否则会被误判成
   * 「不可访问的群」。只替圈主建：非圈主本来就不能绑，也不该因为随手提交
   * 一个圈子 id 就触发建会话的副作用。解散/停用的圈子 ensure 返回 null。
   */
  private async ensureOwnedCircleConversation(
    ownerID: string,
    cardId: string,
  ): Promise<string | null> {
    if (!this.circleSync) return null;
    const circle = await this.prisma.circle.findFirst({
      where: { deleted: false, OR: [{ id: cardId }, { groupID: cardId }] },
      select: { id: true, ownerID: true },
    });
    if (!circle || circle.ownerID !== ownerID) return null;
    return this.circleSync.ensureCircleConversation(circle.id);
  }

  /**
   * 群名片的 id 有两种口径：圈子群是圈子 id（老数据也可能是 groupID），
   * 独立群是会话 id。绑定要落到会话上，这里统一换算成会话 id。
   */
  private async findGroupConversationIdForCard(
    cardId: string,
  ): Promise<string | null> {
    const conversation = await this.prisma.chatConversation.findFirst({
      where: { type: 'GROUP', OR: [{ id: cardId }, { circleID: cardId }] },
      select: { id: true },
    });
    if (conversation) return conversation.id;
    const circle = await this.prisma.circle.findFirst({
      where: { groupID: cardId, deleted: false },
      select: { id: true },
    });
    if (!circle) return null;
    const circleConversation = await this.prisma.chatConversation.findFirst({
      where: { type: 'GROUP', circleID: circle.id },
      select: { id: true },
    });
    return circleConversation?.id ?? null;
  }

  /**
   * 群名片就是群设置里的「笔记管理」绑定：源笔记发布/更新时，提交的群名片
   * 决定 sourceConversationID。返回 undefined 表示这次不动绑定——没带群名片段、
   * 旧版多张群名片，或群名片没换（换了群主后只改正文也不该被拦下）。
   *
   * 「没换」只看库里已存的名片，与有没有绑定无关：以前群成员也能加群名片，
   * 这类旧笔记有名片而 sourceConversationID 为空，原样带回来保存不能被当成
   * 新绑定去要求群主权限；绑定照旧保持为空。
   */
  private async resolveGroupCardBinding(
    ownerID: string,
    input: { sections?: NoteSectionsDto },
    existing?: { sourceConversationID: string | null; sections: unknown },
  ): Promise<
    { conversationID: string | null; card: NoteCardSnapshot | null } | undefined
  > {
    const section = input.sections?.groups;
    if (!section) return undefined;
    const items = section.items ?? [];
    const stored = this.isRecord(existing?.sections)
      ? existing.sections.groups
      : undefined;
    const storedIds = (
      this.isRecord(stored) && Array.isArray(stored.items) ? stored.items : []
    ).map((item) => (this.isRecord(item) ? item.id : undefined));
    if (items.length === 0) {
      // 旧版「笔记管理」绑定无名独立群时只写了绑定、没存群名片。客户端保存总会
      // 带 groups:{items:[]}，不能因此静默解绑；库里本来就有名片、这次清空了才是解绑。
      return existing?.sourceConversationID && storedIds.length === 0
        ? undefined
        : { conversationID: null, card: null };
    }
    if (items.length > 1) {
      // 一篇笔记只挂一张群名片。多张只为兼容多选时代的存量：全部都是库里已有的
      // 才放行（不动绑定）；夹带新名片会绕过「只有群主能绑」，拒绝。
      if (items.every((item) => storedIds.includes(item.id))) return undefined;
      throw new BadRequestException({
        message: 'A note can carry only one group card',
        errorCode: NoteErrorCode.GroupBindForbidden,
      });
    }
    if (existing) {
      // 已绑定：库里恰好就是这一张才算没换（绑定与名片一一对应）。
      // 未绑定的旧笔记可能存着多张，删到只剩其中一张也不是新绑定。
      const unchanged = existing.sourceConversationID
        ? storedIds.length === 1 && storedIds[0] === items[0].id
        : storedIds.includes(items[0].id);
      if (unchanged) return undefined;
    }
    const conversationID =
      (await this.findGroupConversationIdForCard(items[0].id)) ??
      (await this.ensureOwnedCircleConversation(ownerID, items[0].id));
    if (!conversationID) {
      throw this.groupBindForbidden();
    }
    await this.assertCanBindGroup(ownerID, conversationID);
    // 没有群名的独立群沿用提交的名字；本人是否还在群里由随后的
    // canonicalizeNoteCards 按 leftAt 为空把关，不在就整单 403。
    const card = await this.resolveOriginGroupCard(
      { sourceConversationID: conversationID },
      undefined,
      items[0].name,
    );
    if (!card) {
      throw this.groupBindForbidden();
    }
    // 卡片 id 保留客户端提交的那个：客户端保存后按 id 核对结果，换成规范 id
    // 会被当成「保存结果与提交不一致」。旧版 groupID 由 canonicalizeNoteCards
    // 照旧补上 circleId；群名与头像一律取服务端的。
    return {
      conversationID,
      card: {
        id: items[0].id,
        name: card.name,
        faceURL: card.faceURL ?? null,
      },
    };
  }

  private withGroupCard<T extends { sections?: NoteSectionsDto }>(
    input: T,
    card: NoteCardSnapshot | null,
  ): T {
    return {
      ...input,
      sections: {
        ...input.sections,
        groups: { items: card ? [card] : [] },
      },
    } as T;
  }

  async setSourceConversation(
    ownerID: string,
    noteId: string,
    conversationID: string | null,
  ) {
    await this.requireOwnedSourceNote(ownerID, noteId);
    if (conversationID) {
      await this.assertCanBindGroup(ownerID, conversationID);
    }
    const sourceGroupCard = conversationID
      ? await this.resolveOriginGroupCard(
          { sourceConversationID: conversationID },
          undefined,
          await this.unnamedGroupLabel(ownerID, conversationID),
        )
      : null;
    // 绑定与群名片一一对应：绑上了却拿不到名片（群已不可用）就整单拒绝，
    // 不能留下「有绑定、没名片」的半截状态。
    if (conversationID && !sourceGroupCard) throw this.groupBindForbidden();
    const groupCardSection = sourceGroupCard
      ? {
          items: [
            {
              id: sourceGroupCard.id,
              name: sourceGroupCard.name,
              faceURL: sourceGroupCard.faceURL ?? null,
              ...(sourceGroupCard.conversationID
                ? { conversationID: sourceGroupCard.conversationID }
                : {}),
            },
          ],
        }
      : null;
    return this.prisma.$transaction(async (tx) => {
      // 与 createNote / updateNote 同一口径：群主以写入事务内锁后读到的为准。
      if (conversationID) {
        await this.assertCanBindGroup(ownerID, conversationID, tx);
      }
      // 这里只换群名片，正文/媒体/名片其余部分必须是锁后读到的最新值：
      // 事务外读的 sections 若被并发的普通编辑（PATCH /note/:id）改过，
      // 拿旧 JSON 整体写回会把刚保存的内容冲掉。
      const [locked] = await tx.$queryRaw<Array<{ sections: unknown }>>`
        SELECT "sections" FROM "Note"
        WHERE "id" = ${noteId} AND "ownerID" = ${ownerID}
          AND "status" <> 'DELETED'
        FOR UPDATE`;
      if (!locked) {
        throw new NotFoundException({
          message: 'Note not found',
          errorCode: NoteErrorCode.NotFound,
        });
      }
      const nextSections: Record<string, unknown> = this.isRecord(
        locked.sections,
      )
        ? { ...locked.sections }
        : {};
      if (groupCardSection) nextSections.groups = groupCardSection;
      else delete nextSections.groups;
      return tx.note.update({
        where: { id: noteId, ownerID, status: { not: 'DELETED' } },
        data: {
          sourceConversationID: conversationID,
          sections: toPrismaJson(nextSections),
        },
        select: { id: true, sourceConversationID: true },
      });
    });
  }

  async setStatus(ownerID: string, noteId: string, status: NoteWritableStatus) {
    const owned = await this.requireOwnedNote(ownerID, noteId);
    const rootNoteID = this.noteRootID(owned);
    // Include ownerID + status guard in the write to close the TOCTOU window.
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.note.update({
        where: { id: noteId, ownerID, status: { not: 'DELETED' } },
        data: { status },
        select: {
          id: true,
          status: true,
        },
      });
      await this.enqueueSourceStatusFanout(tx, rootNoteID);
      return result;
    });
  }

  /** FE#92 回收站：已软删笔记列表（新删在前）。 */
  async listDeletedNotes(
    ownerID: string,
    page = 1,
    limit = NOTE_LIST_DEFAULT_LIMIT,
  ): Promise<NoteSummaryPage> {
    const take = Math.min(limit, NOTE_LIST_DEFAULT_LIMIT);
    const notes = await this.prisma.note.findMany({
      where: { ownerID, status: 'DELETED' },
      orderBy: { updatedAt: 'desc' },
      // 多取一行只为判断 hasMore，不返回给调用方。
      take: take + 1,
      skip: (page - 1) * take,
      include: NOTE_INCLUDE,
    });
    return this.toSummaryPage(notes, take, ownerID);
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
      select: {
        id: true,
        collectedFromNoteID: true,
        rootSourceNoteID: true,
      },
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
      result = await runSerializableTransaction(this.prisma, async (tx) => {
        await this.membershipPolicy.lockUsers(tx, [ownerID]);
        // Restoring a soft-deleted note re-consumes a storage slot, so it must
        // pass the same quota gate as create/collect under the user lock —
        // otherwise delete → create replacements → restore old ones grows past
        // the cap, and concurrent restores could cross the boundary together.
        await this.assertNoteStorageAvailable(tx, ownerID);
        const restored = await tx.note.updateMany({
          where: { id: noteId, ownerID, status: 'DELETED' },
          data: { status: 'ACTIVE' },
        });
        if (restored.count > 0) {
          await this.enqueueSourceStatusFanout(tx, this.noteRootID(target));
        }
        return restored;
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

  /**
   * 回收站「立即删除」：不等 30 天，直接永久删除。与到期清理共用
   * purgeDeletedNote（收录链改指向、媒体对象保留等语义见那里）。
   * 只认自己回收站里的笔记（status=DELETED），正常/下架笔记必须先删进回收站。
   */
  async purgeNote(ownerID: string, noteId: string): Promise<void> {
    const removed = await purgeDeletedNote(this.prisma, noteId, { ownerID });
    if (!removed) {
      throw new NotFoundException({
        message: 'Note not found',
        errorCode: NoteErrorCode.NotFound,
      });
    }
  }

  async deleteNote(ownerID: string, noteId: string): Promise<void> {
    const owned = await this.requireOwnedNote(ownerID, noteId);
    const rootNoteID = this.noteRootID(owned);
    // Include ownerID + status in the write to close the TOCTOU window, for
    // parity with setPinned / setAvailable.
    await this.prisma.$transaction(async (tx) => {
      await tx.note.update({
        where: { id: noteId, ownerID, status: { not: 'DELETED' } },
        data: { status: 'DELETED' },
        select: { id: true },
      });
      await this.enqueueSourceStatusFanout(tx, rootNoteID);
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

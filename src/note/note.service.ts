import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'crypto';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertUrlsFromStorage } from 'src/utils/storage-url';
import { prismaErrorCode } from 'src/utils/prisma-tx';
import {
  CreateNoteDto,
  CreateNoteGroupDto,
  CreateNoteShareLinkDto,
  ListNotesQueryDto,
  NoteDetailDto,
  NoteGroupDto,
  NoteMediaType,
  NoteShareLinkDto,
  NoteStatus,
  NoteSummaryDto,
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

function toPrismaJson(value: NoteContentBlock[] | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
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
  status: NoteStatus;
  available: boolean;
  pinned: boolean;
  imageCount: number;
  videoCount: number;
  mediaCount: number;
  createdAt: Date;
  updatedAt: Date;
  coverMedia: { id: string; type: NoteMediaType; url: string } | null;
  groupMemberships: Array<{ group: { id: string; name: string } }>;
  media: NoteMediaRow[];
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

@Injectable()
export class NoteService {
  private readonly minioPublicUrl: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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
      throw new NotFoundException('Note group not found');
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
      throw new NotFoundException('Note group not found');
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
      throw new NotFoundException('Note not found');
    }

    return note;
  }

  private createShareToken(): string {
    return randomBytes(18).toString('base64url');
  }

  private buildShareUrl(token: string): string {
    const base =
      this.config.get<string>('NOTE_SHARE_WEB_BASE') ??
      this.config.get<string>('TEMP_CHAT_WEB_BASE') ??
      '';
    return `${base.replace(/\/+$/, '')}/s/${token}`;
  }

  private assertMediaOwnership(ownerID: string, media: CreateNoteDto['media']) {
    // Presign now generates keys as `notes/{userId}/{uuid}.ext`.
    // Verify both the folder prefix and the user segment so a client cannot
    // reference another user's uploaded media.
    const prefix = `notes/${ownerID}/`;
    const invalid = media.find((item) => !item.objectKey.startsWith(prefix));
    if (invalid) {
      throw new BadRequestException(
        `objectKey must start with notes/${ownerID}/`,
      );
    }
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
      // Table blocks have a BNTableContent object, not an array — skip for text
      const inlines = Array.isArray(block.content) ? block.content : [];

      for (const node of inlines) {
        if (node.type === 'text') {
          // BNStyledText: { type: 'text', text: string, styles: {...} }
          const trimmed = node.text.trim();
          if (trimmed) fragments.push(trimmed);
        } else if (node.type === 'link') {
          // BNLink: { type: 'link', href: string, content: BNStyledText[] }
          // Extract the visible text from the link's inner StyledText nodes
          for (const inner of node.content) {
            const trimmed = inner.text.trim();
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
    const blocks = Array.isArray(input.contentJson) ? input.contentJson : [];
    const extractedText =
      blocks.length > 0 ? this.extractBlockText(blocks) : [];

    // Prefer explicitly provided media — the client sends full metadata including
    // objectKey. Only fall back to block-derived media when input.media is empty
    // (for future server-side use or migration).
    const derivedMedia =
      input.media.length > 0 ? input.media : this.deriveMediaFromBlocks(blocks);

    const derivedContent =
      blocks.length > 0
        ? extractedText.join(' ').trim()
        : (input.content ?? '').trim();
    const derivedTitle =
      blocks.length > 0
        ? (extractedText[0] ?? input.title).trim()
        : input.title.trim();

    return {
      contentJson: blocks.length > 0 ? blocks : null,
      // Truncate: text derived from contentJson bypasses the DTO @MaxLength
      // caps, so enforce them here before the value reaches the DB column.
      title: derivedTitle.slice(0, MAX_NOTE_TITLE_LENGTH),
      content: derivedContent
        ? derivedContent.slice(0, MAX_NOTE_CONTENT_LENGTH)
        : null,
      media: derivedMedia,
    };
  }

  private mapSummary(note: NoteRow, viewerID: string): NoteSummaryDto {
    const groups = (note.groupMemberships ?? []).map((membership: any) => ({
      id: membership.group.id,
      name: membership.group.name,
    }));

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
      cover: note.coverMedia
        ? {
            id: note.coverMedia.id,
            type: note.coverMedia.type,
            url: note.coverMedia.url,
          }
        : note.media?.[0]
          ? {
              id: note.media[0].id,
              type: note.media[0].type,
              url: note.media[0].url,
            }
          : null,
      imageCount: note.imageCount,
      videoCount: note.videoCount,
      mediaCount: note.mediaCount,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  }

  private mapDetail(note: NoteRow, viewerID: string): NoteDetailDto {
    return {
      ...this.mapSummary(note, viewerID),
      content: note.content ?? null,
      contentJson: Array.isArray(note.contentJson) ? note.contentJson : null,
      media: note.media.map((item) => ({
        id: item.id,
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
    };
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

    const coverMediaID = media[0]?.id ?? null;
    const counts = this.buildMediaStats(media);

    const created = await this.prisma.$transaction(async (tx) => {
      const note = await tx.note.create({
        data: {
          ownerID,
          title: derived.title,
          content: derived.content,
          contentJson: toPrismaJson(derived.contentJson),
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

    return this.mapDetail(created, ownerID);
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

    return notes.map((note) => this.mapSummary(note, ownerID));
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
        throw new NotFoundException('Note not found');
      }
    }

    const title = dto.title.trim().slice(0, 120) || '我的笔记';
    const search = dto.search?.trim() || null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = this.createShareToken();
      try {
        const row = await this.prisma.noteShareLink.create({
          data: {
            ownerID,
            token,
            title,
            status: dto.status ?? null,
            group: dto.group ?? null,
            groupID: dto.groupId ?? null,
            search,
            noteIDs,
          },
        });

        return {
          id: row.id,
          token: row.token,
          url: this.buildShareUrl(row.token),
          expiresAt: row.expiresAt,
          revokedAt: row.revokedAt,
          createdAt: row.createdAt,
        };
      } catch (error) {
        if (prismaErrorCode(error) === 'P2002' && attempt < 2) continue;
        throw error;
      }
    }

    throw new ConflictException('Unable to create share link');
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
      throw new NotFoundException('Note not found');
    }

    return this.mapDetail(note, ownerID);
  }

  async updateNote(
    ownerID: string,
    noteId: string,
    input: UpdateNoteDto,
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
    const coverMediaID = media[0]?.id ?? null;
    const counts = this.buildMediaStats(media);

    const updated = await this.prisma.$transaction(async (tx) => {
      // Re-verify ownership inside the transaction to prevent TOCTOU races
      // where a concurrent delete could cause this update to un-delete the note.
      const existing = await tx.note.findFirst({
        where: { id: noteId, ownerID, status: { not: 'DELETED' } },
        select: { id: true, status: true },
      });
      if (!existing) {
        throw new NotFoundException('Note not found');
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

    return this.mapDetail(updated, ownerID);
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
        throw new NotFoundException('Note not found');
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
      throw new ConflictException('Note group already exists');
    }

    if (groupCount >= MAX_GROUPS_PER_USER) {
      throw new BadRequestException(
        `Cannot create more than ${MAX_GROUPS_PER_USER} note groups`,
      );
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
        throw new ConflictException('Note group already exists');
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
      throw new NotFoundException('Note group not found');
    }

    // Only check for name conflicts when the name is actually changing.
    if (group.name !== normalizedName) {
      const conflict = await this.prisma.noteGroup.findFirst({
        where: { ownerID, name: normalizedName, deletedAt: null },
        select: { id: true },
      });
      if (conflict) {
        throw new ConflictException('Note group already exists');
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
        throw new ConflictException('Note group already exists');
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
      throw new NotFoundException('Note group not found');
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

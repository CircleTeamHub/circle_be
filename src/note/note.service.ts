import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CreateNoteDto,
  CreateNoteGroupDto,
  ListNotesQueryDto,
  NoteDetailDto,
  NoteGroupDto,
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

const NOTE_INCLUDE = {
  group: {
    select: {
      id: true,
      name: true,
    },
  },
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
} as const;

const MAX_GROUPS_PER_USER = 50;

@Injectable()
export class NoteService {
  constructor(private readonly prisma: PrismaService) {}

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

  private assertMediaOwnership(
    _ownerID: string,
    media: CreateNoteDto['media'],
  ) {
    // Presign generates keys as `notes/{uuid}.ext` — check the folder prefix only.
    const invalid = media.find((item) => !item.objectKey.startsWith('notes/'));
    if (invalid) {
      throw new BadRequestException('objectKey must start with notes/');
    }
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

    // Prefer explicitly provided media — the client sends full metadata including
    // objectKey. Only fall back to block-derived media when input.media is empty
    // (for future server-side use or migration).
    const derivedMedia =
      input.media.length > 0 ? input.media : this.deriveMediaFromBlocks(blocks);

    const derivedContent =
      blocks.length > 0
        ? this.extractBlockText(blocks).join(' ').trim()
        : (input.content ?? '').trim();
    const derivedTitle = input.title.trim();

    return {
      contentJson: blocks.length > 0 ? blocks : null,
      title: derivedTitle,
      content: derivedContent || null,
      media: derivedMedia,
    };
  }

  private mapSummary(note: any): NoteSummaryDto {
    return {
      id: note.id,
      title: note.title,
      contentPreview: this.buildPreview(note.content),
      status: note.status,
      available: note.available,
      pinned: note.pinned,
      group: note.group
        ? {
            id: note.group.id,
            name: note.group.name,
          }
        : null,
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

  private mapDetail(note: any): NoteDetailDto {
    return {
      ...this.mapSummary(note),
      content: note.content ?? null,
      contentJson: Array.isArray(note.contentJson) ? note.contentJson : null,
      media: (note.media ?? []).map((item: any) => ({
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

  private mapGroup(group: any): NoteGroupDto {
    return {
      id: group.id,
      name: group.name,
      sortOrder: group.sortOrder,
      noteCount: group._count?.notes ?? 0,
    };
  }

  async createNote(
    ownerID: string,
    input: CreateNoteDto,
  ): Promise<NoteDetailDto> {
    if (input.groupId) {
      await this.requireOwnedGroup(ownerID, input.groupId);
    }

    const derived = this.deriveNoteContent(input);
    this.assertMediaOwnership(ownerID, derived.media);

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
          groupID: input.groupId ?? null,
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

      return tx.note.update({
        where: { id: note.id },
        data: {
          coverMediaID,
        },
        include: NOTE_INCLUDE,
      });
    });

    return this.mapDetail(created);
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
        groupID: query.groupId ?? undefined,
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

    return notes.map((note) => this.mapSummary(note));
  }

  async getNote(ownerID: string, noteId: string): Promise<NoteDetailDto> {
    const note = await this.requireOwnedNote(ownerID, noteId);
    return this.mapDetail(note);
  }

  async updateNote(
    ownerID: string,
    noteId: string,
    input: UpdateNoteDto,
  ): Promise<NoteDetailDto> {
    if (input.groupId) {
      await this.requireOwnedGroup(ownerID, input.groupId);
    }

    const derived = this.deriveNoteContent(input);
    this.assertMediaOwnership(ownerID, derived.media);

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
        select: { id: true },
      });
      if (!existing) {
        throw new NotFoundException('Note not found');
      }

      await tx.noteMedia.deleteMany({
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

      return tx.note.update({
        where: { id: noteId },
        data: {
          title: derived.title,
          content: derived.content,
          contentJson: toPrismaJson(derived.contentJson),
          groupID: input.groupId ?? null,
          status: input.status ?? 'ACTIVE',
          pinned: input.pinned ?? false,
          coverMediaID,
          ...counts,
        },
        include: NOTE_INCLUDE,
      });
    });

    return this.mapDetail(updated);
  }

  async setPinned(ownerID: string, noteId: string, pinned: boolean) {
    await this.requireOwnedNote(ownerID, noteId);
    return this.prisma.note.update({
      where: { id: noteId },
      data: { pinned },
      select: {
        id: true,
        pinned: true,
      },
    });
  }

  async setAvailable(ownerID: string, noteId: string, available: boolean) {
    await this.requireOwnedNote(ownerID, noteId);
    return this.prisma.note.update({
      where: { id: noteId },
      data: { available },
      select: {
        id: true,
        available: true,
      },
    });
  }

  async deleteNote(ownerID: string, noteId: string): Promise<void> {
    await this.requireOwnedNote(ownerID, noteId);
    await this.prisma.note.update({
      where: { id: noteId },
      data: { status: 'DELETED' },
      select: { id: true },
    });
  }

  async listGroups(ownerID: string): Promise<NoteGroupDto[]> {
    const groups = await this.prisma.noteGroup.findMany({
      where: {
        ownerID,
        deletedAt: null,
      },
      include: {
        _count: {
          select: {
            notes: { where: { status: { not: 'DELETED' } } },
          },
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

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

    const created = await this.prisma.noteGroup.create({
      data: {
        ownerID,
        name: normalizedName,
      },
    });

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

    const updated = await this.prisma.noteGroup.update({
      where: { id: groupId },
      data: {
        name: input.name.trim(),
      },
      include: {
        _count: {
          select: {
            notes: { where: { status: { not: 'DELETED' } } },
          },
        },
      },
    });

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
      await tx.note.updateMany({
        where: {
          ownerID,
          groupID: groupId,
        },
        data: {
          groupID: null,
        },
      });

      await tx.noteGroup.update({
        where: { id: groupId },
        data: { deletedAt: new Date() },
      });
    });
  }
}

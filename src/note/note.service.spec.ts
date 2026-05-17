import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { NoteService } from './note.service';

describe('NoteService', () => {
  let service: NoteService;

  const prisma = {
    $transaction: jest.fn(async (input) =>
      Array.isArray(input) ? Promise.all(input) : input(prisma),
    ),
    $executeRaw: jest.fn().mockResolvedValue(0),
    note: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    noteGroup: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    noteMedia: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    noteGroupMembership: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoteService,
        { provide: PrismaService, useValue: prisma },
        // No MINIO_PUBLIC_URL configured → media-url origin check is skipped.
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
      ],
    }).compile();

    service = module.get<NoteService>(NoteService);
  });

  it('creates a note with ordered mixed media and multiple groups', async () => {
    prisma.noteGroup.findMany.mockResolvedValueOnce([
      {
        id: 'group-1',
        ownerID: 'user-1',
        name: '上海',
        deletedAt: null,
      },
      {
        id: 'group-2',
        ownerID: 'user-1',
        name: '北京',
        deletedAt: null,
      },
    ]);
    prisma.note.create.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
      title: '测试笔记',
      content: '正文',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      groupID: null,
      coverMediaID: null,
      imageCount: 2,
      videoCount: 1,
      mediaCount: 3,
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T00:00:00.000Z'),
    });
    prisma.noteMedia.createMany.mockResolvedValueOnce({
      count: 3,
    });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
      title: '测试笔记',
      content: '正文',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      groupID: 'group-1',
      coverMediaID: 'media-1',
      imageCount: 2,
      videoCount: 1,
      mediaCount: 3,
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T00:00:00.000Z'),
      groupMemberships: [
        { group: { id: 'group-1', name: '上海' } },
        { group: { id: 'group-2', name: '北京' } },
      ],
      media: [
        {
          id: 'media-1',
          type: 'IMAGE',
          url: 'https://cdn.example.com/1.jpg',
          posterUrl: null,
          sortOrder: 0,
        },
      ],
    });

    const result = await service.createNote('user-1', {
      title: '测试笔记',
      content: '正文',
      groupIds: ['group-1', 'group-2'],
      media: [
        {
          type: 'IMAGE',
          objectKey: 'notes/user-1/1.jpg',
          url: 'https://cdn.example.com/1.jpg',
          sortOrder: 0,
        },
        {
          type: 'VIDEO',
          objectKey: 'notes/user-1/1.mp4',
          url: 'https://cdn.example.com/1.mp4',
          posterUrl: 'https://cdn.example.com/1-cover.jpg',
          durationMs: 12000,
          sortOrder: 1,
        },
        {
          type: 'IMAGE',
          objectKey: 'notes/user-1/2.jpg',
          url: 'https://cdn.example.com/2.jpg',
          sortOrder: 2,
        },
      ],
    });

    expect(prisma.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerID: 'user-1',
          title: '测试笔记',
          imageCount: 2,
          videoCount: 1,
          mediaCount: 3,
        }),
      }),
    );
    expect(prisma.noteMedia.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          noteID: 'note-1',
          type: 'IMAGE',
          sortOrder: 0,
        }),
        expect.objectContaining({
          noteID: 'note-1',
          type: 'VIDEO',
          sortOrder: 1,
        }),
      ]),
    });
    expect(prisma.note.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'note-1' },
        data: expect.objectContaining({
          coverMediaID: expect.any(String),
        }),
        include: expect.any(Object),
      }),
    );
    expect(prisma.noteGroupMembership.createMany).toHaveBeenCalledWith({
      data: [
        { noteID: 'note-1', groupID: 'group-1' },
        { noteID: 'note-1', groupID: 'group-2' },
      ],
    });
    expect(result).toMatchObject({
      id: 'note-1',
      imageCount: 2,
      videoCount: 1,
      mediaCount: 3,
      groups: [
        { id: 'group-1', name: '上海' },
        { id: 'group-2', name: '北京' },
      ],
    });
  });

  it('derives title, content, media, and contentJson from block documents', async () => {
    prisma.note.create.mockResolvedValueOnce({
      id: 'note-2',
      ownerID: 'user-1',
      title: '块标题',
      content: '块标题 正文第一段 列表项一',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      groupID: null,
      coverMediaID: null,
      imageCount: 0,
      videoCount: 0,
      mediaCount: 0,
      contentJson: [
        {
          id: 'heading-1',
          type: 'heading',
          content: [{ type: 'text', text: '块标题' }],
        },
      ],
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T00:00:00.000Z'),
    });
    prisma.noteMedia.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-2',
      ownerID: 'user-1',
      title: '块标题',
      content: '块标题 正文第一段 列表项一',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      groupID: null,
      coverMediaID: 'media-1',
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
      contentJson: [
        {
          id: 'heading-1',
          type: 'heading',
          content: [{ type: 'text', text: '块标题' }],
        },
        {
          id: 'paragraph-1',
          type: 'paragraph',
          content: [{ type: 'text', text: '正文第一段' }],
        },
        {
          id: 'list-1',
          type: 'bulletListItem',
          content: [{ type: 'text', text: '列表项一' }],
        },
        {
          id: 'image-1',
          type: 'image',
          props: {
            url: 'https://cdn.example.com/1.jpg',
          },
        },
        {
          id: 'video-1',
          type: 'video',
          props: {
            url: 'https://cdn.example.com/1.mp4',
            posterUrl: 'https://cdn.example.com/1-cover.jpg',
            durationMs: 12000,
          },
        },
      ],
      groupMemberships: [],
      media: [
        {
          id: 'media-1',
          type: 'IMAGE',
          objectKey: 'notes/user-1/1.jpg',
          url: 'https://cdn.example.com/1.jpg',
          sortOrder: 3,
        },
        {
          id: 'media-2',
          type: 'VIDEO',
          objectKey: 'notes/user-1/1.mp4',
          url: 'https://cdn.example.com/1.mp4',
          posterUrl: 'https://cdn.example.com/1-cover.jpg',
          durationMs: 12000,
          sortOrder: 4,
        },
      ],
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T00:00:00.000Z'),
    });

    const contentJson = [
      {
        id: 'heading-1',
        type: 'heading',
        content: [{ type: 'text', text: '块标题' }],
      },
      {
        id: 'paragraph-1',
        type: 'paragraph',
        content: [{ type: 'text', text: '正文第一段' }],
      },
      {
        id: 'list-1',
        type: 'bulletListItem',
        content: [{ type: 'text', text: '列表项一' }],
      },
      {
        id: 'image-1',
        type: 'image',
        props: {
          url: 'https://cdn.example.com/1.jpg',
          objectKey: 'notes/user-1/1.jpg',
        },
      },
      {
        id: 'video-1',
        type: 'video',
        props: {
          url: 'https://cdn.example.com/1.mp4',
          objectKey: 'notes/user-1/1.mp4',
          posterUrl: 'https://cdn.example.com/1-cover.jpg',
          durationMs: 12000,
        },
      },
    ];

    const result = await service.createNote('user-1', {
      title: '旧标题',
      content: '旧正文',
      contentJson,
      media: [],
    });

    expect(prisma.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: '块标题',
          content: '块标题 正文第一段 列表项一',
          contentJson,
          imageCount: 1,
          videoCount: 1,
          mediaCount: 2,
        }),
      }),
    );
    expect(prisma.noteMedia.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          type: 'IMAGE',
          objectKey: 'notes/user-1/1.jpg',
          url: 'https://cdn.example.com/1.jpg',
        }),
        expect.objectContaining({
          type: 'VIDEO',
          objectKey: 'notes/user-1/1.mp4',
          url: 'https://cdn.example.com/1.mp4',
          posterUrl: 'https://cdn.example.com/1-cover.jpg',
        }),
      ]),
    });
    expect(result).toMatchObject({
      title: '块标题',
      content: '块标题 正文第一段 列表项一',
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
    });
    expect(result.contentJson).toEqual(expect.any(Array));
    expect(result.contentJson).toHaveLength(5);
  });

  it('lists only the owner notes with summary fields', async () => {
    prisma.note.findMany.mockResolvedValueOnce([
      {
        id: 'note-1',
        title: '测试笔记',
        content: '这是一条很长很长的正文内容',
        status: 'ACTIVE',
        available: true,
        pinned: true,
        imageCount: 3,
        videoCount: 1,
        createdAt: new Date('2026-04-09T00:00:00.000Z'),
        updatedAt: new Date('2026-04-09T10:00:00.000Z'),
        groupMemberships: [{ group: { id: 'group-1', name: '上海' } }],
        coverMedia: {
          id: 'media-1',
          type: 'IMAGE',
          url: 'https://cdn.example.com/1.jpg',
        },
      },
    ]);

    const result = await service.listNotes('user-1', { status: 'ACTIVE' });

    expect(prisma.note.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerID: 'user-1',
          status: 'ACTIVE',
        }),
      }),
    );
    expect(result[0]).toMatchObject({
      id: 'note-1',
      title: '测试笔记',
      contentPreview: expect.any(String),
      imageCount: 3,
      videoCount: 1,
      groups: [{ id: 'group-1', name: '上海' }],
    });
  });

  it('returns a note detail only for the owner', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
      title: '测试笔记',
      content: '完整正文',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
      groupMemberships: [],
      media: [
        {
          id: 'media-1',
          type: 'IMAGE',
          url: 'https://cdn.example.com/1.jpg',
          sortOrder: 0,
        },
        {
          id: 'media-2',
          type: 'VIDEO',
          url: 'https://cdn.example.com/1.mp4',
          posterUrl: 'https://cdn.example.com/1-cover.jpg',
          sortOrder: 1,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.getNote('user-1', 'note-1');

    expect(prisma.note.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'note-1', ownerID: 'user-1' }),
      }),
    );
    expect(result.media).toHaveLength(2);
  });

  it('rejects reading a note owned by someone else', async () => {
    prisma.note.findFirst.mockResolvedValueOnce(null);

    await expect(service.getNote('user-1', 'note-2')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('updates a note by replacing media and recalculating counts', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
      groupID: null,
    });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-1',
      title: '更新后的笔记',
      content: '新正文',
      status: 'UNLISTED',
      available: true,
      pinned: true,
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
      groupMemberships: [],
      media: [
        {
          id: 'media-2',
          type: 'VIDEO',
          url: 'https://cdn.example.com/2.mp4',
          posterUrl: 'https://cdn.example.com/2-cover.jpg',
          sortOrder: 0,
        },
        {
          id: 'media-3',
          type: 'IMAGE',
          url: 'https://cdn.example.com/3.jpg',
          sortOrder: 1,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.updateNote('user-1', 'note-1', {
      title: '更新后的笔记',
      content: '新正文',
      status: 'UNLISTED',
      pinned: true,
      media: [
        {
          type: 'VIDEO',
          objectKey: 'notes/user-1/2.mp4',
          url: 'https://cdn.example.com/2.mp4',
          posterUrl: 'https://cdn.example.com/2-cover.jpg',
          sortOrder: 0,
        },
        {
          type: 'IMAGE',
          objectKey: 'notes/user-1/3.jpg',
          url: 'https://cdn.example.com/3.jpg',
          sortOrder: 1,
        },
      ],
    });

    expect(prisma.noteMedia.deleteMany).toHaveBeenCalledWith({
      where: { noteID: 'note-1' },
    });
    expect(prisma.noteMedia.createMany).toHaveBeenCalled();
    expect(prisma.note.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'note-1' },
        data: expect.objectContaining({
          title: '更新后的笔记',
          imageCount: 1,
          videoCount: 1,
          mediaCount: 2,
        }),
      }),
    );
    expect(result).toMatchObject({
      id: 'note-1',
      status: 'UNLISTED',
      imageCount: 1,
      videoCount: 1,
    });
  });

  it('replaces note group memberships in one round-trip', async () => {
    prisma.noteGroup.findMany.mockResolvedValueOnce([
      { id: 'group-1', ownerID: 'user-1', name: '上海', deletedAt: null },
      { id: 'group-2', ownerID: 'user-1', name: '北京', deletedAt: null },
    ]);
    prisma.note.findFirst.mockResolvedValueOnce({ id: 'note-1' });
    prisma.note.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'note-1',
      groupMemberships: [{ groupID: 'group-1' }, { groupID: 'group-2' }],
    });

    const result = await service.updateNoteGroupIds('user-1', 'note-1', [
      'group-1',
      'group-2',
    ]);

    // Old memberships wiped, new ones inserted — no fetch-detail + replace-everything.
    expect(prisma.noteGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: { noteID: 'note-1' },
    });
    expect(prisma.noteGroupMembership.createMany).toHaveBeenCalledWith({
      data: [
        { noteID: 'note-1', groupID: 'group-1' },
        { noteID: 'note-1', groupID: 'group-2' },
      ],
    });
    // updateNote (full payload) must NOT be called — that was the N+1 path.
    expect(prisma.noteMedia.deleteMany).not.toHaveBeenCalled();
    expect(prisma.noteMedia.createMany).not.toHaveBeenCalled();
    expect(prisma.note.update).not.toHaveBeenCalled();

    expect(result).toEqual({
      id: 'note-1',
      groupIds: ['group-1', 'group-2'],
    });
  });

  it('rejects updateNoteGroupIds when one of the groups is not owned', async () => {
    prisma.noteGroup.findMany.mockResolvedValueOnce([
      { id: 'group-1', ownerID: 'user-1', name: '上海', deletedAt: null },
      // group-2 missing → requireOwnedGroups throws NotFoundException
    ]);

    await expect(
      service.updateNoteGroupIds('user-1', 'note-1', ['group-1', 'group-2']),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.noteGroupMembership.deleteMany).not.toHaveBeenCalled();
  });

  it('updateNoteGroupIds dedups group IDs before persisting', async () => {
    prisma.noteGroup.findMany.mockResolvedValueOnce([
      { id: 'group-1', ownerID: 'user-1', name: '上海', deletedAt: null },
    ]);
    prisma.note.findFirst.mockResolvedValueOnce({ id: 'note-1' });
    prisma.note.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'note-1',
      groupMemberships: [{ groupID: 'group-1' }],
    });

    await service.updateNoteGroupIds('user-1', 'note-1', [
      'group-1',
      'group-1',
      'group-1',
    ]);

    expect(prisma.noteGroupMembership.createMany).toHaveBeenCalledWith({
      data: [{ noteID: 'note-1', groupID: 'group-1' }],
    });
  });

  it('updateNoteGroupIds clears all memberships when groupIds is empty', async () => {
    // requireOwnedGroups short-circuits for empty groupIds — don't queue findMany.
    prisma.note.findFirst.mockResolvedValueOnce({ id: 'note-1' });
    prisma.note.findUniqueOrThrow.mockResolvedValueOnce({
      id: 'note-1',
      groupMemberships: [],
    });

    const result = await service.updateNoteGroupIds('user-1', 'note-1', []);

    expect(prisma.noteGroup.findMany).not.toHaveBeenCalled();
    expect(prisma.noteGroupMembership.deleteMany).toHaveBeenCalled();
    // createMany must NOT be called for an empty list.
    expect(prisma.noteGroupMembership.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'note-1', groupIds: [] });
  });

  it('updateNoteGroupIds throws NotFound when the note is deleted or not owned', async () => {
    prisma.noteGroup.findMany.mockResolvedValueOnce([
      { id: 'group-1', ownerID: 'user-1', name: '上海', deletedAt: null },
    ]);
    prisma.note.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.updateNoteGroupIds('user-1', 'note-1', ['group-1']),
    ).rejects.toThrow(NotFoundException);
  });

  it('pins a note for the owner only', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
    });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-1',
      pinned: true,
    });

    await service.setPinned('user-1', 'note-1', true);

    expect(prisma.note.update).toHaveBeenCalledWith({
      where: { id: 'note-1', ownerID: 'user-1', status: { not: 'DELETED' } },
      data: { pinned: true },
      select: expect.any(Object),
    });
  });

  it('toggles note availability for the owner only', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
    });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-1',
      available: false,
    });

    const result = await service.setAvailable('user-1', 'note-1', false);

    expect(prisma.note.update).toHaveBeenCalledWith({
      where: { id: 'note-1', ownerID: 'user-1', status: { not: 'DELETED' } },
      data: { available: false },
      select: expect.any(Object),
    });
    expect(result).toMatchObject({
      id: 'note-1',
      available: false,
    });
  });

  it('soft deletes a note', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
    });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-1',
      status: 'DELETED',
    });

    await service.deleteNote('user-1', 'note-1');

    expect(prisma.note.update).toHaveBeenCalledWith({
      where: { id: 'note-1', ownerID: 'user-1', status: { not: 'DELETED' } },
      data: { status: 'DELETED' },
      select: expect.any(Object),
    });
  });

  it('creates and lists note groups for the owner', async () => {
    prisma.noteGroup.count.mockResolvedValueOnce(0);
    prisma.noteGroup.create.mockResolvedValueOnce({
      id: 'group-1',
      ownerID: 'user-1',
      name: '上海',
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.noteGroup.findMany.mockResolvedValueOnce([
      {
        id: 'group-1',
        ownerID: 'user-1',
        name: '上海',
        sortOrder: 0,
        _count: { memberships: 2 },
      },
    ]);

    const created = await service.createGroup('user-1', { name: '上海' });
    const groups = await service.listGroups('user-1');

    expect(created).toMatchObject({ name: '上海' });
    expect(groups[0]).toMatchObject({ name: '上海', noteCount: 2 });
  });

  it('forbids renaming another user group', async () => {
    prisma.noteGroup.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.updateGroup('user-1', 'group-2', { name: '深圳' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects renaming a group to an existing group name', async () => {
    prisma.noteGroup.findFirst
      .mockResolvedValueOnce({
        id: 'group-1',
        ownerID: 'user-1',
        name: '上海',
        deletedAt: null,
      })
      .mockResolvedValueOnce({
        id: 'group-2',
        ownerID: 'user-1',
        name: '北京',
        deletedAt: null,
      });

    await expect(
      service.updateGroup('user-1', 'group-1', { name: '北京' }),
    ).rejects.toThrow(ConflictException);

    expect(prisma.noteGroup.update).not.toHaveBeenCalled();
  });

  it('allows renaming a group to its current name without conflict', async () => {
    prisma.noteGroup.findFirst.mockResolvedValueOnce({
      id: 'group-1',
      ownerID: 'user-1',
      name: '上海',
      deletedAt: null,
    });
    prisma.noteGroup.update.mockResolvedValueOnce({
      id: 'group-1',
      ownerID: 'user-1',
      name: '上海',
      sortOrder: 0,
      _count: { memberships: 1 },
    });

    const result = await service.updateGroup('user-1', 'group-1', {
      name: '上海',
    });

    // No second findFirst call for conflict because name is unchanged
    expect(prisma.noteGroup.findFirst).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ name: '上海' });
  });

  it('deletes a group by clearing note ownership group references first', async () => {
    prisma.noteGroup.findFirst.mockResolvedValueOnce({
      id: 'group-1',
      ownerID: 'user-1',
      name: '上海',
    });
    prisma.noteGroup.update.mockResolvedValueOnce({
      id: 'group-1',
      ownerID: 'user-1',
      name: '上海',
      deletedAt: new Date(),
    });

    await service.deleteGroup('user-1', 'group-1');

    expect(prisma.noteGroupMembership.deleteMany).toHaveBeenCalledWith({
      where: { groupID: 'group-1' },
    });
  });

  it('reorders custom groups by rewriting sortOrder from ordered ids', async () => {
    // Exhaustive-list count check
    prisma.noteGroup.count.mockResolvedValueOnce(2);
    // requireOwnedGroups ownership check
    prisma.noteGroup.findMany.mockResolvedValueOnce([
      { id: 'group-1', ownerID: 'user-1', deletedAt: null },
      { id: 'group-2', ownerID: 'user-1', deletedAt: null },
    ]);
    prisma.noteGroup.update.mockResolvedValueOnce({
      id: 'group-2',
      ownerID: 'user-1',
      name: '北京',
      sortOrder: 0,
      _count: { memberships: 0 },
    });
    prisma.noteGroup.update.mockResolvedValueOnce({
      id: 'group-1',
      ownerID: 'user-1',
      name: '上海',
      sortOrder: 1,
      _count: { memberships: 0 },
    });
    // listGroups call at the end of reorderGroups
    prisma.noteGroup.findMany.mockResolvedValueOnce([
      { id: 'group-2', name: '北京', sortOrder: 0, _count: { memberships: 0 } },
      { id: 'group-1', name: '上海', sortOrder: 1, _count: { memberships: 0 } },
    ]);

    await service.reorderGroups('user-1', ['group-2', 'group-1']);

    expect(prisma.noteGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'group-2' },
        data: expect.objectContaining({ sortOrder: 0 }),
      }),
    );
    expect(prisma.noteGroup.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'group-1' },
        data: expect.objectContaining({ sortOrder: 1 }),
      }),
    );
  });

  it('rejects reorderGroups when the provided list is not exhaustive', async () => {
    // User has 3 groups but only 2 are supplied
    prisma.noteGroup.count.mockResolvedValueOnce(3);

    await expect(
      service.reorderGroups('user-1', ['group-1', 'group-2']),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.noteGroup.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects media whose url is not served from app storage when MinIO is configured', async () => {
    const guarded = new NoteService(
      prisma as any,
      {
        get: jest.fn(() => 'http://10.0.0.195:9000'),
      } as any,
    );

    await expect(
      guarded.createNote('user-1', {
        title: 'phishing note',
        media: [
          {
            type: 'IMAGE',
            objectKey: 'notes/user-1/legit.jpg',
            url: 'https://evil.example.com/track.gif',
            sortOrder: 0,
          },
        ],
      } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts media whose url is under MINIO_PUBLIC_URL', async () => {
    const guarded = new NoteService(
      prisma as any,
      {
        get: jest.fn(() => 'http://10.0.0.195:9000'),
      } as any,
    );
    prisma.note.create.mockResolvedValueOnce({ id: 'note-1' });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-1',
      title: 't',
      content: null,
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 0,
      mediaCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      coverMedia: null,
      groupMemberships: [],
      media: [],
    });

    await expect(
      guarded.createNote('user-1', {
        title: 'ok note',
        media: [
          {
            type: 'IMAGE',
            objectKey: 'notes/user-1/legit.jpg',
            url: 'http://10.0.0.195:9000/circle/notes/user-1/legit.jpg',
            sortOrder: 0,
          },
        ],
      } as any),
    ).resolves.toBeDefined();
  });

  it('truncates contentJson-derived title and content to the DTO caps', async () => {
    const hugeText = 'x'.repeat(50_000);
    prisma.note.create.mockResolvedValueOnce({ id: 'note-1' });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-1',
      title: 't',
      content: 'c',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 0,
      videoCount: 0,
      mediaCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      coverMedia: null,
      groupMemberships: [],
      media: [],
    });

    await service.createNote('user-1', {
      title: 'ignored when contentJson present',
      contentJson: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: hugeText, styles: {} }],
        },
      ] as any,
      media: [],
    });

    const createArg = prisma.note.create.mock.calls[0][0];
    expect(createArg.data.title.length).toBe(120);
    expect(createArg.data.content.length).toBe(20_000);
  });
});

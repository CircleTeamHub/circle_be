import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/upload/upload.service';
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
      findMany: jest.fn(),
    },
    noteGroupMembership: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    noteShareLink: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };

  const uploadService = {
    uploadBuffer: jest.fn(),
    downloadObjectBuffer: jest.fn(),
    createPresignedGetUrl: jest.fn(),
    // 反推 object key（真 UploadService 的行为）：从本站直链 .../circle/<key>[?...] 取 <key>。
    objectKeyFromPublicUrl: jest.fn((url: unknown) =>
      typeof url === 'string'
        ? (url.split('/circle/')[1]?.split('?')[0] ?? null)
        : null,
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // updateNote 会先查笔记上已有媒体的 objectKey（收藏复制场景的豁免名单）。
    prisma.noteMedia.findMany.mockResolvedValue([]);
    uploadService.createPresignedGetUrl.mockImplementation(
      (key: string, expiresInSeconds: number) =>
        Promise.resolve({
          url: `https://signed.example.com/${key}?expires=${expiresInSeconds}`,
          expiresAt: new Date('2026-06-29T12:15:00.000Z'),
        }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: UploadService, useValue: uploadService },
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

  it('picks the first image as cover even when a video sorts first', async () => {
    prisma.note.create.mockResolvedValueOnce({
      id: 'note-c',
      ownerID: 'user-1',
      title: '封面测试',
      coverMediaID: null,
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
    });
    prisma.noteMedia.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-c',
      ownerID: 'user-1',
      title: '封面测试',
      media: [],
      groupMemberships: [],
    });

    await service.createNote('user-1', {
      title: '封面测试',
      media: [
        {
          type: 'VIDEO',
          objectKey: 'notes/user-1/v.mp4',
          url: 'https://cdn.example.com/v.mp4',
          sortOrder: 0,
        },
        {
          type: 'IMAGE',
          objectKey: 'notes/user-1/i.jpg',
          url: 'https://cdn.example.com/i.jpg',
          sortOrder: 1,
        },
      ],
    });

    const persisted = prisma.noteMedia.createMany.mock.calls[0][0].data;
    const image = persisted.find((m: { type: string }) => m.type === 'IMAGE');
    const video = persisted.find((m: { type: string }) => m.type === 'VIDEO');
    const coverUpdate = prisma.note.update.mock.calls.at(-1)![0];

    expect(coverUpdate.data.coverMediaID).toBe(image.id);
    expect(coverUpdate.data.coverMediaID).not.toBe(video.id);
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

  it('persists structured note sections while keeping legacy fields', async () => {
    const sections = {
      text: {
        content: '结构化正文',
        contentJson: [{ type: 'paragraph', content: [{ text: '结构化正文' }] }],
      },
      media: {
        items: [
          {
            type: 'IMAGE',
            objectKey: 'notes/user-1/media.jpg',
            url: 'https://cdn.example.com/media.jpg',
            sortOrder: 0,
          },
        ],
      },
      showcase: {
        items: [
          {
            type: 'VIDEO',
            objectKey: 'notes/user-1/show.mp4',
            url: 'https://cdn.example.com/show.mp4',
            posterUrl: 'https://cdn.example.com/show.jpg',
            sortOrder: 1,
          },
        ],
      },
      location: {
        title: '深圳南山区',
        address: '南山大道',
        latitude: 22.5431,
        longitude: 113.934,
      },
    };

    prisma.note.create.mockResolvedValueOnce({
      id: 'note-sections',
      ownerID: 'user-1',
      title: '结构化笔记',
      content: '结构化正文',
      contentJson: sections.text.contentJson,
      sections,
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T00:00:00.000Z'),
    });
    prisma.noteMedia.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-sections',
      ownerID: 'user-1',
      title: '结构化笔记',
      content: '结构化正文',
      contentJson: sections.text.contentJson,
      sections,
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T00:00:00.000Z'),
      groupMemberships: [],
      coverMedia: {
        id: 'media-cover',
        type: 'IMAGE',
        url: 'https://cdn.example.com/media.jpg',
      },
      media: [
        {
          id: 'media-1',
          type: 'IMAGE',
          objectKey: 'notes/user-1/media.jpg',
          url: 'https://cdn.example.com/media.jpg',
          sortOrder: 0,
        },
        {
          id: 'media-2',
          type: 'VIDEO',
          objectKey: 'notes/user-1/show.mp4',
          url: 'https://cdn.example.com/show.mp4',
          posterUrl: 'https://cdn.example.com/show.jpg',
          sortOrder: 1,
        },
      ],
    });

    const result = await service.createNote('user-1', {
      title: '结构化笔记',
      content: 'legacy fallback',
      media: [],
      sections,
    } as any);

    expect(prisma.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: '结构化笔记',
          content: '结构化正文',
          contentJson: sections.text.contentJson,
          sections,
          imageCount: 1,
          videoCount: 1,
          mediaCount: 2,
        }),
      }),
    );
    expect(prisma.noteMedia.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ type: 'IMAGE', sortOrder: 0 }),
        expect.objectContaining({ type: 'VIDEO', sortOrder: 1 }),
      ]),
    });
    // presign-on-read：写库存的是 base url（上面 prisma.note.create 已断言），返回给客户端的
    // sections media/showcase url 换成按 objectKey 现签的短时签名 URL；posterUrl 不在本站
    // /circle/ 前缀下、反推不出 key，保持原值。
    const toSigned = (items: any[]) =>
      (items ?? []).map((i: any) =>
        i.objectKey
          ? {
              ...i,
              url: `https://signed.example.com/${i.objectKey}?expires=7200`,
            }
          : i,
      );
    expect((result as any).sections).toEqual({
      ...sections,
      media: { ...sections.media, items: toSigned(sections.media.items) },
      showcase: {
        ...sections.showcase,
        items: toSigned(sections.showcase.items),
      },
    });
    expect(result).toMatchObject({
      hasText: true,
      imageCount: 1,
      videoCount: 1,
      showcaseCount: 1,
      hasLocation: true,
    });
  });

  it('strips signed-url query before persisting note media (edit round-trip)', async () => {
    // 客户端 edit 时回传的是读到的短时签名 url；写库必须只存 base url，读取时才现签。
    const signed =
      'https://cdn.example.com/notes/user-1/a.jpg?X-Amz-Signature=old&X-Amz-Date=1';
    const base = 'https://cdn.example.com/notes/user-1/a.jpg';
    const row = {
      id: 'n1',
      ownerID: 'user-1',
      title: 't',
      content: 'c',
      contentJson: null,
      sections: {},
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 0,
      mediaCount: 1,
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T00:00:00.000Z'),
    };
    prisma.note.create.mockResolvedValueOnce(row);
    prisma.noteMedia.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.note.update.mockResolvedValueOnce({
      ...row,
      groupMemberships: [],
      coverMedia: null,
      media: [],
    });

    await service.createNote('user-1', {
      title: 't',
      content: 'c',
      media: [
        {
          type: 'IMAGE',
          objectKey: 'notes/user-1/a.jpg',
          url: signed,
          sortOrder: 0,
        },
      ],
    } as any);

    // NoteMedia 行存 base url（签名 query 已被 strip）。
    const rows = prisma.noteMedia.createMany.mock.calls[0][0].data;
    expect(rows[0].url).toBe(base);
    // sections JSON 里也不落签名。
    const storedSections = JSON.stringify(
      prisma.note.create.mock.calls[0][0].data.sections,
    );
    expect(storedSections).not.toContain('X-Amz-Signature');
  });

  it('rejects structured section media that is not part of the validated note media set', async () => {
    await expect(
      service.createNote('user-1', {
        title: 'unsafe sections',
        media: [
          {
            type: 'IMAGE',
            objectKey: 'notes/user-1/legit.jpg',
            url: 'https://cdn.example.com/legit.jpg',
            sortOrder: 0,
          },
        ],
        sections: {
          text: { content: 'hello' },
          media: {
            items: [
              {
                type: 'IMAGE',
                objectKey: 'notes/user-1/untracked.jpg',
                url: 'https://cdn.example.com/untracked.jpg',
                sortOrder: 0,
              },
            ],
          },
        },
      } as any),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('normalizes section-derived media sort orders across media and showcase sections', async () => {
    prisma.note.create.mockResolvedValueOnce({
      id: 'note-sort',
      ownerID: 'user-1',
      title: 'sort',
      content: null,
      contentJson: null,
      sections: null,
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.noteMedia.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-sort',
      ownerID: 'user-1',
      title: 'sort',
      content: null,
      contentJson: null,
      sections: null,
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
      groupMemberships: [],
      coverMedia: null,
      media: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.createNote('user-1', {
      title: 'sort',
      media: [],
      sections: {
        media: {
          items: [
            {
              type: 'IMAGE',
              objectKey: 'notes/user-1/one.jpg',
              url: 'https://cdn.example.com/one.jpg',
              sortOrder: 0,
            },
          ],
        },
        showcase: {
          items: [
            {
              type: 'VIDEO',
              objectKey: 'notes/user-1/two.mp4',
              url: 'https://cdn.example.com/two.mp4',
              sortOrder: 0,
            },
          ],
        },
      },
    } as any);

    const data = prisma.noteMedia.createMany.mock.calls[0][0].data;
    expect(data.map((item: any) => item.sortOrder)).toEqual([0, 1]);
  });

  it('keeps showcase-only section media out of the body media section on create', async () => {
    const showcaseImage = {
      type: 'IMAGE',
      objectKey: 'notes/user-1/showcase.jpg',
      url: 'https://cdn.example.com/showcase.jpg',
      sortOrder: 0,
    };

    prisma.note.create.mockResolvedValueOnce({
      id: 'note-showcase-only',
      ownerID: 'user-1',
      title: 'showcase only',
      content: null,
      contentJson: null,
      sections: null,
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 0,
      mediaCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.noteMedia.createMany.mockResolvedValueOnce({ count: 1 });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-showcase-only',
      ownerID: 'user-1',
      title: 'showcase only',
      content: null,
      contentJson: null,
      sections: {
        text: { content: null, contentJson: null },
        media: { items: [] },
        showcase: { items: [showcaseImage] },
        location: null,
      },
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 0,
      mediaCount: 1,
      groupMemberships: [],
      coverMedia: null,
      media: [
        {
          id: 'media-1',
          ...showcaseImage,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.createNote('user-1', {
      title: 'showcase only',
      media: [],
      sections: {
        showcase: {
          items: [showcaseImage],
        },
      },
    } as any);

    expect(prisma.note.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sections: expect.objectContaining({
            media: { items: [] },
            showcase: { items: [showcaseImage] },
          }),
        }),
      }),
    );
  });

  it('keeps an explicitly empty stored body media section empty on read', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-stored-sections',
      ownerID: 'user-1',
      title: 'stored sections',
      content: null,
      contentJson: null,
      sections: {
        text: { content: null, contentJson: null },
        media: { items: [] },
        showcase: {
          items: [
            {
              id: 'media-1',
              type: 'IMAGE',
              objectKey: 'notes/user-1/showcase.jpg',
              url: 'https://cdn.example.com/showcase.jpg',
              sortOrder: 0,
            },
          ],
        },
        location: null,
      },
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 0,
      mediaCount: 1,
      groupMemberships: [],
      coverMedia: null,
      media: [
        {
          id: 'media-1',
          type: 'IMAGE',
          objectKey: 'notes/user-1/showcase.jpg',
          url: 'https://cdn.example.com/showcase.jpg',
          sortOrder: 0,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.getNote('user-1', 'note-stored-sections');

    expect(result.sections.media.items).toEqual([]);
    expect(result.sections.showcase.items).toHaveLength(1);
  });

  it('lists only the owner notes with summary fields', async () => {
    prisma.note.findMany.mockResolvedValueOnce([
      {
        id: 'note-1',
        ownerID: 'user-1',
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
      ownerId: 'user-1',
      canEdit: true,
      title: '测试笔记',
      contentPreview: expect.any(String),
      imageCount: 3,
      videoCount: 1,
      groups: [{ id: 'group-1', name: '上海' }],
    });
  });

  it('returns a note detail with owner edit metadata', async () => {
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
        where: {
          id: 'note-1',
          status: { not: 'DELETED' },
          OR: [{ ownerID: 'user-1' }, { available: true }],
        },
      }),
    );
    expect(result.media).toHaveLength(2);
    expect(result).toMatchObject({
      ownerId: 'user-1',
      canEdit: true,
    });
  });

  it('lets non-owners read available notes without edit permission', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
      title: '群里分享的笔记',
      content: '完整正文',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 0,
      videoCount: 0,
      mediaCount: 0,
      groupMemberships: [],
      media: [],
      coverMedia: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.getNote('user-2', 'note-1');

    expect(prisma.note.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'note-1',
          status: { not: 'DELETED' },
          OR: [{ ownerID: 'user-2' }, { available: true }],
        },
      }),
    );
    expect(result).toMatchObject({
      id: 'note-1',
      ownerId: 'user-1',
      canEdit: false,
    });
  });

  it('rejects reading a deleted or unavailable note owned by someone else', async () => {
    prisma.note.findFirst.mockResolvedValueOnce(null);

    await expect(service.getNote('user-1', 'note-2')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('exports all note images as a downloadable zip artifact', async () => {
    const expiresAt = new Date('2026-06-29T12:15:00.000Z');
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-export',
      ownerID: 'user-1',
      title: '导出测试',
      content: '正文',
      contentJson: null,
      sections: null,
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 2,
      videoCount: 1,
      mediaCount: 3,
      groupMemberships: [],
      coverMedia: null,
      media: [
        {
          id: 'img-1',
          type: 'IMAGE',
          objectKey: 'notes/user-1/1.jpg',
          url: 'https://cdn.example.com/1.jpg',
          mimeType: 'image/jpeg',
          size: 10,
          sortOrder: 0,
        },
        {
          id: 'video-1',
          type: 'VIDEO',
          objectKey: 'notes/user-1/1.mp4',
          url: 'https://cdn.example.com/1.mp4',
          mimeType: 'video/mp4',
          size: 20,
          sortOrder: 1,
        },
        {
          id: 'img-2',
          type: 'IMAGE',
          objectKey: 'notes/user-1/2.jpg',
          url: 'https://cdn.example.com/2.jpg',
          mimeType: 'image/jpeg',
          size: 30,
          sortOrder: 2,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    uploadService.uploadBuffer.mockResolvedValueOnce({
      url: 'https://cdn.example.com/note-exports/user-1/note-export/images.zip',
      key: 'note-exports/user-1/note-export/images.zip',
      size: 1234,
      expiresAt,
    });
    uploadService.downloadObjectBuffer
      .mockResolvedValueOnce(Buffer.from('image-one'))
      .mockResolvedValueOnce(Buffer.from('image-two'));

    const result = await (service as any).createNoteExport(
      'user-1',
      'note-export',
      {
        format: 'IMAGES',
        scope: 'ALL',
      },
    );

    expect(uploadService.uploadBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.stringMatching(
          /^note-exports\/user-1\/note-export\/.+\.zip$/,
        ),
        contentType: 'application/zip',
        expiresInSeconds: 900,
      }),
    );
    const uploaded = uploadService.uploadBuffer.mock.calls[0][0].body as Buffer;
    expect(uploaded.subarray(0, 2).toString()).toBe('PK');
    expect(uploadService.downloadObjectBuffer).toHaveBeenCalledWith(
      'notes/user-1/1.jpg',
      8 * 1024 * 1024,
    );
    expect(uploadService.downloadObjectBuffer).toHaveBeenCalledWith(
      'notes/user-1/2.jpg',
      8 * 1024 * 1024,
    );
    expect(uploadService.createPresignedGetUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^note-exports\/user-1\/note-export\/.+\.zip$/),
      900,
    );
    expect(result).toMatchObject({
      url: expect.stringMatching(
        /^https:\/\/signed\.example\.com\/note-exports\/user-1\/note-export\/.+\.zip\?expires=900$/,
      ),
      filename: '导出测试-images.zip',
      mimeType: 'application/zip',
      size: 1234,
      expiresAt,
    });
  });

  it('exports PDF with embedded note images from storage objects', async () => {
    const expiresAt = new Date('2026-06-29T12:15:00.000Z');
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-pdf',
      ownerID: 'user-1',
      title: 'PDF测试',
      content: '正文',
      contentJson: null,
      sections: null,
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 0,
      mediaCount: 1,
      groupMemberships: [],
      coverMedia: null,
      media: [
        {
          id: 'img-1',
          type: 'IMAGE',
          objectKey: 'notes/user-1/1.png',
          url: 'https://cdn.example.com/1.png',
          mimeType: 'image/png',
          size: 10,
          sortOrder: 0,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    uploadService.downloadObjectBuffer.mockResolvedValueOnce(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    uploadService.uploadBuffer.mockResolvedValueOnce({
      url: 'https://cdn.example.com/note-exports/user-1/note-pdf/pdf.pdf',
      key: 'note-exports/user-1/note-pdf/pdf.pdf',
      size: 2048,
      expiresAt,
    });

    const result = await service.createNoteExport('user-1', 'note-pdf', {
      format: 'PDF',
      scope: 'ALL',
    });

    expect(uploadService.downloadObjectBuffer).toHaveBeenCalledWith(
      'notes/user-1/1.png',
      8 * 1024 * 1024,
    );
    const body = uploadService.uploadBuffer.mock.calls[0][0].body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.toString('latin1')).toContain('https://cdn.example.com/1.png');
    expect(result).toMatchObject({
      filename: 'PDF测试.pdf',
      mimeType: 'application/pdf',
      url: expect.stringMatching(
        /^https:\/\/signed\.example\.com\/note-exports\/user-1\/note-pdf\/.+\.pdf\?expires=900$/,
      ),
      expiresAt,
    });
  });

  it('includes showcase-only media in PDF and long-image exports', async () => {
    const noteRow = {
      id: 'note-showcase-export',
      ownerID: 'user-1',
      title: '展示导出',
      content: '正文',
      contentJson: null,
      sections: {
        text: { content: '正文', contentJson: null },
        media: { items: [] },
        showcase: {
          items: [
            {
              type: 'IMAGE',
              objectKey: 'notes/user-1/show.png',
              url: 'https://cdn.example.com/show.png',
              sortOrder: 0,
            },
          ],
        },
        location: null,
      },
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 0,
      mediaCount: 1,
      groupMemberships: [],
      coverMedia: null,
      media: [
        {
          id: 'img-show',
          type: 'IMAGE',
          objectKey: 'notes/user-1/show.png',
          url: 'https://cdn.example.com/show.png',
          mimeType: 'image/png',
          size: 10,
          sortOrder: 0,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    prisma.note.findFirst
      .mockResolvedValueOnce(noteRow)
      .mockResolvedValueOnce(noteRow);
    uploadService.downloadObjectBuffer.mockResolvedValueOnce(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    uploadService.uploadBuffer
      .mockResolvedValueOnce({
        url: 'https://cdn.example.com/pdf.pdf',
        key: 'note-exports/user-1/note-showcase-export/pdf.pdf',
        size: 2048,
        expiresAt: new Date('2026-06-29T12:15:00.000Z'),
      })
      .mockResolvedValueOnce({
        url: 'https://cdn.example.com/image.svg',
        key: 'note-exports/user-1/note-showcase-export/image.svg',
        size: 1024,
        expiresAt: new Date('2026-06-29T12:15:00.000Z'),
      });

    await service.createNoteExport('user-1', 'note-showcase-export', {
      format: 'PDF',
      scope: 'ALL',
    });
    await service.createNoteExport('user-1', 'note-showcase-export', {
      format: 'IMAGE',
      scope: 'ALL',
    });

    const pdfBody = uploadService.uploadBuffer.mock.calls[0][0].body as Buffer;
    const svgBody = uploadService.uploadBuffer.mock.calls[1][0].body as Buffer;
    expect(pdfBody.toString('latin1')).toContain(
      'https://cdn.example.com/show.png',
    );
    expect(svgBody.toString()).toContain('https://cdn.example.com/show.png');
  });

  it('rejects export requests whose selected media exceed safe limits', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-huge',
      ownerID: 'user-1',
      title: '巨大笔记',
      content: '正文',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 2,
      videoCount: 0,
      mediaCount: 2,
      groupMemberships: [],
      coverMedia: null,
      media: [
        {
          id: 'img-1',
          type: 'IMAGE',
          objectKey: 'notes/user-1/1.jpg',
          url: 'https://cdn.example.com/1.jpg',
          mimeType: 'image/jpeg',
          size: 9 * 1024 * 1024,
          sortOrder: 0,
        },
        {
          id: 'img-2',
          type: 'IMAGE',
          objectKey: 'notes/user-1/2.jpg',
          url: 'https://cdn.example.com/2.jpg',
          mimeType: 'image/jpeg',
          size: 9 * 1024 * 1024,
          sortOrder: 1,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      service.createNoteExport('user-1', 'note-huge', {
        format: 'IMAGES',
        scope: 'ALL',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(uploadService.downloadObjectBuffer).not.toHaveBeenCalled();
    expect(uploadService.uploadBuffer).not.toHaveBeenCalled();
  });

  it('rejects zip exports when actual downloaded bytes exceed the total cap', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-null-size',
      ownerID: 'user-1',
      title: '未知大小',
      content: '正文',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 3,
      videoCount: 0,
      mediaCount: 3,
      groupMemberships: [],
      coverMedia: null,
      media: [1, 2, 3].map((index) => ({
        id: `img-${index}`,
        type: 'IMAGE',
        objectKey: `notes/user-1/${index}.jpg`,
        url: `https://cdn.example.com/${index}.jpg`,
        mimeType: 'image/jpeg',
        size: null,
        sortOrder: index - 1,
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    uploadService.downloadObjectBuffer
      .mockResolvedValueOnce(Buffer.alloc(8 * 1024 * 1024))
      .mockResolvedValueOnce(Buffer.alloc(8 * 1024 * 1024))
      .mockResolvedValueOnce(Buffer.alloc(1));

    await expect(
      service.createNoteExport('user-1', 'note-null-size', {
        format: 'IMAGES',
        scope: 'ALL',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(uploadService.downloadObjectBuffer).toHaveBeenCalledTimes(3);
    expect(uploadService.uploadBuffer).not.toHaveBeenCalled();
  });

  it('limits PDF image embedding work to a small bounded set', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-many-images',
      ownerID: 'user-1',
      title: '多图笔记',
      content: '正文',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 8,
      videoCount: 0,
      mediaCount: 8,
      groupMemberships: [],
      coverMedia: null,
      media: Array.from({ length: 8 }, (_, index) => ({
        id: `img-${index + 1}`,
        type: 'IMAGE',
        objectKey: `notes/user-1/${index + 1}.png`,
        url: `https://cdn.example.com/${index + 1}.png`,
        mimeType: 'image/png',
        size: 10,
        sortOrder: index,
      })),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    uploadService.downloadObjectBuffer.mockResolvedValue(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    uploadService.uploadBuffer.mockResolvedValueOnce({
      url: 'https://cdn.example.com/pdf.pdf',
      key: 'note-exports/user-1/note-many-images/pdf.pdf',
      size: 2048,
      expiresAt: new Date('2026-06-29T12:15:00.000Z'),
    });

    await service.createNoteExport('user-1', 'note-many-images', {
      format: 'PDF',
      scope: 'ALL',
    });

    expect(uploadService.downloadObjectBuffer).toHaveBeenCalledTimes(4);
    const body = uploadService.uploadBuffer.mock.calls[0][0].body as Buffer;
    const pdfText = body.toString('latin1');
    expect(pdfText).toContain('https://cdn.example.com/1.png');
    expect(pdfText).toContain('https://cdn.example.com/8.png');
  });

  it('uses NOTE_EXPORT_PDF_FONT_PATH when a custom PDF font is configured', () => {
    const dir = mkdtempSync(join(tmpdir(), 'circle-note-font-'));
    const fontPath = join(dir, 'font.ttf');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(fontPath, Buffer.from('fake-font-for-path-resolution'));
    const configured = new NoteService(
      prisma as any,
      {
        get: jest.fn((key: string) =>
          key === 'NOTE_EXPORT_PDF_FONT_PATH' ? fontPath : null,
        ),
      } as any,
      uploadService as any,
    );

    expect((configured as any).resolvePdfFontPath()).toBe(fontPath);
  });

  it('exports an individual video by returning its media download URL', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-export',
      ownerID: 'user-1',
      title: '导出测试',
      content: '正文',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 0,
      videoCount: 1,
      mediaCount: 1,
      groupMemberships: [],
      coverMedia: null,
      media: [
        {
          id: 'video-1',
          type: 'VIDEO',
          objectKey: 'notes/user-1/1.mp4',
          url: 'https://cdn.example.com/1.mp4',
          mimeType: 'video/mp4',
          size: 20,
          sortOrder: 0,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await (service as any).createNoteExport(
      'user-1',
      'note-export',
      {
        format: 'VIDEOS',
        scope: 'video-1',
      },
    );

    expect(uploadService.uploadBuffer).not.toHaveBeenCalled();
    expect(uploadService.createPresignedGetUrl).toHaveBeenCalledWith(
      'notes/user-1/1.mp4',
      900,
    );
    expect(result).toMatchObject({
      url: 'https://signed.example.com/notes/user-1/1.mp4?expires=900',
      filename: '导出测试-video-1.mp4',
      mimeType: 'video/mp4',
      size: 20,
      expiresAt: new Date('2026-06-29T12:15:00.000Z'),
    });
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

  it('updates note status for the owner only', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-1',
      ownerID: 'user-1',
    });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-1',
      status: 'UNLISTED',
    });

    const result = await service.setStatus('user-1', 'note-1', 'UNLISTED');

    expect(prisma.note.update).toHaveBeenCalledWith({
      where: { id: 'note-1', ownerID: 'user-1', status: { not: 'DELETED' } },
      data: { status: 'UNLISTED' },
      select: expect.any(Object),
    });
    expect(result).toMatchObject({
      id: 'note-1',
      status: 'UNLISTED',
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

  it('creates a managed note share link for the current filtered note view', async () => {
    prisma.noteGroup.findFirst.mockResolvedValueOnce({
      id: 'group-1',
      ownerID: 'user-1',
      name: '上海',
      deletedAt: null,
    });
    prisma.note.findMany.mockResolvedValueOnce([
      { id: 'note-1' },
      { id: 'note-2' },
    ]);
    prisma.noteShareLink.create.mockResolvedValueOnce({
      id: 'share-1',
      ownerID: 'user-1',
      token: 'token-123',
      title: '我的笔记',
      status: 'ACTIVE',
      group: null,
      groupID: 'group-1',
      search: '咖啡',
      noteIDs: ['note-1', 'note-2'],
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date('2026-06-08T10:00:00.000Z'),
      updatedAt: new Date('2026-06-08T10:00:00.000Z'),
    });

    const serviceWithBase = new NoteService(
      prisma as any,
      {
        get: jest.fn((key: string) =>
          key === 'NOTE_SHARE_WEB_BASE' ? 'https://circle.im' : null,
        ),
      } as any,
    );

    const result = await serviceWithBase.createShareLink('user-1', {
      title: '我的笔记',
      status: 'ACTIVE',
      groupId: 'group-1',
      search: ' 咖啡 ',
      noteIds: ['note-1', 'note-2'],
    });

    expect(prisma.note.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['note-1', 'note-2'] },
        ownerID: 'user-1',
        status: { not: 'DELETED' },
      },
      select: { id: true },
    });
    expect(prisma.noteShareLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ownerID: 'user-1',
        title: '我的笔记',
        status: 'ACTIVE',
        groupID: 'group-1',
        group: null,
        search: '咖啡',
        noteIDs: ['note-1', 'note-2'],
      }),
    });
    expect(result).toEqual({
      id: 'share-1',
      token: 'token-123',
      url: 'https://circle.im/s/token-123',
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date('2026-06-08T10:00:00.000Z'),
    });
  });

  it('rejects a note share link when any requested note is missing or owned by someone else', async () => {
    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }]);

    await expect(
      service.createShareLink('user-1', {
        title: '我的笔记',
        noteIds: ['note-1', 'note-2'],
      }),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.noteShareLink.create).not.toHaveBeenCalled();
  });

  it('rejects a note share link when group and groupId are both set', async () => {
    await expect(
      service.createShareLink('user-1', {
        title: '我的笔记',
        group: 'ungrouped',
        groupId: '11111111-1111-1111-1111-111111111111',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.noteShareLink.create).not.toHaveBeenCalled();
  });

  it('persists a bounded expiresAt when expiresInDays is supplied', async () => {
    const now = new Date('2026-06-08T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now.getTime());

    prisma.noteShareLink.create.mockResolvedValueOnce({
      id: 'share-2',
      ownerID: 'user-1',
      token: 'token-456',
      title: '我的笔记',
      status: null,
      group: null,
      groupID: null,
      search: null,
      noteIDs: [],
      expiresAt: new Date('2026-06-15T10:00:00.000Z'),
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    try {
      const result = await service.createShareLink('user-1', {
        title: '我的笔记',
        expiresInDays: 7,
      });

      expect(prisma.noteShareLink.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ownerID: 'user-1',
          expiresAt: new Date('2026-06-15T10:00:00.000Z'),
        }),
      });
      expect(result.expiresAt).toEqual(new Date('2026-06-15T10:00:00.000Z'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries token generation on a unique-token collision', async () => {
    const collision = Object.assign(new Error('unique'), { code: 'P2002' });
    prisma.noteShareLink.create
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce({
        id: 'share-3',
        ownerID: 'user-1',
        token: 'token-789',
        title: '我的笔记',
        status: null,
        group: null,
        groupID: null,
        search: null,
        noteIDs: [],
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date('2026-06-08T10:00:00.000Z'),
        updatedAt: new Date('2026-06-08T10:00:00.000Z'),
      });

    const result = await service.createShareLink('user-1', {
      title: '我的笔记',
    });

    expect(prisma.noteShareLink.create).toHaveBeenCalledTimes(2);
    expect(result.token).toBe('token-789');
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

  it('ignores malformed contentJson nodes instead of throwing runtime errors', async () => {
    prisma.note.create.mockResolvedValueOnce({ id: 'note-malformed' });
    prisma.note.update.mockResolvedValueOnce({
      id: 'note-malformed',
      ownerID: 'user-1',
      title: 'Malformed',
      content: null,
      contentJson: [{ type: 'paragraph', content: [{ type: 'link' }, null] }],
      sections: null,
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

    await expect(
      service.createNote('user-1', {
        title: 'Malformed',
        media: [],
        contentJson: [
          null,
          { type: 'paragraph', content: [{ type: 'link' }, null] },
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
    expect(createArg.data.title).toHaveLength(120);
    expect(createArg.data.content).toHaveLength(20_000);
  });

  // ── collectNote：聊天收藏笔记 → 复制入我的笔记 ─────────────────────────────

  const collectSource = {
    conversationType: 'group' as const,
    conversationID: 'sg_123',
    clientMsgID: 'msg-abc',
    sender: {
      id: 'user-2',
      name: '小王',
      faceURL: 'https://cdn.example.com/w.jpg',
    },
    group: {
      id: 'g-1',
      name: '产品讨论群',
      faceURL: 'https://cdn.example.com/g.jpg',
    },
  };

  const otherUsersNote = {
    id: 'note-src',
    ownerID: 'user-2',
    title: '分享的笔记',
    content: '正文',
    contentJson: [{ type: 'paragraph' }],
    sections: { text: { content: '正文', contentJson: null } },
    status: 'ACTIVE',
    available: true,
    pinned: true,
    imageCount: 1,
    videoCount: 1,
    mediaCount: 2,
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    coverMedia: {
      id: 'media-img',
      type: 'IMAGE',
      url: 'https://cdn.example.com/a.jpg',
    },
    groupMemberships: [],
    media: [
      {
        id: 'media-vid',
        type: 'VIDEO',
        objectKey: 'notes/user-2/a.mp4',
        url: 'https://cdn.example.com/a.mp4',
        mimeType: 'video/mp4',
        size: 100,
        width: null,
        height: null,
        durationMs: 1000,
        posterUrl: 'https://cdn.example.com/a-poster.jpg',
        sortOrder: 0,
      },
      {
        id: 'media-img',
        type: 'IMAGE',
        objectKey: 'notes/user-2/a.jpg',
        url: 'https://cdn.example.com/a.jpg',
        mimeType: 'image/jpeg',
        size: 50,
        width: 800,
        height: 600,
        durationMs: null,
        posterUrl: null,
        sortOrder: 1,
      },
    ],
  };

  it('collectNote snapshots another user note into my notes with source card', async () => {
    prisma.note.findFirst
      .mockResolvedValueOnce(otherUsersNote) // 源笔记可读
      .mockResolvedValueOnce(null); // 尚未收藏过
    prisma.note.create.mockResolvedValueOnce({ id: 'note-copy' });
    prisma.noteMedia.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.note.update.mockImplementationOnce(async (args: any) => ({
      ...otherUsersNote,
      id: 'note-copy',
      ownerID: 'user-1',
      pinned: false,
      collectedFrom: { kind: 'chat' },
      collectedFromNoteID: 'note-src',
      coverMediaID: args.data.coverMediaID,
    }));

    const result = await service.collectNote('user-1', {
      noteId: 'note-src',
      source: collectSource,
    });

    expect(result.alreadyCollected).toBe(false);
    expect(result.note.canEdit).toBe(true);

    const createArg = prisma.note.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      ownerID: 'user-1',
      title: '分享的笔记',
      collectedFromNoteID: 'note-src',
      imageCount: 1,
      videoCount: 1,
      mediaCount: 2,
      pinned: false,
      status: 'ACTIVE',
    });
    expect(createArg.data.collectedFrom).toMatchObject({
      kind: 'chat',
      conversationType: 'group',
      conversationID: 'sg_123',
      clientMsgID: 'msg-abc',
      sender: { id: 'user-2', name: '小王' },
      group: { id: 'g-1', name: '产品讨论群' },
      sourceNoteId: 'note-src',
      sourceOwnerId: 'user-2',
    });

    // 媒体行复用同一存储对象（objectKey/url 原样），但换新 id 归属新笔记
    const mediaArg = prisma.noteMedia.createMany.mock.calls[0][0];
    expect(mediaArg.data).toHaveLength(2);
    expect(mediaArg.data.map((m: any) => m.objectKey)).toEqual([
      'notes/user-2/a.mp4',
      'notes/user-2/a.jpg',
    ]);
    expect(mediaArg.data.every((m: any) => m.noteID === 'note-copy')).toBe(
      true,
    );
    expect(mediaArg.data.every((m: any) => m.id !== 'media-img')).toBe(true);

    // 封面对齐原笔记封面（IMAGE 那行的新 id）
    const updateArg = prisma.note.update.mock.calls[0][0];
    const copiedImage = mediaArg.data.find((m: any) => m.type === 'IMAGE');
    expect(updateArg.data.coverMediaID).toBe(copiedImage.id);
  });

  it('collectNote rewrites structured section media IDs to the copied media rows', async () => {
    prisma.note.findFirst
      .mockResolvedValueOnce({
        ...otherUsersNote,
        sections: {
          text: { content: '正文', contentJson: null },
          media: { items: [otherUsersNote.media[0]] },
          showcase: { items: [otherUsersNote.media[1]] },
          location: null,
        },
      })
      .mockResolvedValueOnce(null);
    prisma.note.create.mockResolvedValueOnce({ id: 'note-copy' });
    prisma.noteMedia.createMany.mockResolvedValueOnce({ count: 2 });
    prisma.note.update.mockImplementationOnce(async (args: any) => ({
      ...otherUsersNote,
      id: 'note-copy',
      ownerID: 'user-1',
      sections: args.data.sections,
      collectedFrom: { kind: 'chat' },
      collectedFromNoteID: 'note-src',
    }));

    await service.collectNote('user-1', {
      noteId: 'note-src',
      source: collectSource,
    });

    const createArg = prisma.note.create.mock.calls[0][0];
    const mediaArg = prisma.noteMedia.createMany.mock.calls[0][0];
    const copiedVideo = mediaArg.data.find((m: any) => m.type === 'VIDEO');
    const copiedImage = mediaArg.data.find((m: any) => m.type === 'IMAGE');

    expect(createArg.data.sections.media.items[0].id).toBe(copiedVideo.id);
    expect(createArg.data.sections.showcase.items[0].id).toBe(copiedImage.id);
    expect(createArg.data.sections.media.items[0].id).not.toBe('media-vid');
    expect(createArg.data.sections.showcase.items[0].id).not.toBe('media-img');
  });

  it('collectNote treats a concurrent duplicate collect as already collected', async () => {
    prisma.note.findFirst
      .mockResolvedValueOnce(otherUsersNote) // source note is readable
      .mockResolvedValueOnce(null) // no copy at pre-check time
      .mockResolvedValueOnce({ id: 'note-copy' }); // unique race loser re-read
    prisma.note.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.note.update.mockResolvedValueOnce({
      ...otherUsersNote,
      id: 'note-copy',
      ownerID: 'user-1',
      collectedFrom: { kind: 'chat', conversationID: 'sg_123' },
      collectedFromNoteID: 'note-src',
    });

    const result = await service.collectNote('user-1', {
      noteId: 'note-src',
      source: collectSource,
    });

    expect(result.alreadyCollected).toBe(true);
    expect(result.note.id).toBe('note-copy');
    expect(prisma.note.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'note-copy',
          ownerID: 'user-1',
          status: { not: 'DELETED' },
        },
        include: expect.any(Object),
      }),
    );
    expect(prisma.noteMedia.createMany).not.toHaveBeenCalled();
  });

  it('collectNote returns own note untouched (already in my notes)', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      ...otherUsersNote,
      id: 'note-mine',
      ownerID: 'user-1',
    });

    const result = await service.collectNote('user-1', {
      noteId: 'note-mine',
      source: collectSource,
    });

    expect(result.alreadyCollected).toBe(true);
    expect(result.note.id).toBe('note-mine');
    expect(prisma.note.create).not.toHaveBeenCalled();
    expect(prisma.note.update).not.toHaveBeenCalled();
  });

  it('collectNote refreshes source snapshot when the note was collected before', async () => {
    prisma.note.findFirst
      .mockResolvedValueOnce(otherUsersNote)
      .mockResolvedValueOnce({ id: 'note-copy' }); // 已有收藏副本
    prisma.note.update.mockResolvedValueOnce({
      ...otherUsersNote,
      id: 'note-copy',
      ownerID: 'user-1',
      collectedFrom: { kind: 'chat', conversationID: 'sg_123' },
      collectedFromNoteID: 'note-src',
    });

    const result = await service.collectNote('user-1', {
      noteId: 'note-src',
      source: collectSource,
    });

    expect(result.alreadyCollected).toBe(true);
    expect(prisma.note.create).not.toHaveBeenCalled();
    const updateArg = prisma.note.update.mock.calls[0][0];
    expect(updateArg.where).toEqual({
      id: 'note-copy',
      ownerID: 'user-1',
      status: { not: 'DELETED' },
    });
    expect(updateArg.data.collectedFrom).toMatchObject({
      conversationID: 'sg_123',
      clientMsgID: 'msg-abc',
    });
  });

  it('collectNote refresh guards against copies deleted after lookup', async () => {
    prisma.note.findFirst
      .mockResolvedValueOnce(otherUsersNote)
      .mockResolvedValueOnce({ id: 'note-copy' });
    prisma.note.update.mockResolvedValueOnce({
      ...otherUsersNote,
      id: 'note-copy',
      ownerID: 'user-1',
      collectedFrom: { kind: 'chat', conversationID: 'sg_123' },
      collectedFromNoteID: 'note-src',
    });

    await service.collectNote('user-1', {
      noteId: 'note-src',
      source: collectSource,
    });

    expect(prisma.note.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'note-copy',
          ownerID: 'user-1',
          status: { not: 'DELETED' },
        },
      }),
    );
  });

  it('collectNote rejects notes that are deleted or not readable', async () => {
    prisma.note.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.collectNote('user-1', {
        noteId: 'note-hidden',
        source: collectSource,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.note.create).not.toHaveBeenCalled();
  });

  it('collectNote surfaces collectedFrom in list/detail mapping', async () => {
    prisma.note.findFirst.mockResolvedValueOnce({
      ...otherUsersNote,
      id: 'note-copy',
      ownerID: 'user-1',
      collectedFrom: {
        kind: 'chat',
        conversationType: 'group',
        group: { id: 'g-1', name: '产品讨论群', faceURL: null },
      },
      collectedFromNoteID: 'note-src',
    });

    const detail = await service.getNote('user-1', 'note-copy');
    expect(detail.collectedFrom).toMatchObject({
      conversationType: 'group',
      group: { name: '产品讨论群' },
    });
  });

  it('hides collectedFrom from anyone who is not the note owner', async () => {
    // 收藏副本被转发后 available=true，其他人能读内容，但来源名片是
    // 收藏者的私人定位标记，不能跟着笔记一起泄漏给查看者。
    prisma.note.findFirst.mockResolvedValueOnce({
      ...otherUsersNote,
      id: 'note-copy',
      ownerID: 'user-1',
      available: true,
      collectedFrom: {
        kind: 'chat',
        conversationType: 'group',
        group: { id: 'g-1', name: '产品讨论群', faceURL: null },
      },
      collectedFromNoteID: 'note-src',
    });

    const detail = await service.getNote('user-9', 'note-copy');
    expect(detail.collectedFrom).toBeNull();
    expect(detail.canEdit).toBe(false);
  });

  // ── updateNote：收藏副本上的原作者媒体 key 豁免 ────────────────────────────

  it('updateNote keeps grandfathered foreign media keys already on the note', async () => {
    prisma.noteMedia.findMany.mockResolvedValueOnce([
      { objectKey: 'notes/user-2/a.jpg' },
    ]);
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'note-copy',
      ownerID: 'user-1',
      status: 'ACTIVE',
    });
    prisma.note.update.mockResolvedValueOnce({
      ...otherUsersNote,
      id: 'note-copy',
      ownerID: 'user-1',
    });

    await expect(
      service.updateNote('user-1', 'note-copy', {
        title: '编辑收藏的笔记',
        media: [
          {
            type: 'IMAGE',
            objectKey: 'notes/user-2/a.jpg', // 收藏时带来的原作者对象，允许保留
            url: 'https://cdn.example.com/a.jpg',
            sortOrder: 0,
          },
          {
            type: 'IMAGE',
            objectKey: 'notes/user-1/new.jpg', // 新增媒体必须归属自己
            url: 'https://cdn.example.com/new.jpg',
            sortOrder: 1,
          },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('updateNote still rejects foreign media keys that are not on the note', async () => {
    prisma.noteMedia.findMany.mockResolvedValueOnce([]);

    await expect(
      service.updateNote('user-1', 'note-1', {
        title: '恶意引用',
        media: [
          {
            type: 'IMAGE',
            objectKey: 'notes/user-2/steal.jpg',
            url: 'https://cdn.example.com/steal.jpg',
            sortOrder: 0,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ── resolveShareLink（访客侧解析）──────────────────────────────────────────
  // 规格来源：docs/note-share-links-todo.md 第 1 节（解析接口）与第 4 节
  // （解析时重新校验笔记状态）。在此之前 NoteShareLink 只写不读，
  // expiresAt / revokedAt 存了但从不校验。
  describe('resolveShareLink', () => {
    const shareLinkRow = {
      id: 'share-1',
      ownerID: 'user-1',
      token: 'tok-abc',
      title: '我的笔记',
      status: null,
      group: null,
      groupID: null,
      search: null,
      noteIDs: [] as string[],
      expiresAt: null as Date | null,
      revokedAt: null as Date | null,
      createdAt: new Date('2026-06-08T10:00:00.000Z'),
      updatedAt: new Date('2026-06-08T10:00:00.000Z'),
    };

    const sharedNoteRow = {
      id: 'note-1',
      ownerID: 'user-1',
      title: '测试笔记',
      content: '正文内容',
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 0,
      videoCount: 0,
      mediaCount: 0,
      // 收藏来源是笔记主人的私人定位标记，不能跟着分享链接泄漏给访客。
      collectedFrom: { groupName: '私密来源群' },
      createdAt: new Date('2026-04-09T00:00:00.000Z'),
      updatedAt: new Date('2026-04-09T10:00:00.000Z'),
      groupMemberships: [],
      coverMedia: null,
    };

    /** 捕获解析失败时抛出的异常，供「三种失败路径响应一致」断言比对。 */
    const captureRejection = async (row: unknown): Promise<unknown> => {
      prisma.noteShareLink.findUnique.mockResolvedValueOnce(row as never);
      // 备好 findMany，这样「漏校验」的实现会成功返回而不是抛 TypeError —— 失败
      // 信息才会明确指向缺失的过期/吊销校验本身。
      prisma.note.findMany.mockResolvedValueOnce([]);
      try {
        await service.resolveShareLink('tok-abc');
        throw new Error('expected resolveShareLink to reject');
      } catch (error) {
        return error;
      }
    };

    it('resolves a valid token to the notes in the link snapshot', async () => {
      prisma.noteShareLink.findUnique.mockResolvedValueOnce({
        ...shareLinkRow,
        noteIDs: ['note-1'],
      });
      prisma.note.findMany.mockResolvedValueOnce([sharedNoteRow]);

      const result = await service.resolveShareLink('tok-abc');

      expect(prisma.noteShareLink.findUnique).toHaveBeenCalledWith({
        where: { token: 'tok-abc' },
      });
      expect(result.title).toBe('我的笔记');
      expect(result.notes).toHaveLength(1);
      // 访客不是笔记主人：canEdit=false，collectedFrom 被抹掉。
      expect(result.notes[0]).toMatchObject({
        id: 'note-1',
        ownerId: 'user-1',
        canEdit: false,
        collectedFrom: null,
      });
    });

    it('rejects an expired token', async () => {
      prisma.noteShareLink.findUnique.mockResolvedValueOnce({
        ...shareLinkRow,
        expiresAt: new Date(Date.now() - 1000),
      });
      // 若实现漏掉过期校验，这一条会让它「成功」返回空列表，
      // 断言随即报 "resolved instead of rejected"，直指缺失的校验。
      prisma.note.findMany.mockResolvedValueOnce([]);

      await expect(service.resolveShareLink('tok-abc')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // 过期即拒绝，不得再去查笔记。
      expect(prisma.note.findMany).not.toHaveBeenCalled();
    });

    it('rejects a revoked token', async () => {
      prisma.noteShareLink.findUnique.mockResolvedValueOnce({
        ...shareLinkRow,
        revokedAt: new Date('2026-06-09T00:00:00.000Z'),
      });
      prisma.note.findMany.mockResolvedValueOnce([]);

      await expect(service.resolveShareLink('tok-abc')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.note.findMany).not.toHaveBeenCalled();
    });

    it('rejects an unknown token', async () => {
      prisma.noteShareLink.findUnique.mockResolvedValueOnce(null as never);
      prisma.note.findMany.mockResolvedValueOnce([]);

      await expect(service.resolveShareLink('tok-nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.note.findMany).not.toHaveBeenCalled();
    });

    it('returns an identical opaque error for unknown, revoked and expired tokens', async () => {
      // 三条失败路径的响应必须逐字节一致，否则访客可以据此区分
      // 「链接不存在」/「链接已被吊销」/「链接已过期」，从而探测链接是否存在。
      const unknown = await captureRejection(null);
      const revoked = await captureRejection({
        ...shareLinkRow,
        revokedAt: new Date('2026-06-09T00:00:00.000Z'),
      });
      const expired = await captureRejection({
        ...shareLinkRow,
        expiresAt: new Date(Date.now() - 1000),
      });

      for (const error of [unknown, revoked, expired]) {
        expect(error).toBeInstanceOf(NotFoundException);
      }
      const body = (unknown as NotFoundException).getResponse();
      expect((revoked as NotFoundException).getResponse()).toEqual(body);
      expect((expired as NotFoundException).getResponse()).toEqual(body);
    });

    it('scopes resolution to the link owner and its stored snapshot filters', async () => {
      prisma.noteShareLink.findUnique.mockResolvedValueOnce({
        ...shareLinkRow,
        status: 'ACTIVE',
        groupID: 'group-1',
        search: '咖啡',
        noteIDs: ['note-1', 'note-2'],
      });
      prisma.note.findMany.mockResolvedValueOnce([]);

      await service.resolveShareLink('tok-abc');

      const where = prisma.note.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        ownerID: 'user-1',
        id: { in: ['note-1', 'note-2'] },
        status: 'ACTIVE',
        groupMemberships: {
          some: { groupID: 'group-1', group: { deletedAt: null } },
        },
      });
      // docs 第 1 节：不能复用 getNote 的 `OR: [{ownerID}, {available:true}]`
      // 放行逻辑 —— 那会让链接范围外的任意 available 笔记也被读出来。
      expect(where.OR).not.toContainEqual({ available: true });
      expect(where.OR).not.toContainEqual({ ownerID: 'user-1' });
    });

    it('re-checks note state at resolve time instead of trusting the snapshot', async () => {
      // docs 第 4 节：链接创建后笔记可能被删除或取消 available，
      // 解析时必须按当前状态过滤，不能信任 noteIDs 快照。
      prisma.noteShareLink.findUnique.mockResolvedValueOnce({
        ...shareLinkRow,
        noteIDs: ['note-1'],
      });
      prisma.note.findMany.mockResolvedValueOnce([]);

      await service.resolveShareLink('tok-abc');

      const where = prisma.note.findMany.mock.calls[0][0].where;
      expect(where.available).toBe(true);
      expect(where.status).toEqual({ not: 'DELETED' });
    });

    it('filters to ungrouped notes when the link snapshot stores group=ungrouped', async () => {
      prisma.noteShareLink.findUnique.mockResolvedValueOnce({
        ...shareLinkRow,
        group: 'ungrouped',
      });
      prisma.note.findMany.mockResolvedValueOnce([]);

      await service.resolveShareLink('tok-abc');

      const where = prisma.note.findMany.mock.calls[0][0].where;
      expect(where.groupMemberships).toEqual({
        none: { group: { deletedAt: null } },
      });
    });
  });

  // ── revokeShareLink / listShareLinks（链接主人侧管理）────────────────────────
  // 规格来源：docs/note-share-links-todo.md 第 2 节（吊销接口）。
  // resolveShareLink 已经会拒绝 revokedAt != null 的链接，但在此之前**没有任何
  // 代码写入 revokedAt** —— enforcement 就位而 writer 缺失，吊销实际不可达。
  describe('revokeShareLink', () => {
    const revokedAt = new Date('2026-06-10T08:00:00.000Z');

    it('stamps revokedAt on a link owned by the caller', async () => {
      prisma.noteShareLink.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.revokeShareLink('user-1', 'share-1');

      expect(prisma.noteShareLink.updateMany).toHaveBeenCalledWith({
        // ownerID 在 where 里 = 越权吊销直接匹配 0 行，不需要先读后写。
        where: { id: 'share-1', ownerID: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('keeps the original revokedAt when the link is already revoked', async () => {
      // revokedAt: null 的 where 让重复吊销匹配 0 行 —— 原始吊销时间不会被覆写。
      prisma.noteShareLink.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.noteShareLink.findFirst.mockResolvedValueOnce({
        id: 'share-1',
        revokedAt,
      });

      await expect(
        service.revokeShareLink('user-1', 'share-1'),
      ).resolves.toBeUndefined();
    });

    it('rejects revoking a link owned by someone else', async () => {
      prisma.noteShareLink.updateMany.mockResolvedValueOnce({ count: 0 });
      // 越权者的兜底查询同样带 ownerID，查不到 → 与「不存在」同一个 404，
      // 不泄漏「这个 id 存在但不是你的」。
      prisma.noteShareLink.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.revokeShareLink('user-2', 'share-1'),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.noteShareLink.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ ownerID: 'user-2' }),
        }),
      );
    });

    it('rejects revoking a link that does not exist', async () => {
      prisma.noteShareLink.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.noteShareLink.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.revokeShareLink('user-1', 'missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does not re-read the row when the conditional update already revoked it', async () => {
      prisma.noteShareLink.updateMany.mockResolvedValueOnce({ count: 1 });

      await service.revokeShareLink('user-1', 'share-1');

      // happy path 只有一次写查询：吊销是幂等条件更新，不需要先读后写。
      expect(prisma.noteShareLink.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('listShareLinks', () => {
    it('returns the callers own links newest first with resolvable urls', async () => {
      prisma.noteShareLink.findMany.mockResolvedValueOnce([
        {
          id: 'share-2',
          ownerID: 'user-1',
          token: 'tok-new',
          title: '新链接',
          status: null,
          group: null,
          groupID: null,
          search: null,
          noteIDs: [],
          expiresAt: new Date('2026-07-01T00:00:00.000Z'),
          revokedAt: null,
          createdAt: new Date('2026-06-09T10:00:00.000Z'),
          updatedAt: new Date('2026-06-09T10:00:00.000Z'),
        },
        {
          id: 'share-1',
          ownerID: 'user-1',
          token: 'tok-old',
          title: '旧链接',
          status: null,
          group: null,
          groupID: null,
          search: null,
          noteIDs: [],
          expiresAt: null,
          revokedAt: new Date('2026-06-09T09:00:00.000Z'),
          createdAt: new Date('2026-06-08T10:00:00.000Z'),
          updatedAt: new Date('2026-06-09T09:00:00.000Z'),
        },
      ]);

      const serviceWithBase = new NoteService(
        prisma as any,
        {
          get: jest.fn((key: string) =>
            key === 'NOTE_SHARE_WEB_BASE' ? 'https://circle.im' : null,
          ),
        } as any,
      );

      const result = await serviceWithBase.listShareLinks('user-1', {});

      expect(prisma.noteShareLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { ownerID: 'user-1' },
          orderBy: { createdAt: 'desc' },
        }),
      );
      // 已吊销 / 已过期的链接也要返回：revokedAt、expiresAt 都在 DTO 上，
      // 由客户端决定怎么展示；服务端过滤掉它们会让这两个字段恒为 null。
      expect(result).toEqual([
        {
          id: 'share-2',
          token: 'tok-new',
          url: 'https://circle.im/s/tok-new',
          expiresAt: new Date('2026-07-01T00:00:00.000Z'),
          revokedAt: null,
          createdAt: new Date('2026-06-09T10:00:00.000Z'),
        },
        {
          id: 'share-1',
          token: 'tok-old',
          url: 'https://circle.im/s/tok-old',
          expiresAt: null,
          revokedAt: new Date('2026-06-09T09:00:00.000Z'),
          createdAt: new Date('2026-06-08T10:00:00.000Z'),
        },
      ]);
    });

    it('defaults to the first page when no paging is requested', async () => {
      prisma.noteShareLink.findMany.mockResolvedValueOnce([]);

      await service.listShareLinks('user-1', {});

      // 与 listNotes 的默认值对齐（limit 50 / page 1）。链接行数没有上界，
      // 不设 take 会把该用户全部历史链接一次性拉进内存。
      expect(prisma.noteShareLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, skip: 0 }),
      );
    });

    it('translates page and limit into skip and take', async () => {
      prisma.noteShareLink.findMany.mockResolvedValueOnce([]);

      await service.listShareLinks('user-1', { page: 3, limit: 20 });

      // 有了分页，超出首屏的旧链接也拿得到 id —— 否则它们在本接口上不可见，
      // 也就无从吊销（吊销只能靠列表拿 id）。
      expect(prisma.noteShareLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 20, skip: 40 }),
      );
    });

    it('reaches links past the first page for revocation', async () => {
      prisma.noteShareLink.findMany.mockResolvedValueOnce([]);

      await service.listShareLinks('user-1', { page: 2 });

      // page 2 + 默认 limit：第 51 条起。这正是「老链接被新链接挤掉就吊销不了」
      // 那个缺口的补法。
      expect(prisma.noteShareLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, skip: 50 }),
      );
    });
  });
});

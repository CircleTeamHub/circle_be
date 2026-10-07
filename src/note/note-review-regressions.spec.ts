import {
  Controller,
  Get,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOkResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import {
  MAX_NOTE_EDIT_PUBLICATION_OUTCOMES,
  NoteService,
} from './note.service';
import { NoteDetailDto, NoteDraftDto, NoteSummaryDto } from './dto/note.dto';
import { Prisma } from 'src/generated/prisma';

describe('note review regressions', () => {
  const row = {
    id: 'draft-row',
    ownerID: 'owner',
    clientDraftID: 'draft-1',
    sourceNoteID: null,
    title: '',
    content: null,
    contentJson: [],
    sections: {},
    groupIDs: [],
    mediaKeys: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  function fixture() {
    const prisma = {
      noteDraft: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest
          .fn()
          .mockImplementation(({ create }) =>
            Promise.resolve({ ...row, ...create }),
          ),
        deleteMany: jest.fn(),
        update: jest.fn(),
      },
      note: { findFirst: jest.fn().mockResolvedValue(null) },
      noteMedia: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      friend: { findMany: jest.fn().mockResolvedValue([]) },
      circle: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (run) => run(prisma));
    const policy = { lockUsers: jest.fn().mockResolvedValue(undefined) };
    const upload = {
      createPresignedGetUrl: jest.fn().mockImplementation(async (key) => ({
        url: `https://signed.test/${key}?signature=test`,
      })),
      objectKeyFromPublicUrl: (url: unknown) =>
        typeof url === 'string'
          ? (url.split('https://storage.test/bucket/')[1]?.split('?')[0] ??
            null)
          : null,
    };
    const config = {
      get: (key: string) =>
        key === 'OBJECT_STORAGE_DELIVERY_URL'
          ? 'https://storage.test/bucket'
          : undefined,
    };
    const service = new NoteService(
      prisma as any,
      config as any,
      policy as any,
      upload as any,
    );
    return { service, prisma, policy, upload };
  }

  it.each(['media', 'showcase', 'audio'])(
    'rejects cross-user keys in draft section %s even if mediaKeys is omitted',
    async (section) => {
      const { service, prisma, upload } = fixture();
      await expect(
        service.saveNoteDraft('owner', 'draft-1', {
          sections: {
            [section]: {
              items: [{ type: 'IMAGE', objectKey: 'notes/other/private.jpg' }],
            },
          },
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
      expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
    },
  );

  it('rejects a foreign poster key attached to an owned draft video', async () => {
    const { service, upload } = fixture();
    await expect(
      service.saveNoteDraft('owner', 'draft-1', {
        sections: {
          media: {
            items: [
              {
                type: 'VIDEO',
                objectKey: 'notes/owner/a.mp4',
                posterUrl:
                  'https://storage.test/bucket/notes/other/private.jpg',
              },
            ],
          },
        },
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
  });

  it.each(['media', 'audio'])(
    'returns a signed URL for key-only draft media in %s',
    async (section) => {
      const { service } = fixture();
      const result = await service.saveNoteDraft('owner', 'draft-1', {
        sections: {
          [section]: {
            items: [
              {
                type: section === 'audio' ? 'AUDIO' : 'IMAGE',
                objectKey: 'notes/owner/a.jpg',
              },
            ],
          },
        },
      } as any);
      expect((result.sections as any)[section].items[0].url).toBe(
        'https://signed.test/notes/owner/a.jpg?signature=test',
      );
    },
  );

  it('caps creation transactionally while permitting updates to an existing draft', async () => {
    const { service, prisma, policy } = fixture();
    prisma.noteDraft.count.mockResolvedValue(100);
    await expect(
      service.saveNoteDraft('owner', 'new', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(policy.lockUsers).toHaveBeenCalledWith(prisma, ['owner']);
    expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
    prisma.noteDraft.findUnique.mockResolvedValue({ id: 'existing' } as any);
    await expect(
      service.saveNoteDraft('owner', 'existing', {}),
    ).resolves.toBeDefined();
  });

  it('reads only one bounded page of drafts', async () => {
    const { service, prisma } = fixture();
    await service.listNoteDrafts('owner', 2, 20);
    expect(prisma.noteDraft.findMany).toHaveBeenCalledWith({
      where: { ownerID: 'owner', consumedAt: null },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: 20,
      take: 20,
    });
  });

  it('rejects an autosave that resumes after the draft has been published', async () => {
    const { service, prisma, policy } = fixture();
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      release = resolve;
    });
    policy.lockUsers.mockReturnValueOnce(locked);
    const saving = service.saveNoteDraft('owner', 'draft-1', {});
    prisma.note.findFirst.mockResolvedValue({ id: 'published-note' } as any);
    release();
    await expect(saving).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
  });

  it('resolves a group card by its legacy groupID and keeps its advertised identifier', async () => {
    const { service, prisma } = fixture();
    prisma.circle.findMany.mockResolvedValue([
      {
        id: 'canonical-circle',
        groupID: 'legacy-group',
        name: 'Group',
        avatarUrl: null,
      },
    ] as any);
    const result = await (service as any).canonicalizeNoteCards('owner', {
      sections: {
        groups: { items: [{ id: 'legacy-group', name: 'untrusted' }] },
      },
    });
    expect(result.sections.groups.items).toEqual([
      {
        id: 'legacy-group',
        circleId: 'canonical-circle',
        name: 'Group',
        faceURL: null,
      },
    ]);
    expect(
      prisma.circle.findMany.mock.calls[0][0].where.AND[0].OR,
    ).toContainEqual({ groupID: { in: ['legacy-group'] } });
  });

  it.each(['legacy-group', 'canonical-circle'])(
    'recanonicalizes draft group %s instead of persisting a forged circleId',
    async (id) => {
      const { service, prisma } = fixture();
      prisma.circle.findMany.mockResolvedValue([
        {
          id: 'canonical-circle',
          groupID: 'legacy-group',
          name: 'Canonical',
          avatarUrl: null,
        },
      ] as any);
      const result = await service.saveNoteDraft('owner', 'draft-1', {
        sections: {
          groups: {
            items: [{ id, name: 'Forged', circleId: 'forged-circle' }],
          },
        },
      });
      const expected = {
        id,
        name: 'Canonical',
        faceURL: null,
        ...(id === 'legacy-group' ? { circleId: 'canonical-circle' } : {}),
      };
      expect(result.sections?.groups?.items).toEqual([expected]);
      expect(
        prisma.noteDraft.upsert.mock.calls[0][0].create.sections.groups.items,
      ).toEqual([expected]);
    },
  );

  it('retains an owned source group snapshot on draft save after membership is lost, ignoring the request circleId', async () => {
    const { service, prisma } = fixture();
    const group = {
      id: 'legacy-group',
      circleId: 'canonical-circle',
      name: 'Saved snapshot',
      faceURL: null,
    };
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'source',
      sections: { groups: { items: [group] } },
    } as any);
    const result = await service.saveNoteDraft('owner', 'draft-1', {
      sourceNoteId: 'source',
      sections: {
        groups: {
          items: [{ id: group.id, circleId: 'forged-circle', name: 'Forged' }],
        },
      },
    });
    expect(result.sections?.groups?.items).toEqual([group]);
    expect(prisma.circle.findMany).not.toHaveBeenCalled();
  });

  it('retains stored collected cards while still rejecting newly added inaccessible cards', async () => {
    const { service } = fixture();
    const stored = {
      contacts: {
        items: [{ id: 'former-contact', name: 'Stored name', faceURL: null }],
      },
      groups: {
        items: [{ id: 'unjoined-group', name: 'Stored group', faceURL: null }],
      },
    };
    const result = await (service as any).canonicalizeNoteCards(
      'collector',
      { sections: stored },
      stored,
    );
    expect(result.sections).toEqual(stored);
    await expect(
      (service as any).canonicalizeNoteCards(
        'collector',
        {
          sections: {
            ...stored,
            contacts: {
              items: [
                ...stored.contacts.items,
                { id: 'new-person', name: 'Fake' },
              ],
            },
          },
        },
        stored,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a non-friend draft contact before persisting its forged name and storage reference', async () => {
    const { service, prisma } = fixture();
    await expect(
      service.saveNoteDraft('owner', 'draft-1', {
        sections: {
          contacts: {
            items: [
              {
                id: 'stranger',
                name: 'Forged',
                faceURL: 'https://storage.test/bucket/private/avatar.jpg',
              },
            ],
          },
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
  });

  it('resolves an accepted friend draft card from the server profile', async () => {
    const { service, prisma } = fixture();
    prisma.friend.findMany.mockResolvedValue([
      {
        userID: 'owner',
        friend: {
          id: 'friend',
          nickname: 'Actual name',
          avatarUrl: 'https://storage.test/bucket/avatars/friend.jpg',
        },
      },
    ] as any);
    const result = await service.saveNoteDraft('owner', 'draft-1', {
      sections: {
        contacts: {
          items: [
            {
              id: 'friend',
              name: 'Forged',
              faceURL: 'https://storage.test/bucket/private/forged.jpg',
            },
          ],
        },
      },
    });
    const contacts = {
      items: [
        {
          id: 'friend',
          name: 'Actual name',
          faceURL: 'https://storage.test/bucket/avatars/friend.jpg',
        },
      ],
    };
    expect(result.sections).toEqual({ contacts });
    expect(prisma.noteDraft.upsert.mock.calls[0][0].create.sections).toEqual({
      contacts,
    });
  });

  it('grandfathers an owned source contact snapshot after friendship is lost but rejects a new stranger', async () => {
    const { service, prisma } = fixture();
    const card = { id: 'former-friend', name: 'Saved name', faceURL: null };
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'source',
      sections: { contacts: { items: [card] } },
    } as any);
    const input = {
      sourceNoteId: 'source',
      sections: {
        contacts: {
          items: [
            {
              ...card,
              name: 'Forged',
              faceURL: 'https://storage.test/bucket/private/forged.jpg',
            },
          ],
        },
      },
    };
    expect(
      (await service.saveNoteDraft('owner', 'draft-1', input)).sections,
    ).toEqual({ contacts: { items: [card] } });
    expect(prisma.friend.findMany).not.toHaveBeenCalled();
    prisma.note.findFirst.mockResolvedValueOnce({
      id: 'source',
      sections: { contacts: { items: [card] } },
    } as any);
    await expect(
      service.saveNoteDraft('owner', 'draft-2', {
        ...input,
        sections: {
          contacts: { items: [{ id: 'stranger', name: 'New stranger' }] },
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns the NoteMedia audio total even when the explicit section is empty', () => {
    const { service } = fixture();
    const summary = (service as any).mapSummary(
      {
        id: 'n',
        ownerID: 'owner',
        title: 'Audio',
        audioCount: 2,
        imageCount: 0,
        videoCount: 0,
        mediaCount: 2,
        sections: { audio: { items: [] } },
      },
      'owner',
    );
    expect(summary.audioCount).toBe(2);
  });

  it('publishes contact and group counts in the OpenAPI response schema', async () => {
    @Controller('notes')
    class ProbeController {
      @Get()
      @ApiOkResponse({ type: NoteSummaryDto })
      list() {}
    }
    const module = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    const app = module.createNestApplication();
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('Test').setVersion('1').build(),
      );
      const schema = doc.components?.schemas?.NoteSummaryDto as {
        properties: Record<string, unknown>;
      };
      expect(schema.properties.contactCount).toMatchObject({ type: 'number' });
      expect(schema.properties.groupCardCount).toMatchObject({
        type: 'number',
      });
    } finally {
      await app.close();
    }
  });

  it('preserves a draft title at the 120 Unicode code-point limit', async () => {
    const { service } = fixture();
    const title = '😀'.repeat(120);
    expect(
      (await service.saveNoteDraft('owner', 'emoji', { title })).title,
    ).toBe(title);
  });

  it('rejects an aggregate inventory over 150 keys before persistence or signing', async () => {
    const { service, prisma, upload } = fixture();
    const blocks = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        type: 'image',
        props: { objectKey: `notes/owner/${start + i}.jpg` },
      }));
    await expect(
      service.saveNoteDraft('owner', 'oversized', {
        contentJson: blocks(0, 76),
        sections: { text: { contentJson: blocks(76, 75) } },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
    expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('counts posters in the aggregate cap and deduplicates keys across rich-text representations', async () => {
    const { service, upload } = fixture();
    const blocks = Array.from({ length: 75 }, (_, i) => ({
      type: 'video',
      props: {
        objectKey: `notes/owner/${i}.mp4`,
        posterUrl: `https://storage.test/bucket/notes/owner/${i}.jpg`,
      },
    }));
    const saved = await service.saveNoteDraft('owner', 'at-limit', {
      contentJson: blocks,
      sections: { text: { contentJson: blocks } },
    });
    expect(saved.mediaKeys).toHaveLength(150);
    expect(upload.createPresignedGetUrl).toHaveBeenCalledTimes(150);
    await expect(
      service.saveNoteDraft('owner', 'over-limit', {
        contentJson: blocks,
        mediaKeys: ['notes/owner/extra.jpg'],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upload.createPresignedGetUrl).toHaveBeenCalledTimes(150);
  });

  it.each(['contentJson', 'sectionJson', 'sectionPlain'] as const)(
    'lists a body preview for a draft using only %s',
    async (representation) => {
      const { service, prisma } = fixture();
      const blocks = [
        {
          type: 'paragraph',
          content: [
            {
              type: 'link',
              href: 'https://private.test/secret',
              content: [{ type: 'text', text: 'Visible body' }],
            },
          ],
          children: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'nested text' }],
            },
          ],
        },
      ];
      const saved = await service.saveNoteDraft('owner', 'rich', {
        title: 'Title',
        ...(representation === 'contentJson'
          ? { contentJson: blocks }
          : {
              sections: {
                text:
                  representation === 'sectionJson'
                    ? { contentJson: blocks }
                    : { content: 'Visible body\nnested text' },
              },
            }),
      });
      prisma.noteDraft.findMany.mockResolvedValue([
        { ...row, ...prisma.noteDraft.upsert.mock.calls[0][0].create },
      ]);
      expect(saved.contentPreview).toBe('Visible body nested text');
      expect((await service.listNoteDrafts('owner'))[0].contentPreview).toBe(
        saved.contentPreview,
      );
      expect(saved.contentPreview).not.toContain('secret');
    },
  );

  it('truncates rich-text draft previews without splitting a Unicode code point', async () => {
    const { service } = fixture();
    const result = await service.saveNoteDraft('owner', 'unicode-body', {
      contentJson: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `${'a'.repeat(119)}😀tail` }],
        },
      ],
    });
    expect(result.contentPreview).toBe(`${'a'.repeat(119)}😀...`);
  });

  it('describes response section media and canonical card snapshots in OpenAPI', async () => {
    @Controller('drafts')
    class ProbeController {
      @Get() @ApiOkResponse({ type: NoteDraftDto }) get() {}
      @Get('published') @ApiOkResponse({ type: NoteDetailDto }) published() {}
    }
    const module = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    const app = module.createNestApplication();
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('Test').setVersion('1').build(),
      );
      const schemas = doc.components!.schemas! as Record<string, any>;
      expect(schemas.NoteDraftDto.properties.sections).toMatchObject({
        nullable: true,
        allOf: [{ $ref: '#/components/schemas/NoteDraftSectionsResponseDto' }],
      });
      expect(schemas.NoteDraftSectionsResponseDto.required ?? []).toEqual([]);
      expect(schemas.NoteDraftTextSectionResponseDto.required ?? []).toEqual(
        [],
      );
      expect(schemas.NoteDraftTextSectionResponseDto.properties).toMatchObject({
        content: { type: 'string', nullable: true },
        contentJson: { type: 'array', nullable: true },
      });
      expect(schemas.NoteSectionsResponseDto.required).toEqual(
        expect.arrayContaining(['text', 'media', 'showcase']),
      );
      for (const [section, name] of [
        ['audio', 'NoteMediaSectionResponseDto'],
        ['contacts', 'NoteContactSectionResponseDto'],
        ['groups', 'NoteGroupCardSectionResponseDto'],
      ]) {
        expect(
          schemas.NoteSectionsResponseDto.properties[section],
        ).toMatchObject({ $ref: `#/components/schemas/${name}` });
        expect(
          schemas.NoteDraftSectionsResponseDto.properties[section],
        ).toMatchObject({ $ref: `#/components/schemas/${name}` });
        expect(schemas[name].properties.items).toMatchObject({
          type: 'array',
          items: { $ref: expect.any(String) },
        });
      }
      expect(schemas.NoteSectionMediaResponseDto.properties).toMatchObject({
        objectKey: { type: 'string' },
        durationMs: { type: 'number', nullable: true },
      });
      expect(schemas.NoteContactCardResponseDto.properties).toMatchObject({
        id: { type: 'string' },
        name: { type: 'string' },
        faceURL: { type: 'string', nullable: true },
      });
      expect(
        schemas.NoteGroupCardResponseDto.properties.circleId,
      ).toMatchObject({ type: 'string' });
    } finally {
      await app.close();
    }
  });

  it('caps absent draft deletion and new draft creation while preserving active draft updates and deletion', async () => {
    const { service, prisma } = fixture();
    prisma.noteDraft.count.mockResolvedValue(1000);
    await expect(
      service.deleteNoteDraft('owner', 'never-created'),
    ).rejects.toThrow('Discarded IDs are retained for 30 days');
    await expect(
      service.saveNoteDraft('owner', 'new', {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
    prisma.noteDraft.findUnique.mockResolvedValue({
      id: 'existing',
      consumedAt: null,
      sourceNoteID: null,
    });
    await expect(
      service.saveNoteDraft('owner', 'existing', {}),
    ).resolves.toBeDefined();
    await expect(
      service.deleteNoteDraft('owner', 'existing'),
    ).resolves.toBeUndefined();
  });

  it('expires only owner-scoped discarded results and does not renew markers on repeated deletion', async () => {
    const { service, prisma } = fixture();
    prisma.noteDraft.findUnique.mockResolvedValue({
      consumedAt: new Date(),
      sourceNoteID: null,
      publishedNoteID: 'published',
    });
    await service.deleteNoteDraft('owner', 'already-consumed');
    expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
    expect(prisma.noteDraft.deleteMany).toHaveBeenCalledWith({
      where: {
        ownerID: 'owner',
        publishedNoteID: null,
        consumedAt: { lt: expect.any(Date) },
      },
    });
    const cutoff =
      prisma.noteDraft.deleteMany.mock.calls[0][0].where.consumedAt.lt.getTime();
    expect(
      Math.abs(cutoff - (Date.now() - 30 * 24 * 60 * 60 * 1000)),
    ).toBeLessThan(1000);
  });

  it('resolves nested key-only BlockNote draft media and inventories its poster', async () => {
    const { service, prisma } = fixture();
    const result = await service.saveNoteDraft('owner', 'block-media', {
      contentJson: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'video',
              props: {
                objectKey: 'notes/owner/video.mp4',
                posterUrl: 'https://storage.test/bucket/notes/owner/poster.jpg',
              },
            },
          ],
        },
      ],
    });
    const props = (result.contentJson![0] as any).children[0].props;
    expect(props.url).toBe(
      'https://signed.test/notes/owner/video.mp4?signature=test',
    );
    expect(props.posterUrl).toBe(
      'https://signed.test/notes/owner/poster.jpg?signature=test',
    );
    expect(result.mediaKeys).toEqual([
      'notes/owner/video.mp4',
      'notes/owner/poster.jpg',
    ]);
    expect(prisma.noteDraft.upsert.mock.calls[0][0].create.mediaKeys).toEqual(
      result.mediaKeys,
    );
    expect(result.mediaCount).toBe(1);
  });

  it('rejects foreign media keys inside contentJson', async () => {
    const { service, upload } = fixture();
    await expect(
      service.saveNoteDraft('owner', 'foreign-block', {
        contentJson: [
          { type: 'image', props: { objectKey: 'notes/another/private.jpg' } },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('never signs a legacy nested poster outside the validated draft inventory', async () => {
    const { service, prisma, upload } = fixture();
    const ownKey = 'notes/owner/video.mp4';
    const foreignKey = 'notes/another/private.jpg';
    prisma.noteDraft.findFirst.mockResolvedValue({
      ...row,
      mediaKeys: [ownKey],
      contentJson: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'video',
              props: {
                objectKey: ownKey,
                posterUrl: `https://storage.test/bucket/${foreignKey}`,
              },
            },
          ],
        },
      ],
    });
    const result = await service.getNoteDraft('owner', 'draft-1');
    expect((result.contentJson![0] as any).children[0].props.url).toBe(
      `https://signed.test/${ownKey}?signature=test`,
    );
    expect(upload.createPresignedGetUrl.mock.calls.map(([key]) => key)).toEqual(
      [ownKey],
    );
  });

  it('replaces omitted draft JSON with database null instead of retaining untracked media', async () => {
    const { service, prisma, upload } = fixture();
    let stored: any;
    const persisted = (data: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(data)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, value === Prisma.DbNull ? null : value]),
      );
    prisma.noteDraft.findUnique.mockImplementation(async () => stored ?? null);
    prisma.noteDraft.upsert.mockImplementation(async ({ create, update }) => {
      stored = stored
        ? { ...stored, ...persisted(update) }
        : { ...row, ...persisted(create) };
      return stored;
    });
    const image = {
      type: 'IMAGE' as const,
      objectKey: 'notes/owner/image.jpg',
      url: 'https://storage.test/bucket/notes/owner/image.jpg',
      sortOrder: 0,
    };
    await service.saveNoteDraft('owner', 'draft-1', {
      title: 'Image draft',
      contentJson: [{ type: 'image', props: image }],
      sections: { media: { items: [image] } },
    });
    upload.createPresignedGetUrl.mockClear();
    const result = await service.saveNoteDraft('owner', 'draft-1', {
      title: 'Title only',
    });
    expect(prisma.noteDraft.upsert.mock.calls[1][0].update).toMatchObject({
      contentJson: Prisma.DbNull,
      sections: Prisma.DbNull,
      mediaKeys: [],
    });
    expect(result.contentJson).toBeNull();
    expect(result.sections).toBeNull();
    expect(result.mediaCount).toBe(0);
    expect(result.mediaKeys).toEqual([]);
    expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
  });

  function publishedMediaRow(blocks: unknown[], media: unknown[]) {
    return {
      id: 'note-1',
      ownerID: 'owner',
      title: 'Nested media',
      content: 'Text',
      contentJson: blocks,
      sections: { text: { content: 'Text', contentJson: blocks } },
      status: 'ACTIVE',
      available: true,
      pinned: false,
      imageCount: 1,
      videoCount: 1,
      audioCount: 0,
      mediaCount: media.length,
      createdAt: new Date(),
      updatedAt: new Date(),
      coverMedia: null,
      groupMemberships: [],
      media,
    };
  }

  it.each([
    ['image', true],
    ['image', false],
    ['video', true],
    ['video', false],
  ] as const)(
    'refreshes authorized published nested %s props (expired URL: %s)',
    async (type, expired) => {
      const { service, prisma, upload } = fixture();
      const objectKey = `notes/owner/nested.${type === 'image' ? 'jpg' : 'mp4'}`;
      const url = `https://storage.test/bucket/${objectKey}`;
      const blocks = [
        {
          type: 'paragraph',
          children: [
            {
              type,
              props: {
                objectKey,
                ...(expired ? { url: `${url}?signature=expired` } : {}),
              },
            },
          ],
        },
      ];
      prisma.note.findFirst.mockResolvedValue(
        publishedMediaRow(blocks, [
          {
            id: 'media-1',
            type: type === 'image' ? 'IMAGE' : 'VIDEO',
            objectKey,
            url,
            sortOrder: 0,
          },
        ]),
      );
      const result = await service.getNote('owner', 'note-1');
      const signed = `https://signed.test/${objectKey}?signature=test`;
      expect((result.contentJson![0] as any).children[0].props.url).toBe(
        signed,
      );
      expect(
        (result.sections.text.contentJson![0] as any).children[0].props.url,
      ).toBe(signed);
      expect(result.media[0].url).toBe(signed);
      expect(
        upload.createPresignedGetUrl.mock.calls.map(([key]) => key),
      ).toEqual([objectKey]);
    },
  );

  it('does not sign foreign published inline keys absent from the NoteMedia inventory', async () => {
    const { service, prisma, upload } = fixture();
    const objectKey = 'notes/owner/valid.jpg';
    const foreignKey = 'notes/another/private.jpg';
    const blocks = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'image',
            props: { objectKey: foreignKey },
          },
        ],
      },
    ];
    prisma.note.findFirst.mockResolvedValue(
      publishedMediaRow(blocks, [
        {
          id: 'media-1',
          type: 'IMAGE',
          objectKey,
          url: `https://storage.test/bucket/${objectKey}`,
          sortOrder: 0,
        },
      ]),
    );
    const result = await service.getNote('owner', 'note-1');
    expect(upload.createPresignedGetUrl.mock.calls.map(([key]) => key)).toEqual(
      [objectKey],
    );
    expect(
      (result.sections.text.contentJson![0] as any).children[0].props.url,
    ).toBeFalsy();
  });

  it.each([
    ['audio', 'IMAGE'],
    ['showcase', 'AUDIO'],
    ['media', 'AUDIO'],
  ])('rejects %s sections containing %s', (section, type) => {
    const { service } = fixture();
    const item = {
      type,
      objectKey: 'notes/owner/media',
      url: 'https://storage.test/bucket/notes/owner/media',
    };
    expect(() =>
      (service as any).deriveNoteContent({
        title: 'Types',
        media: [item],
        sections: { [section]: { items: [item] } },
      }),
    ).toThrow(BadRequestException);
  });

  it('returns no cover for an audio-only note', () => {
    const { service } = fixture();
    const note = {
      id: 'audio',
      ownerID: 'owner',
      title: 'Audio',
      media: [{ type: 'AUDIO', url: 'https://storage.test/audio.m4a' }],
      sections: {},
    };
    expect((service as any).mapSummary(note, 'owner').cover).toBeNull();
  });

  it.each([false, true])(
    'looks up legacy OpenIM contact IDs canonically while preserving the advertised ID (self: %s)',
    async (self) => {
      const { service, prisma } = fixture();
      const id = 'aabbccdd-1122-0000-0000-123456789abc';
      const alias = id.replace(/-/g, '').toUpperCase();
      const person = {
        id,
        nickname: 'Friend',
        accountId: 'friend',
        avatarUrl: null,
      };
      if (self) prisma.user.findUnique.mockResolvedValue(person);
      else
        prisma.friend.findMany.mockResolvedValue([
          { userID: 'owner', friendID: id, friend: person },
        ] as any);
      const result = await (service as any).canonicalizeNoteCards(
        self ? id : 'owner',
        {
          sections: { contacts: { items: [{ id: alias, name: 'Untrusted' }] } },
        },
      );
      expect(result.sections.contacts.items).toEqual([
        { id: alias, name: 'Friend', faceURL: null },
      ]);
      if (!self)
        expect(
          prisma.friend.findMany.mock.calls[0][0].where.OR[0].friendID.in,
        ).toEqual([id]);
    },
  );

  function publicationFixture(sourceNoteID: string | null) {
    const value = fixture();
    const { prisma, service } = value;
    let draft: any = { ...row, sourceNoteID, consumedAt: null };
    prisma.noteDraft.findUnique.mockImplementation(async () => draft);
    prisma.noteDraft.upsert.mockImplementation(async ({ update }) => {
      draft = { ...draft, ...update };
      return draft;
    });
    prisma.noteDraft.update.mockImplementation(async ({ data }) => {
      draft = { ...draft, ...data };
      return draft;
    });
    const note = {
      id: 'note-1',
      ownerID: 'owner',
      status: 'ACTIVE',
      title: 'Updated',
      sections: {},
      media: [],
      groupMemberships: [],
    };
    prisma.note.findFirst.mockImplementation(async ({ where }) =>
      where.id ? (note as any) : null,
    );
    Object.assign(prisma.note, {
      create: jest.fn().mockResolvedValue(note),
      update: jest.fn().mockResolvedValue(note),
    });
    Object.assign(prisma.noteMedia, {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    });
    Object.assign(prisma, {
      noteGroupMembership: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    });
    jest
      .spyOn(service as any, 'assertNoteStorageAvailable')
      .mockResolvedValue(undefined);
    return { ...value, note, draft: () => draft };
  }

  it('persists and reads the canonical circleId after resolving a legacy groupID', async () => {
    const { service, prisma, note } = publicationFixture(null);
    prisma.circle.findMany.mockResolvedValue([
      {
        id: 'canonical-circle',
        groupID: 'legacy-group',
        name: 'Real group',
        avatarUrl: null,
      },
    ]);
    (prisma.note as any).create.mockImplementation(async ({ data }) =>
      Object.assign(note, data),
    );
    (prisma.note as any).update.mockImplementation(async ({ data }) =>
      Object.assign(note, data),
    );
    const result = await service.createNote('owner', {
      title: 'Group note',
      media: [],
      sections: {
        groups: { items: [{ id: 'legacy-group', name: 'Untrusted' }] },
      },
    });
    const expected = {
      id: 'legacy-group',
      circleId: 'canonical-circle',
      name: 'Real group',
      faceURL: null,
    };
    expect(
      (prisma.note as any).create.mock.calls[0][0].data.sections.groups.items,
    ).toEqual([expected]);
    expect(result.sections.groups.items).toEqual([expected]);
    expect(
      (await service.getNote('owner', 'note-1')).sections.groups.items,
    ).toEqual([expected]);
  });

  it('rejects a new keyed edit at the outcome cap before consuming its draft or changing the note', async () => {
    const { service, prisma, draft } = publicationFixture('note-1');
    prisma.noteDraft.count.mockResolvedValue(
      MAX_NOTE_EDIT_PUBLICATION_OUTCOMES,
    );
    await expect(
      service.updateNote('owner', 'note-1', {
        title: 'Must remain a draft',
        media: [],
        clientDraftID: 'draft-1',
      }),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'NOTE_PUBLICATION_QUOTA_REACHED',
        limit: MAX_NOTE_EDIT_PUBLICATION_OUTCOMES,
        current: MAX_NOTE_EDIT_PUBLICATION_OUTCOMES,
      },
      status: 403,
    });
    expect(prisma.noteDraft.count).toHaveBeenCalledWith({
      where: {
        ownerID: 'owner',
        sourceNoteID: 'note-1',
        publishedNoteID: { not: null },
      },
    });
    expect(draft().consumedAt).toBeNull();
    expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
    expect((prisma.note as any).update).not.toHaveBeenCalled();
    expect(prisma.noteMedia.deleteMany).not.toHaveBeenCalled();
  });

  it('permits a committed edit replay and editor cleanup at capacity without another quota check', async () => {
    const { service, prisma, draft } = publicationFixture('note-1');
    const input = { title: 'Committed', media: [], clientDraftID: 'draft-1' };
    await service.updateNote('owner', 'note-1', input);
    prisma.noteDraft.count
      .mockClear()
      .mockResolvedValue(MAX_NOTE_EDIT_PUBLICATION_OUTCOMES);
    await service.deleteNoteDraft('owner', 'draft-1');
    expect((await service.updateNote('owner', 'note-1', input)).id).toBe(
      'note-1',
    );
    expect(prisma.noteDraft.count).not.toHaveBeenCalled();
    expect(draft().publishedNoteID).toBe('note-1');
    expect((prisma.note as any).update).toHaveBeenCalledTimes(1);
  });

  it.each(['create', 'unkeyed edit'] as const)(
    'does not apply a per-note PATCH outcome cap to %s',
    async (action) => {
      const { service, prisma } = publicationFixture(
        action === 'create' ? null : 'note-1',
      );
      prisma.noteDraft.count.mockResolvedValue(
        MAX_NOTE_EDIT_PUBLICATION_OUTCOMES,
      );
      const input = {
        title: 'Allowed',
        media: [],
        ...(action === 'create' ? { clientDraftID: 'draft-1' } : {}),
      };
      if (action === 'create') await service.createNote('owner', input);
      else await service.updateNote('owner', 'note-1', input);
      expect(prisma.noteDraft.count).not.toHaveBeenCalled();
    },
  );

  it.each(['create', 'update'] as const)(
    'replays %s once after a post-commit signing failure and editor draft deletion',
    async (action) => {
      const { service, prisma, upload, note, draft } = publicationFixture(
        action === 'update' ? 'note-1' : null,
      );
      const media = {
        id: 'media-1',
        type: 'IMAGE' as const,
        objectKey: 'notes/owner/image.jpg',
        url: 'https://storage.test/bucket/notes/owner/image.jpg',
        sortOrder: 0,
      };
      (note.media as unknown[]).push(media);
      const input = {
        title: 'Saved',
        media: [media],
        clientDraftID: 'draft-1',
      };
      const save = () =>
        action === 'create'
          ? service.createNote('owner', input)
          : service.updateNote('owner', 'note-1', input);
      upload.createPresignedGetUrl.mockRejectedValueOnce(
        new Error('Signing unavailable'),
      );
      await expect(save()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(draft()).toMatchObject({
        consumedAt: expect.any(Date),
        publishedNoteID: 'note-1',
      });
      expect((await save()).id).toBe('note-1');
      await service.deleteNoteDraft('owner', 'draft-1');
      expect(draft().publishedNoteID).toBe('note-1');
      expect((await save()).id).toBe('note-1');
      expect((prisma.note as any).create).toHaveBeenCalledTimes(
        action === 'create' ? 1 : 0,
      );
      expect((prisma.note as any).update).toHaveBeenCalledTimes(1);
      expect(prisma.noteDraft.update).toHaveBeenCalledTimes(1);
      expect(prisma.noteMedia.createMany).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects publication after a draft was discarded', async () => {
    const { service, prisma } = publicationFixture(null);
    await service.deleteNoteDraft('owner', 'draft-1');
    await expect(
      service.createNote('owner', {
        title: 'Late publish',
        media: [],
        clientDraftID: 'draft-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((prisma.note as any).create).not.toHaveBeenCalled();
  });

  it('rejects a consumed edit draft replay for a different source note', async () => {
    const { service, prisma } = publicationFixture('note-1');
    await service.updateNote('owner', 'note-1', {
      title: 'Saved',
      media: [],
      clientDraftID: 'draft-1',
    });
    await expect(
      service.updateNote('owner', 'other-note', {
        title: 'Wrong replay',
        media: [],
        clientDraftID: 'draft-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((prisma.note as any).update).toHaveBeenCalledTimes(1);
  });

  it("does not replay another owner's published note through an edit request", async () => {
    const { service, prisma, draft } = publicationFixture('note-1');
    await service.updateNote('owner', 'note-1', {
      title: 'Saved',
      media: [],
      clientDraftID: 'draft-1',
    });
    prisma.noteDraft.findUnique.mockImplementation(async ({ where }) =>
      where.ownerID_clientDraftID.ownerID === 'owner' ? draft() : null,
    );
    prisma.note.findFirst.mockImplementation(async ({ where }) =>
      where.ownerID === 'owner' ? ({ id: 'note-1' } as any) : null,
    );
    await expect(
      service.updateNote('another-owner', 'note-1', {
        title: 'Wrong owner',
        media: [],
        clientDraftID: 'draft-1',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((prisma.note as any).update).toHaveBeenCalledTimes(1);
  });

  it('rejects replay when the published note is deleted without erasing its durable outcome', async () => {
    const { service, prisma, draft } = publicationFixture(null);
    const input = { title: 'Saved', media: [], clientDraftID: 'draft-1' };
    await service.createNote('owner', input);
    prisma.note.findFirst.mockResolvedValue(null);
    await expect(service.createNote('owner', input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(draft().publishedNoteID).toBe('note-1');
    expect((prisma.note as any).create).toHaveBeenCalledTimes(1);
  });

  it.each(['delete', 'update'] as const)(
    'rejects an autosave whose validation resumes after %s consumes the draft',
    async (action) => {
      const { service, prisma, draft } = publicationFixture(
        action === 'update' ? 'note-1' : null,
      );
      let resume!: () => void;
      const validation = new Promise<void>((resolve) => {
        resume = resolve;
      });
      jest
        .spyOn(service as any, 'requireOwnedGroups')
        .mockReturnValueOnce(validation);
      const autosave = service.saveNoteDraft('owner', 'draft-1', {
        sourceNoteId: action === 'update' ? 'note-1' : undefined,
        title: 'Late write',
      });
      if (action === 'update')
        await service.updateNote('owner', 'note-1', {
          title: 'Saved',
          media: [],
          clientDraftID: 'draft-1',
        });
      else await service.deleteNoteDraft('owner', 'draft-1');
      resume();
      await expect(autosave).rejects.toBeInstanceOf(ConflictException);
      expect(draft().consumedAt).toBeInstanceOf(Date);
      expect(draft().title).toBe('');
      expect(draft().mediaKeys).toEqual([]);
      expect(prisma.noteDraft.upsert).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['create', 'note-1'],
    ['update', null],
    ['update', 'other-note'],
  ] as const)(
    'rejects %s with a draft for %s before changing either note',
    async (action, source) => {
      const { service, prisma } = publicationFixture(source);
      const input = { title: 'Saved', media: [], clientDraftID: 'draft-1' };
      await expect(
        action === 'create'
          ? service.createNote('owner', input)
          : service.updateNote('owner', 'note-1', input),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.noteDraft.upsert).not.toHaveBeenCalled();
      expect((prisma.note as any).create).not.toHaveBeenCalled();
      expect((prisma.note as any).update).not.toHaveBeenCalled();
    },
  );
});

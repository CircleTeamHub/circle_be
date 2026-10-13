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
      circle: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      chatConversation: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      // 绑定独立群要求本人座位仍在：默认在群里，个别用例覆盖成已退群。
      chatMember: {
        findUnique: jest.fn().mockResolvedValue({ leftAt: null, remark: null }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(),
      // 事务内复核群主走 FOR SHARE 原生查询；默认与 findUnique 桩读到同一行。
      $queryRaw: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (run) => run(prisma));
    prisma.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray) => {
        // 事务内的座位复核与会话复核各读各的桩，口径与事务外一致。
        const sql = strings.join('');
        if (sql.includes('"ChatMember"')) {
          const seat = await prisma.chatMember.findUnique();
          return seat ? [seat] : [];
        }
        // 圈子群复核读圈子行；setSourceConversation 锁后重读笔记 sections。
        if (sql.includes('FROM "Circle"')) {
          const circle = await prisma.circle.findUnique();
          return circle ? [circle] : [];
        }
        if (sql.includes('FROM "Note"')) {
          const note = await prisma.note.findFirst({ where: { id: 'locked' } });
          return note ? [note] : [];
        }
        const conversation = await prisma.chatConversation.findUnique();
        return conversation ? [conversation] : [];
      },
    );
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
    // 圈子群聊会话懒创建：圈主绑群名片时由它补建，默认返回 null（建不出来）。
    const circleSync = {
      ensureCircleConversation: jest.fn().mockResolvedValue(null),
    };
    const service = new NoteService(
      prisma as any,
      config as any,
      policy as any,
      upload as any,
      undefined,
      circleSync as any,
    );
    return { service, prisma, policy, upload, circleSync };
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

  // 群名片挂的是群聊而不只是圈子：独立群聊（circleID 为空的 GROUP 会话）也要能存。
  it('accepts a standalone group chat card when the owner is still a member', async () => {
    const { service, prisma } = fixture();
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-standalone', name: ' 独立群 ', avatarUrl: null },
    ] as any);
    const result = await (service as any).canonicalizeNoteCards('owner', {
      sections: {
        groups: { items: [{ id: 'conv-standalone', name: 'client name' }] },
      },
    });
    expect(result.sections.groups.items).toEqual([
      {
        id: 'conv-standalone',
        name: '独立群',
        faceURL: null,
        conversationID: 'conv-standalone',
      },
    ]);
    expect(prisma.chatConversation.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['conv-standalone'] },
      type: 'GROUP',
      circleID: null,
      members: { some: { userID: 'owner', leftAt: null } },
    });
  });

  it('keeps the client display name for an unnamed standalone group chat', async () => {
    const { service, prisma } = fixture();
    prisma.chatConversation.findMany.mockResolvedValue([
      { id: 'conv-unnamed', name: null, avatarUrl: null },
    ] as any);
    const result = await (service as any).canonicalizeNoteCards('owner', {
      sections: {
        groups: { items: [{ id: 'conv-unnamed', name: '小明、小红' }] },
      },
    });
    expect(result.sections.groups.items).toEqual([
      {
        id: 'conv-unnamed',
        name: '小明、小红',
        faceURL: null,
        conversationID: 'conv-unnamed',
      },
    ]);
  });

  it('rejects a group chat card the owner is not (or no longer) a member of', async () => {
    const { service, prisma } = fixture();
    // 查询本身带着 members.leftAt = null 的条件，退群/非成员时查不到任何行。
    prisma.chatConversation.findMany.mockResolvedValue([]);
    await expect(
      (service as any).canonicalizeNoteCards('owner', {
        sections: {
          groups: { items: [{ id: 'conv-left', name: 'Left group' }] },
        },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not look up standalone chats for ids that already resolved to a circle', async () => {
    const { service, prisma } = fixture();
    prisma.circle.findMany.mockResolvedValue([
      { id: 'circle-1', groupID: null, name: 'Circle', avatarUrl: null },
    ] as any);
    await (service as any).canonicalizeNoteCards('owner', {
      sections: { groups: { items: [{ id: 'circle-1', name: 'Circle' }] } },
    });
    expect(prisma.chatConversation.findMany).not.toHaveBeenCalled();
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

  it('rejects more than 50 aggregate published media across sections', () => {
    const { service } = fixture();
    const items = (type: 'IMAGE' | 'AUDIO', start: number, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        type,
        objectKey: `notes/owner/${start + index}.${type === 'AUDIO' ? 'm4a' : 'jpg'}`,
        sortOrder: start + index,
      }));

    expect(() =>
      (service as any).deriveNoteContent({
        title: 'Too many media items',
        media: [],
        sections: {
          media: { items: items('IMAGE', 0, 50) },
          audio: { items: items('AUDIO', 50, 1) },
        },
      }),
    ).toThrow(BadRequestException);
  });

  it('includes audio references in whole-note PDF and image exports', () => {
    const { service } = fixture();
    const audio = {
      type: 'AUDIO',
      objectKey: 'notes/owner/voice.m4a',
      url: 'https://storage.test/bucket/notes/owner/voice.m4a',
      sortOrder: 0,
    };

    expect(
      (service as any).getExportSectionMedia({
        text: { content: null, contentJson: null },
        media: { items: [] },
        showcase: { items: [] },
        audio: { items: [audio] },
      }),
    ).toEqual([audio]);
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
      expect(
        schemas.NoteGroupCardResponseDto.properties.conversationID,
      ).toMatchObject({ type: 'string' });
      expect(schemas.NoteCardPeerDto.properties.conversationID).toMatchObject({
        type: 'string',
        nullable: true,
      });
      expect(schemas.NoteCardPeerDto.properties.circleId).toMatchObject({
        type: 'string',
        nullable: true,
      });
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
    // 群名片即绑定：legacy groupID → 圈子 → 圈子群会话，owner 是圈主。
    prisma.chatConversation.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'conv-1' } as any);
    prisma.circle.findFirst.mockResolvedValue({
      id: 'canonical-circle',
    } as any);
    prisma.chatConversation.findUnique.mockResolvedValue({
      type: 'GROUP',
      ownerID: null,
      circleID: 'canonical-circle',
      name: null,
      avatarUrl: null,
    } as any);
    prisma.circle.findUnique.mockResolvedValue({
      id: 'canonical-circle',
      name: 'Real group',
      avatarUrl: null,
      ownerID: 'owner',
      deleted: false,
    } as any);
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
    expect(
      (prisma.note as any).create.mock.calls[0][0].data.sourceConversationID,
    ).toBe('conv-1');
    expect(result.sections.groups.items).toEqual([expected]);
    expect(
      (await service.getNote('owner', 'note-1')).sections.groups.items,
    ).toEqual([expected]);
  });

  // 收藏时独立群名片换成收藏者自己的视角：原主人的私人群备注、拿成员昵称拼的兜底名
  // 都不能跟着副本外泄。
  describe('group cards copied on collect', () => {
    const sections = (items: unknown[]) => ({
      text: { content: '正文' },
      groups: { items },
    });

    it('drops a standalone group card the collector is not a member of', async () => {
      const { service, prisma } = fixture();
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-u', name: null },
      ]);
      prisma.chatMember.findMany.mockResolvedValue([]);
      const result = await (service as any).groupCardsForCollector(
        'collector',
        sections([
          { id: 'conv-u', name: '老板的私人备注', conversationID: 'conv-u' },
        ]),
      );
      expect(result).toEqual({ text: { content: '正文' } });
    });

    it('renames an unnamed standalone group card from the collector own view', async () => {
      const { service, prisma } = fixture();
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-u', name: null },
      ]);
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-u' },
      ]);
      prisma.chatMember.findUnique.mockResolvedValue({
        leftAt: null,
        remark: '我给这个群的备注',
      });
      const result = await (service as any).groupCardsForCollector(
        'collector',
        sections([
          { id: 'conv-u', name: '老板的私人备注', conversationID: 'conv-u' },
        ]),
      );
      expect(result.groups.items).toEqual([
        {
          id: 'conv-u',
          name: '我给这个群的备注',
          conversationID: 'conv-u',
        },
      ]);
      // 只查收藏者本人的座位与备注。
      expect(prisma.chatMember.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversationID_userID: {
              conversationID: 'conv-u',
              userID: 'collector',
            },
          },
        }),
      );
    });

    it('keeps circle group cards and named standalone groups use their real name', async () => {
      const { service, prisma } = fixture();
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-n', name: '真实群名' },
      ]);
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-n' },
      ]);
      const result = await (service as any).groupCardsForCollector(
        'collector',
        sections([
          { id: 'circle-1', name: '公开圈子' },
          { id: 'conv-n', name: '旧名字', conversationID: 'conv-n' },
        ]),
      );
      expect(result.groups.items).toEqual([
        { id: 'circle-1', name: '公开圈子' },
        { id: 'conv-n', name: '真实群名', conversationID: 'conv-n' },
      ]);
    });
  });

  // 旧版圈子卡片 id 是 OpenIM groupID、没存 circleId：读取时补上规范圈子 UUID，
  // 客户端才能按圈子路由（只改内存，不落库）。
  it('fills the canonical circleId for legacy groupID cards on read', async () => {
    const { service, prisma } = fixture();
    prisma.circle.findMany.mockResolvedValue([
      { id: 'circle-uuid', groupID: 'legacy-gid' },
    ]);
    const [note] = await (service as any).withLegacyCircleIds([
      {
        id: 'n1',
        sections: {
          groups: {
            items: [
              { id: 'legacy-gid', name: '老圈子' },
              { id: 'conv-s', name: '独立群', conversationID: 'conv-s' },
            ],
          },
        },
      },
    ]);
    expect(note.sections.groups.items).toEqual([
      { id: 'legacy-gid', name: '老圈子', circleId: 'circle-uuid' },
      { id: 'conv-s', name: '独立群', conversationID: 'conv-s' },
    ]);
    expect(prisma.circle.findMany).toHaveBeenCalledWith({
      where: { groupID: { in: ['legacy-gid'] } },
      select: { id: true, groupID: true },
    });
  });

  describe('group card is the group binding (笔记管理)', () => {
    function standaloneOwnedBy(prisma: any, ownerID: string) {
      prisma.chatConversation.findFirst.mockResolvedValue({ id: 'conv-s' });
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        ownerID,
        circleID: null,
        name: '独立群',
        avatarUrl: null,
      });
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-s', name: '独立群', avatarUrl: null },
      ]);
    }

    it('binds the note to the standalone group its owner picked', async () => {
      const { service, prisma } = publicationFixture(null);
      standaloneOwnedBy(prisma, 'owner');
      await service.createNote('owner', {
        title: 'Bound',
        media: [],
        sections: { groups: { items: [{ id: 'conv-s', name: 'x' }] } },
      });
      const data = (prisma.note as any).create.mock.calls[0][0].data;
      expect(data.sourceConversationID).toBe('conv-s');
      expect(data.sections.groups.items).toEqual([
        {
          id: 'conv-s',
          name: '独立群',
          faceURL: null,
          conversationID: 'conv-s',
        },
      ]);
    });

    it('creates the lazy circle conversation when the circle owner binds its card', async () => {
      const { service, prisma, circleSync } = publicationFixture(null);
      // 圈子还没有群聊会话：第一次查不到，补建后能读到圈子群的会话行。
      prisma.circle.findFirst.mockResolvedValue({
        id: 'circle-1',
        ownerID: 'owner',
      });
      circleSync.ensureCircleConversation.mockResolvedValue('conv-c');
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        ownerID: null,
        circleID: 'circle-1',
        name: null,
        avatarUrl: null,
      });
      prisma.circle.findUnique.mockResolvedValue({
        id: 'circle-1',
        ownerID: 'owner',
        name: '圈子群',
        avatarUrl: null,
      });
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-1', groupID: null, name: '圈子群', avatarUrl: null },
      ]);
      await service.createNote('owner', {
        title: 'Bound to circle',
        media: [],
        sections: { groups: { items: [{ id: 'circle-1', name: 'x' }] } },
      });
      expect(circleSync.ensureCircleConversation).toHaveBeenCalledWith(
        'circle-1',
      );
      const data = (prisma.note as any).create.mock.calls[0][0].data;
      expect(data.sourceConversationID).toBe('conv-c');
    });

    it('never creates a circle conversation for someone who does not own the circle', async () => {
      const { service, prisma, circleSync } = publicationFixture(null);
      prisma.circle.findFirst.mockResolvedValue({
        id: 'circle-1',
        ownerID: 'someone-else',
      });
      await expect(
        service.createNote('owner', {
          title: 'Not my circle',
          media: [],
          sections: { groups: { items: [{ id: 'circle-1', name: 'x' }] } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(circleSync.ensureCircleConversation).not.toHaveBeenCalled();
      expect((prisma.note as any).create).not.toHaveBeenCalled();
    });

    it('rejects a group card for a group the author does not own', async () => {
      const { service, prisma } = publicationFixture(null);
      standaloneOwnedBy(prisma, 'someone-else');
      await expect(
        service.createNote('owner', {
          title: 'Not mine',
          media: [],
          sections: { groups: { items: [{ id: 'conv-s', name: 'x' }] } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((prisma.note as any).create).not.toHaveBeenCalled();
    });

    it('clearing the group card on a source note unbinds it', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: 'conv-s',
        collectedFromNoteID: null,
        sections: {
          groups: { items: [{ id: 'conv-s', name: '独立群', faceURL: null }] },
        },
      });
      await service.updateNote('owner', 'note-1', {
        title: 'Unbind',
        media: [],
        sections: { groups: { items: [] } },
      });
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data.sourceConversationID).toBeNull();
      expect(data.sections.groups).toEqual({ items: [] });
    });

    it('keeps an unchanged binding without re-checking ownership', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: 'conv-s',
        collectedFromNoteID: null,
        sections: {
          groups: { items: [{ id: 'conv-s', name: '独立群', faceURL: null }] },
        },
      });
      // 群主已转让：只改正文、群名片没换，保存不能被拦下。
      standaloneOwnedBy(prisma, 'new-owner');
      await service.updateNote('owner', 'note-1', {
        title: 'Text only',
        media: [],
        sections: { groups: { items: [{ id: 'conv-s', name: '独立群' }] } },
      });
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data).not.toHaveProperty('sourceConversationID');
      expect(data.sections.groups.items).toEqual([
        { id: 'conv-s', name: '独立群', faceURL: null },
      ]);
    });

    // Codex P1：以前群成员也能加群名片，旧笔记有名片而没有绑定。原样带回来
    // 保存不是新绑定，不能要求群主权限，绑定也要保持为空。
    it('saves a legacy unbound group card unchanged for a non-owner member', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: null,
        collectedFromNoteID: null,
        sections: {
          groups: { items: [{ id: 'conv-s', name: '独立群', faceURL: null }] },
        },
      });
      standaloneOwnedBy(prisma, 'someone-else');
      await service.updateNote('owner', 'note-1', {
        title: 'Text only',
        media: [],
        sections: { groups: { items: [{ id: 'conv-s', name: '独立群' }] } },
      });
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data).not.toHaveProperty('sourceConversationID');
      expect(data.sections.groups.items).toEqual([
        { id: 'conv-s', name: '独立群', faceURL: null },
      ]);
      // 名片没换：不触发任何群主 / 座位复核。
      expect(prisma.chatConversation.findUnique).not.toHaveBeenCalled();
    });

    it('still requires group ownership when a legacy unbound note switches to another group card', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: null,
        collectedFromNoteID: null,
        sections: {
          groups: { items: [{ id: 'conv-old', name: '旧群', faceURL: null }] },
        },
      });
      standaloneOwnedBy(prisma, 'someone-else');
      await expect(
        service.updateNote('owner', 'note-1', {
          title: 'Switch',
          media: [],
          sections: { groups: { items: [{ id: 'conv-s', name: 'x' }] } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((prisma.note as any).update).not.toHaveBeenCalled();
    });

    it('treats an already-bound card as changed when it is not the single stored card', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: 'conv-old',
        collectedFromNoteID: null,
        sections: {
          groups: { items: [{ id: 'conv-old', name: '旧群', faceURL: null }] },
        },
      });
      standaloneOwnedBy(prisma, 'someone-else');
      await expect(
        service.updateNote('owner', 'note-1', {
          title: 'Switch',
          media: [],
          sections: { groups: { items: [{ id: 'conv-s', name: 'x' }] } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // Codex P2：独立群可以没有群名，绑定时沿用提交的名字（本人在群里才算数）。
    function unnamedStandaloneOwnedBy(prisma: any, member: boolean) {
      prisma.chatConversation.findFirst.mockResolvedValue({ id: 'conv-u' });
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        ownerID: 'owner',
        circleID: null,
        name: null,
        avatarUrl: null,
      });
      prisma.chatConversation.findMany.mockResolvedValue(
        member ? [{ id: 'conv-u', name: null, avatarUrl: null }] : [],
      );
    }

    it('binds an unnamed standalone group on create using the submitted name', async () => {
      const { service, prisma } = publicationFixture(null);
      unnamedStandaloneOwnedBy(prisma, true);
      await service.createNote('owner', {
        title: 'Unnamed',
        media: [],
        sections: {
          groups: { items: [{ id: 'conv-u', name: ' 小明、小红 ' }] },
        },
      });
      const data = (prisma.note as any).create.mock.calls[0][0].data;
      expect(data.sourceConversationID).toBe('conv-u');
      expect(data.sections.groups.items).toEqual([
        {
          id: 'conv-u',
          name: '小明、小红',
          faceURL: null,
          conversationID: 'conv-u',
        },
      ]);
    });

    it('binds an unnamed standalone group on update using the submitted name', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: null,
        collectedFromNoteID: null,
        sections: {},
      });
      unnamedStandaloneOwnedBy(prisma, true);
      await service.updateNote('owner', 'note-1', {
        title: 'Unnamed',
        media: [],
        sections: { groups: { items: [{ id: 'conv-u', name: '小明、小红' }] } },
      });
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data.sourceConversationID).toBe('conv-u');
      expect(data.sections.groups.items).toEqual([
        {
          id: 'conv-u',
          name: '小明、小红',
          faceURL: null,
          conversationID: 'conv-u',
        },
      ]);
    });

    it('rejects an unnamed standalone group the author has left, even as its recorded owner', async () => {
      const { service, prisma } = publicationFixture(null);
      unnamedStandaloneOwnedBy(prisma, false);
      await expect(
        service.createNote('owner', {
          title: 'Left',
          media: [],
          sections: { groups: { items: [{ id: 'conv-u', name: '小明' }] } },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect((prisma.note as any).create).not.toHaveBeenCalled();
    });

    // 兜底名会回到客户端、下次保存原样提交：超过 DTO 上限这篇笔记就再也存不进去。
    it('clamps a member-derived group card name to the DTO limit', async () => {
      const { service, prisma } = publicationFixture(null);
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        ownerID: 'owner',
        circleID: null,
        name: null,
        avatarUrl: null,
      });
      prisma.chatMember.findMany.mockResolvedValue([
        { userID: 'u1' },
        { userID: 'u2' },
        { userID: 'u3' },
      ]);
      prisma.user.findMany.mockResolvedValue(
        ['u1', 'u2', 'u3'].map((id) => ({
          id,
          nickname: '长'.repeat(50),
          accountId: id,
        })),
      );
      await service.setSourceConversation('owner', 'note-1', 'conv-u');
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(Array.from(data.sections.groups.items[0].name)).toHaveLength(120);
    });

    // 旧版「笔记管理」绑无名独立群只写了绑定、没存名片；客户端保存总会带空的
    // groups，不能因此静默解绑。
    it('keeps a legacy binding that never stored a card when a save sends no group card', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: 'conv-legacy',
        collectedFromNoteID: null,
        sections: { text: { content: '旧' } },
      });
      await service.updateNote('owner', 'note-1', {
        title: 'Edited',
        media: [],
        sections: { groups: { items: [] } },
      });
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data).not.toHaveProperty('sourceConversationID');
    });

    it('still unbinds when a stored group card is cleared', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: 'conv-s',
        collectedFromNoteID: null,
        sections: { groups: { items: [{ id: 'conv-s', name: '群' }] } },
      });
      await service.updateNote('owner', 'note-1', {
        title: 'Edited',
        media: [],
        sections: { groups: { items: [] } },
      });
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data.sourceConversationID).toBeNull();
    });

    // 多张群名片只为兼容多选时代的存量；夹带新名片会绕过「只有群主能绑」。
    it.each([
      ['create', null],
      ['update', [{ id: 'old', name: '旧群' }]],
    ])(
      'rejects several group cards that include one not already stored (%s)',
      async (mode, storedItems) => {
        const { service, prisma, note } = publicationFixture(null);
        Object.assign(note, {
          sourceConversationID: null,
          collectedFromNoteID: null,
          sections: storedItems ? { groups: { items: storedItems } } : {},
        });
        const input = {
          title: 'Two cards',
          media: [],
          sections: {
            groups: {
              items: [
                { id: 'old', name: '旧群' },
                { id: 'new', name: '新群' },
              ],
            },
          },
        };
        await expect(
          mode === 'create'
            ? service.createNote('owner', input)
            : service.updateNote('owner', 'note-1', input),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect((prisma.note as any).create).not.toHaveBeenCalled();
        expect((prisma.note as any).update).not.toHaveBeenCalled();
      },
    );

    // 普通编辑在事务内锁读笔记行，与「笔记管理」换绑互斥。
    it('locks the note row when an ordinary edit rereads it inside the transaction', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, { collectedFromNoteID: null, sections: {} });
      await service.updateNote('owner', 'note-1', {
        title: 'Edited',
        media: [],
      });
      const lock = prisma.$queryRaw.mock.calls.find(
        ([strings]: [TemplateStringsArray]) =>
          strings.join('?').includes('FROM "Note"'),
      );
      expect(lock?.[0].join('?')).toContain('FOR UPDATE');
    });

    // 事务外预检之后、写入事务里群的状态变了：以事务内复核为准（普通读，不在会话 /
    // 座位 / 圈子这些热点行上加锁，见 assertCanBindGroup 的说明）。
    function changedInsideTransaction(
      prisma: any,
      override: (prisma: any) => Record<string, unknown>,
    ) {
      const txReads = override(prisma);
      prisma.$transaction.mockImplementation(async (run: any) =>
        run({ ...prisma, ...txReads }),
      );
      return txReads;
    }

    const raced = [
      [
        'ownership transferred',
        (prisma: any) => ({
          chatConversation: {
            ...prisma.chatConversation,
            findUnique: jest.fn().mockResolvedValue({
              type: 'GROUP',
              ownerID: 'new-owner',
              circleID: null,
            }),
          },
        }),
      ],
      [
        'group dissolved (seat left, owner unchanged)',
        (prisma: any) => ({
          chatMember: {
            ...prisma.chatMember,
            findUnique: jest.fn().mockResolvedValue({ leftAt: new Date() }),
          },
        }),
      ],
    ] as const;

    it.each(
      raced.flatMap(([label, override]) =>
        (['create', 'update'] as const).map(
          (mode) => [mode, label, override] as const,
        ),
      ),
    )(
      'rechecks the binding inside the %s transaction: %s',
      async (mode, _label, override) => {
        const { service, prisma, note } = publicationFixture(null);
        Object.assign(note, {
          sourceConversationID: null,
          collectedFromNoteID: null,
          sections: {},
        });
        standaloneOwnedBy(prisma, 'owner');
        const txReads = changedInsideTransaction(prisma, override);
        const input = {
          title: 'Raced',
          media: [],
          sections: { groups: { items: [{ id: 'conv-s', name: 'x' }] } },
        };
        await expect(
          mode === 'create'
            ? service.createNote('owner', input)
            : service.updateNote('owner', 'note-1', input),
        ).rejects.toMatchObject({
          response: expect.objectContaining({
            errorCode: 'NOTE_GROUP_BIND_FORBIDDEN',
          }),
        });
        const reread = Object.values(txReads)[0] as any;
        expect(reread.findUnique).toHaveBeenCalled();
        // 不在会话 / 座位行上加锁：这些行每条消息都在更新。
        const lockedHotRow = prisma.$queryRaw.mock.calls.some(
          ([strings]: [TemplateStringsArray]) =>
            /FROM "(ChatConversation|ChatMember|Circle)"/.test(
              strings.join('?'),
            ),
        );
        expect(lockedHotRow).toBe(false);
        expect((prisma.note as any).create).not.toHaveBeenCalled();
        expect((prisma.note as any).update).not.toHaveBeenCalled();
      },
    );

    // Codex P2：「笔记管理」绑定接口只带 conversationID，没有客户端展示名。
    // 无名独立群要由服务端给出名字，不能绑上了却把群名片删掉。
    function unnamedStandalone(prisma: any) {
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        ownerID: 'owner',
        circleID: null,
        name: null,
        avatarUrl: null,
      });
      prisma.chatMember.findMany.mockResolvedValue([
        { userID: 'u1' },
        { userID: 'u2' },
      ]);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u2', nickname: '小红', accountId: 'b' },
        { id: 'u1', nickname: '', accountId: 'xiaoming' },
      ]);
    }

    it('binds an unnamed standalone group from group settings with a member-derived name', async () => {
      const { service, prisma } = publicationFixture(null);
      unnamedStandalone(prisma);
      await service.setSourceConversation('owner', 'note-1', 'conv-u');
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data.sourceConversationID).toBe('conv-u');
      // 按入群先后取成员昵称，没昵称用账号。
      expect(data.sections.groups.items).toEqual([
        {
          id: 'conv-u',
          name: 'xiaoming、小红',
          faceURL: null,
          conversationID: 'conv-u',
        },
      ]);
    });

    it('prefers my own group remark as the name of an unnamed standalone group', async () => {
      const { service, prisma } = publicationFixture(null);
      unnamedStandalone(prisma);
      prisma.chatMember.findUnique.mockResolvedValue({
        leftAt: null,
        remark: ' 我的小群 ',
      });
      await service.setSourceConversation('owner', 'note-1', 'conv-u');
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data.sections.groups.items[0].name).toBe('我的小群');
      expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
    });

    // Codex P1：只换群名片的「笔记管理」绑定不能用事务外读到的旧 sections 整体写回，
    // 否则会冲掉并发的普通编辑刚保存的正文/媒体/名片。
    it('rebinding from group settings keeps a content edit that committed in between', async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        collectedFromNoteID: null,
        sections: { text: { content: '旧正文' } },
      });
      standaloneOwnedBy(prisma, 'owner');
      const original = prisma.$queryRaw.getMockImplementation()!;
      prisma.$queryRaw.mockImplementation(
        async (strings: TemplateStringsArray, ...values: unknown[]) =>
          strings.join('').includes('FROM "Note"')
            ? // 锁后读到的是并发编辑已提交的最新内容。
              [
                {
                  sections: {
                    text: { content: '新正文' },
                    contacts: { items: [{ id: 'u1', name: '新名片' }] },
                  },
                },
              ]
            : original(strings, ...values),
      );
      await service.setSourceConversation('owner', 'note-1', 'conv-s');
      const lockQuery = prisma.$queryRaw.mock.calls.find(([strings]) =>
        strings.join('?').includes('FROM "Note"'),
      );
      expect(lockQuery?.[0].join('?')).toContain('FOR UPDATE');
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data.sections.text).toEqual({ content: '新正文' });
      expect(data.sections.contacts).toEqual({
        items: [{ id: 'u1', name: '新名片' }],
      });
      expect(data.sections.groups.items[0].id).toBe('conv-s');
    });

    // Codex P2：停用/解散中间态的圈子 deleted 仍为 false，聊天侧已默认拒绝，不能绑。
    function disabledCircleGroup(prisma: any, adminState: string) {
      prisma.chatConversation.findFirst.mockResolvedValue({ id: 'conv-c' });
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        ownerID: 'owner',
        circleID: 'circle-1',
        name: null,
        avatarUrl: null,
      });
      prisma.circle.findUnique.mockResolvedValue({
        id: 'circle-1',
        ownerID: 'owner',
        deleted: false,
        adminState,
        name: '圈子群',
        avatarUrl: null,
      });
      // 名片可访问性检查（deleted=false + 圈主/成员）照常通过：只剩管理态能拦。
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-1', groupID: null, name: '圈子群', avatarUrl: null },
      ]);
    }

    it.each([
      ['create', 'DISABLED'],
      ['update', 'DISABLING'],
      ['create', 'SYNC_FAILED'],
    ])(
      'rejects binding a circle group whose circle is administratively unavailable (%s, %s)',
      async (mode, adminState) => {
        const { service, prisma, note } = publicationFixture(null);
        Object.assign(note, {
          sourceConversationID: null,
          collectedFromNoteID: null,
          sections: {},
        });
        disabledCircleGroup(prisma, adminState);
        const input = {
          title: 'Disabled circle',
          media: [],
          sections: { groups: { items: [{ id: 'circle-1', name: 'x' }] } },
        };
        await expect(
          mode === 'create'
            ? service.createNote('owner', input)
            : service.updateNote('owner', 'note-1', input),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect((prisma.note as any).create).not.toHaveBeenCalled();
        expect((prisma.note as any).update).not.toHaveBeenCalled();
      },
    );

    it('still binds an active circle group for its owner', async () => {
      const { service, prisma } = publicationFixture(null);
      disabledCircleGroup(prisma, 'ACTIVE');
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-1', groupID: null, name: '圈子群', avatarUrl: null },
      ]);
      await service.createNote('owner', {
        title: 'Active circle',
        media: [],
        sections: { groups: { items: [{ id: 'circle-1', name: 'x' }] } },
      });
      const data = (prisma.note as any).create.mock.calls[0][0].data;
      expect(data.sourceConversationID).toBe('conv-c');
    });

    // 前端 P1：独立群名片要带服务端可信的 conversationID，圈子群不带，请求里伪造的不收。
    it('never keeps a request conversationID: circle cards drop it, standalone cards get the server value', async () => {
      const { service, prisma } = fixture();
      prisma.circle.findMany.mockResolvedValue([
        { id: 'circle-1', groupID: null, name: 'Circle', avatarUrl: null },
      ] as any);
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-s', name: '独立群', avatarUrl: null },
      ] as any);
      const result = await (service as any).canonicalizeNoteCards('owner', {
        sections: {
          groups: {
            items: [
              { id: 'circle-1', name: 'Circle', conversationID: 'forged' },
              { id: 'conv-s', name: '独立群', conversationID: 'forged' },
            ],
          },
        },
      });
      expect(result.sections.groups.items).toEqual([
        { id: 'circle-1', name: 'Circle', faceURL: null },
        {
          id: 'conv-s',
          name: '独立群',
          faceURL: null,
          conversationID: 'conv-s',
        },
      ]);
    });

    it('keeps the stored conversationID of an unchanged card instead of the request one', async () => {
      const { service } = fixture();
      const result = await (service as any).canonicalizeNoteCards(
        'owner',
        {
          sections: {
            groups: {
              items: [
                { id: 'conv-s', name: 'x', conversationID: 'forged' },
                { id: 'circle-1', name: 'y', conversationID: 'forged' },
              ],
            },
          },
        },
        {
          groups: {
            items: [
              {
                id: 'conv-s',
                name: '独立群',
                faceURL: null,
                conversationID: 'conv-s',
              },
              { id: 'circle-1', name: 'Circle', faceURL: null },
            ],
          },
        },
      );
      expect(result.sections.groups.items).toEqual([
        {
          id: 'conv-s',
          name: '独立群',
          faceURL: null,
          conversationID: 'conv-s',
        },
        { id: 'circle-1', name: 'Circle', faceURL: null },
      ]);
    });

    it('tags a collected standalone origin group card with its conversationID', async () => {
      const { service, prisma } = fixture();
      // 绑定过的源笔记：按绑定的会话解析。
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        circleID: null,
        name: '独立群',
        avatarUrl: null,
      });
      const bound = await (service as any).resolveOriginGroupCard(
        { sourceConversationID: 'conv-s' },
        undefined,
      );
      expect(bound).toMatchObject({ id: 'conv-s', conversationID: 'conv-s' });
      // 没绑定的旧笔记：聊天里带来的群 id 核实是独立群才补。
      const fallback = await (service as any).resolveOriginGroupCard(
        { sourceConversationID: null },
        { id: 'conv-s', name: '聊天里的群' },
      );
      expect(fallback).toEqual({
        id: 'conv-s',
        name: '聊天里的群',
        conversationID: 'conv-s',
      });
      prisma.chatConversation.findUnique.mockResolvedValue({
        type: 'GROUP',
        circleID: 'circle-1',
      });
      const circleFallback = await (service as any).resolveOriginGroupCard(
        { sourceConversationID: null },
        { id: 'circle-1', name: '圈子群', conversationID: 'forged' },
      );
      expect(circleFallback).toEqual({ id: 'circle-1', name: '圈子群' });

      const sections = (service as any).applyCollectSourceCards(
        {},
        {
          sender: { id: 'u2', name: '小王' },
          group: { id: 'conv-s', name: 'x' },
        },
        fallback,
      );
      expect(sections.groups.items).toEqual([
        {
          id: 'conv-s',
          name: '聊天里的群',
          faceURL: null,
          conversationID: 'conv-s',
        },
      ]);
    });

    it("leaves a collected copy's source group card fixed and unbound", async () => {
      const { service, prisma, note } = publicationFixture(null);
      Object.assign(note, {
        sourceConversationID: null,
        collectedFromNoteID: 'origin-note',
        sections: {
          groups: { items: [{ id: 'conv-s', name: '来源群', faceURL: null }] },
        },
      });
      // 读收藏副本详情会沿收藏链查原笔记；本用例只看写入。
      (prisma.note as any).findMany = jest.fn().mockResolvedValue([]);
      await service.updateNote('owner', 'note-1', {
        title: 'Copy',
        media: [],
        sections: { groups: { items: [] } },
      });
      const data = (prisma.note as any).update.mock.calls.at(-1)[0].data;
      expect(data).not.toHaveProperty('sourceConversationID');
      expect(data.sections.groups.items).toEqual([
        { id: 'conv-s', name: '来源群', faceURL: null },
      ]);
    });
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

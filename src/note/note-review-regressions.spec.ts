import {
  Controller,
  Get,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiOkResponse, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { NoteService } from './note.service';
import { NoteSummaryDto } from './dto/note.dto';

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
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest
          .fn()
          .mockImplementation(({ create }) =>
            Promise.resolve({ ...row, ...create }),
          ),
        deleteMany: jest.fn(),
      },
      note: { findFirst: jest.fn().mockResolvedValue(null) },
      noteMedia: { findMany: jest.fn().mockResolvedValue([]) },
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
        key === 'MINIO_PUBLIC_URL' ? 'https://storage.test/bucket' : undefined,
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
      where: { ownerID: 'owner' },
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
});

import { Prisma } from 'src/generated/prisma';
import { NoteService } from './note.service';

/**
 * 圈子动态附带的笔记卡片（NoteService.projectPlazaNoteCards → PlazaPostDto.noteCard）。
 * 摘要投影本身（预览、计数、封面）与「我的笔记」列表同一套，真库对照在
 * test/postgres/note-list-summary.pg-spec.ts；这里守卡片的口径：访客视角、批量一次、
 * 他人读不到的只给标题与状态且不签媒体、收藏副本看根的实时状态。
 */
describe('NoteService.projectPlazaNoteCards', () => {
  type Row = ReturnType<typeof row>;
  const row = (
    id: string,
    fields: Partial<{
      status: 'ACTIVE' | 'UNLISTED' | 'DELETED';
      available: boolean;
      workStatus: 'WORKING' | 'CLOSED' | null;
      collectedFromNoteID: string | null;
    }> = {},
  ) => ({
    id,
    ownerID: 'author-1',
    title: `title ${id}`,
    status: fields.status ?? 'ACTIVE',
    unlistedAt: null,
    available: fields.available ?? true,
    workStatus: fields.workStatus ?? null,
    sourceConversationID: 'conv-1',
    pinned: true,
    remark: 'private remark',
    city: '上海',
    imageCount: 2,
    videoCount: 1,
    audioCount: 0,
    mediaCount: 3,
    collectedFrom: null,
    collectedFromNoteID: fields.collectedFromNoteID ?? null,
    rootSourceNoteID: fields.collectedFromNoteID ?? null,
    createdAt: new Date('2026-11-01T00:00:00.000Z'),
    updatedAt: new Date('2026-11-02T00:00:00.000Z'),
    groupMemberships: [],
  });
  const projection = (id: string) => ({
    id,
    contentHead: `content of ${id}`,
    sectionTextHasText: null,
    hasJsonText: false,
    showcaseCount: 1,
    contactItems: [{ id: 'friend-1', name: '老王', faceURL: null }],
    groupItems: null,
    hasLocation: true,
    coverId: `cover-${id}`,
    coverType: 'IMAGE',
    coverUrl: `https://minio/notes/author-1/${id}-cover.jpg`,
    coverObjectKey: `notes/author-1/${id}-cover.jpg`,
    coverNoteID: id,
  });

  function fixture(table: Row[]) {
    const prisma = {
      $queryRaw: jest.fn(async (query: Prisma.Sql) =>
        (query.values.find(Array.isArray) as string[]).map(projection),
      ),
      note: {
        findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
          table.filter((note) => args.where.id.in.includes(note.id)),
        ),
      },
      noteRatingMonthly: { findMany: jest.fn().mockResolvedValue([]) },
      noteMedia: {
        findMany: jest.fn(
          async (args: { where: { noteID: { in: string[] } } }) =>
            args.where.noteID.in.flatMap((noteID) => [
              { noteID, objectKey: `notes/author-1/${noteID}-1.jpg` },
              { noteID, objectKey: `chat/x/${noteID}-foreign.jpg` },
              { noteID, objectKey: `notes/author-1/${noteID}-2.jpg` },
            ]),
        ),
      },
      circle: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const upload = {
      createPresignedGetUrl: jest.fn(async (key: string) => ({
        url: `https://signed/${key}`,
      })),
    };
    const service = new NoteService(
      prisma as never,
      { get: () => undefined } as never,
      {} as never,
      {} as never,
      upload as never,
    );
    return { service, prisma, upload };
  }
  const signedKeys = (upload: { createPresignedGetUrl: jest.Mock }) =>
    upload.createPresignedGetUrl.mock.calls.map(([key]) => key as string);

  it('projects an active note into the card fields, as a visitor sees it', async () => {
    const { service } = fixture([row('n-active', { workStatus: 'WORKING' })]);

    const cards = await service.projectPlazaNoteCards(['n-active']);

    expect(cards.get('n-active')).toEqual({
      noteId: 'n-active',
      ownerId: 'author-1',
      title: 'title n-active',
      contentPreview: 'content of n-active',
      coverUrl: 'https://signed/notes/author-1/n-active-cover.jpg',
      previewUrls: [
        'https://signed/notes/author-1/n-active-1.jpg',
        'https://signed/notes/author-1/n-active-2.jpg',
      ],
      imageCount: 2,
      videoCount: 1,
      showcaseCount: 1,
      hasText: true,
      hasLocation: true,
      workStatus: 'WORKING',
      publicationStatus: 'ACTIVE',
    });
  });

  it('keeps a 下架 note readable with its real status and UNSET work status', async () => {
    const { service } = fixture([row('n-unlisted', { status: 'UNLISTED' })]);

    const card = (await service.projectPlazaNoteCards(['n-unlisted'])).get(
      'n-unlisted',
    );

    expect(card).toMatchObject({
      publicationStatus: 'UNLISTED',
      workStatus: 'UNSET',
      contentPreview: 'content of n-unlisted',
      coverUrl: 'https://signed/notes/author-1/n-unlisted-cover.jpg',
    });
    expect(card?.previewUrls).toHaveLength(2);
  });

  it('returns a deleted note as title + DELETED only, without signing any of its media', async () => {
    const { service, prisma, upload } = fixture([
      row('n-deleted', { status: 'DELETED', workStatus: 'WORKING' }),
    ]);

    const cards = await service.projectPlazaNoteCards(['n-deleted']);

    expect(cards.get('n-deleted')).toEqual({
      noteId: 'n-deleted',
      ownerId: 'author-1',
      title: 'title n-deleted',
      contentPreview: null,
      coverUrl: null,
      previewUrls: [],
      imageCount: 0,
      videoCount: 0,
      showcaseCount: 0,
      hasText: false,
      hasLocation: false,
      workStatus: null,
      publicationStatus: 'DELETED',
    });
    expect(prisma.noteMedia.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('treats a hidden (available=false) note like an unreadable one: UNLISTED, no media', async () => {
    const { service, upload } = fixture([
      row('n-hidden', { available: false, workStatus: 'CLOSED' }),
    ]);

    const card = (await service.projectPlazaNoteCards(['n-hidden'])).get(
      'n-hidden',
    );

    expect(card).toMatchObject({
      title: 'title n-hidden',
      publicationStatus: 'UNLISTED',
      workStatus: null,
      contentPreview: null,
      coverUrl: null,
      previewUrls: [],
    });
    expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('reports a collected copy as DELETED once its root is gone, even though the copy row is ACTIVE', async () => {
    const { service, upload } = fixture([
      row('copy', { collectedFromNoteID: 'root-purged' }),
    ]);

    const card = (await service.projectPlazaNoteCards(['copy'])).get('copy');

    expect(card).toMatchObject({
      publicationStatus: 'DELETED',
      coverUrl: null,
      previewUrls: [],
    });
    expect(upload.createPresignedGetUrl).not.toHaveBeenCalled();
  });

  it('leaves out notes that no longer exist', async () => {
    const { service } = fixture([row('n-active')]);

    const cards = await service.projectPlazaNoteCards(['n-active', 'gone']);

    expect([...cards.keys()]).toEqual(['n-active']);
  });

  it('loads a whole page with one note query and one media query, signing only readable notes', async () => {
    const { service, prisma, upload } = fixture([
      row('n-1'),
      row('n-2', { status: 'UNLISTED' }),
      row('n-3', { status: 'DELETED' }),
      row('n-4', { available: false }),
      row('n-5'),
    ]);

    const cards = await service.projectPlazaNoteCards([
      'n-1',
      'n-2',
      'n-3',
      'n-4',
      'n-5',
      'n-1',
    ]);

    expect(cards.size).toBe(5);
    // 原笔记没有收录链：只有这一次 note 查询，不按卡片逐条查。
    expect(prisma.note.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.note.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['n-1', 'n-2', 'n-3', 'n-4', 'n-5'] },
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.noteMedia.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.noteMedia.findMany.mock.calls[0][0].where).toEqual({
      noteID: { in: ['n-1', 'n-2', 'n-5'] },
      type: 'IMAGE',
    });
    expect(
      signedKeys(upload).filter(
        (key) => key.includes('n-3') || key.includes('n-4'),
      ),
    ).toEqual([]);
    expect(signedKeys(upload)).not.toContain('chat/x/n-1-foreign.jpg');
  });

  it('skips every read for an empty page', async () => {
    const { service, prisma } = fixture([]);

    await expect(service.projectPlazaNoteCards([])).resolves.toEqual(new Map());
    expect(prisma.note.findMany).not.toHaveBeenCalled();
  });
});

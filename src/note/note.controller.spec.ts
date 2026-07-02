import { NoteController } from './note.controller';

describe('NoteController', () => {
  const noteService = {
    listNotes: jest.fn(),
    createNoteExport: jest.fn(),
  };
  const req = {
    user: { userId: 'user-1' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns summary section flags from GET /note through the service contract', async () => {
    const rows = [
      {
        id: 'note-1',
        ownerId: 'user-1',
        canEdit: true,
        title: 'Trip',
        contentPreview: 'hello',
        status: 'ACTIVE',
        available: true,
        pinned: false,
        groups: [{ id: 'group-1', name: 'Diary' }],
        cover: null,
        imageCount: 1,
        videoCount: 1,
        mediaCount: 2,
        hasText: true,
        showcaseCount: 3,
        hasLocation: true,
        createdAt: new Date('2026-06-29T12:00:00.000Z'),
        updatedAt: new Date('2026-06-29T12:00:00.000Z'),
      },
    ];
    noteService.listNotes.mockResolvedValueOnce(rows);
    const controller = new NoteController(noteService as any);

    const result = await controller.listNotes({ status: 'ACTIVE' } as any, req);

    expect(noteService.listNotes).toHaveBeenCalledWith('user-1', {
      status: 'ACTIVE',
    });
    expect(result[0]).toMatchObject({
      hasText: true,
      showcaseCount: 3,
      hasLocation: true,
      imageCount: 1,
      videoCount: 1,
    });
  });

  it('posts note export requests with viewer, note id, format, and scope', async () => {
    const exportResult = {
      url: 'https://signed.example.com/note.pdf',
      filename: 'Trip.pdf',
      mimeType: 'application/pdf',
      size: 2048,
      expiresAt: new Date('2026-06-29T12:15:00.000Z'),
    };
    noteService.createNoteExport.mockResolvedValueOnce(exportResult);
    const controller = new NoteController(noteService as any);

    const result = await controller.createNoteExport(
      '11111111-1111-1111-1111-111111111111',
      { format: 'PDF', scope: 'ALL' } as any,
      req,
    );

    expect(noteService.createNoteExport).toHaveBeenCalledWith(
      'user-1',
      '11111111-1111-1111-1111-111111111111',
      { format: 'PDF', scope: 'ALL' },
    );
    expect(result).toEqual(exportResult);
  });
});

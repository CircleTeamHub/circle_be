import { assistantNoteCardContent } from './assistant-note-card';

const summary = {
  id: 'copy-note',
  ownerId: 'viewer-1',
  title: '东京拉面店清单',
  contentPreview: '一兰、蔦',
  cover: { id: 'media-1', type: 'IMAGE', url: 'https://cdn.example/cover.jpg' },
  imageCount: 3,
  videoCount: 1,
  hasText: true,
  showcaseCount: 2,
  hasLocation: true,
  status: 'ACTIVE',
  workStatus: 'WORKING',
};

describe('assistantNoteCardContent', () => {
  it('points at the holder copy and takes open/listing state from the source', () => {
    expect(
      assistantNoteCardContent(summary as never, {
        sourceNoteId: 'source-note',
        status: 'ACTIVE',
        workStatus: 'CLOSED',
      }),
    ).toEqual({
      noteId: 'copy-note',
      sourceNoteId: 'source-note',
      ownerId: 'viewer-1',
      title: '东京拉面店清单',
      contentPreview: '一兰、蔦',
      coverUrl: 'https://cdn.example/cover.jpg',
      imageCount: 3,
      videoCount: 1,
      groupNames: [],
      workStatus: 'CLOSED',
      publicationStatus: 'ACTIVE',
      hasText: true,
      showcaseCount: 2,
      hasLocation: true,
    });
  });

  it('falls back to an unset work status and no cover', () => {
    const card = assistantNoteCardContent(
      { ...summary, cover: null, contentPreview: null } as never,
      { sourceNoteId: 'source-note', status: 'ACTIVE', workStatus: null },
    );

    expect(card).toEqual(
      expect.objectContaining({
        coverUrl: null,
        contentPreview: null,
        workStatus: 'UNSET',
      }),
    );
  });
});

import {
  NOTE_MEDIA_TYPE_LIMITS,
  countNoteMediaByType,
  countStoredNoteMediaByType,
  findExceededNoteMediaType,
} from './note-media-limits';

const image = (key: string) => ({ type: 'IMAGE', objectKey: key });
const video = (key: string) => ({ type: 'VIDEO', objectKey: key });

describe('note media type limits', () => {
  it('caps a note at 9 photos, 5 videos and 5 verification videos', () => {
    expect(NOTE_MEDIA_TYPE_LIMITS).toEqual({
      photos: 9,
      videos: 5,
      verificationVideos: 5,
    });
  });

  it('counts showcase videos as verification videos, not as ordinary videos', () => {
    const showcase = [video('s1'), video('s2')];
    const media = [image('i1'), video('v1'), ...showcase];
    expect(countNoteMediaByType(media, showcase)).toEqual({
      photos: 1,
      videos: 1,
      verificationVideos: 2,
    });
  });

  it('counts a video listed twice in the showcase once, so it cannot hide ordinary videos', () => {
    // 验证区条目不去重:同一个视频列 5 次,原来会被当成 5 个验证视频、把 9 个普通视频压成 4 个。
    const ordinary = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9'].map(
      video,
    );
    const showcase = Array.from({ length: 5 }, () => video('v1'));
    const counts = countNoteMediaByType(ordinary, showcase);
    expect(counts).toEqual({ photos: 0, videos: 8, verificationVideos: 1 });
    expect(findExceededNoteMediaType(counts)).toBe('videos');
  });

  it('ignores showcase images (legacy notes fall back to images there)', () => {
    const media = [image('i1'), image('i2')];
    expect(countNoteMediaByType(media, media)).toEqual({
      photos: 2,
      videos: 0,
      verificationVideos: 0,
    });
  });

  it('reads the counts a stored note already has', () => {
    expect(
      countStoredNoteMediaByType({
        imageCount: 10,
        videoCount: 8,
        sections: {
          showcase: { items: [video('s1'), video('s2'), image('x')] },
        },
      }),
    ).toEqual({ photos: 10, videos: 6, verificationVideos: 2 });
    // 旧笔记没有显式 sections:没有验证视频。
    expect(
      countStoredNoteMediaByType({
        imageCount: 3,
        videoCount: 1,
        sections: null,
      }),
    ).toEqual({ photos: 3, videos: 1, verificationVideos: 0 });
  });

  it('flags the first type that goes over its limit on a new note', () => {
    expect(
      findExceededNoteMediaType({
        photos: 9,
        videos: 5,
        verificationVideos: 5,
      }),
    ).toBeNull();
    expect(
      findExceededNoteMediaType({
        photos: 10,
        videos: 0,
        verificationVideos: 0,
      }),
    ).toBe('photos');
    expect(
      findExceededNoteMediaType({
        photos: 0,
        videos: 6,
        verificationVideos: 0,
      }),
    ).toBe('videos');
    expect(
      findExceededNoteMediaType({
        photos: 0,
        videos: 0,
        verificationVideos: 6,
      }),
    ).toBe('verificationVideos');
  });

  it('lets an older note keep what it already has over the limit, but not add more', () => {
    const before = { photos: 12, videos: 7, verificationVideos: 0 };
    // 原样保存、删掉几张都放行。
    expect(findExceededNoteMediaType(before, before)).toBeNull();
    expect(
      findExceededNoteMediaType({ ...before, photos: 11, videos: 6 }, before),
    ).toBeNull();
    // 再加就拦。
    expect(findExceededNoteMediaType({ ...before, photos: 13 }, before)).toBe(
      'photos',
    );
    // 原来没超的那一类照常按上限算。
    expect(
      findExceededNoteMediaType({ ...before, verificationVideos: 6 }, before),
    ).toBe('verificationVideos');
  });
});

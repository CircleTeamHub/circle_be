/**
 * 每条笔记各类媒体的数量上限。前端选择器按同一组数字限制剩余名额
 * (circle-im src/features/notes/utils/note-media-policy.ts),这里是服务端闸门。
 */
export const NOTE_MEDIA_TYPE_LIMITS = {
  photos: 9,
  videos: 5,
  verificationVideos: 5,
} as const;

export type NoteMediaType = keyof typeof NOTE_MEDIA_TYPE_LIMITS;
export type NoteMediaTypeCounts = Record<NoteMediaType, number>;

type TypedItem = { type?: unknown; objectKey?: unknown };

/**
 * 按 objectKey 去重计数:分区条目只是对笔记媒体的引用、服务端不去重,同一个视频在验证区
 * 列 5 次不能算 5 个验证视频(否则「视频 = 全部 − 验证」会被压低,绕过视频上限)。
 */
const countVideos = (items: readonly unknown[]) => {
  const keys = new Set<unknown>();
  items.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) return;
    const { type, objectKey } = item as TypedItem;
    if (type === 'VIDEO') keys.add(objectKey ?? `#${index}`);
  });
  return keys.size;
};

/**
 * 照片 = 笔记里所有图片;验证视频 = 验证区(showcase)里的视频;视频 = 其余视频。
 * 验证区只认视频:没有显式分区的旧客户端会把图片回落进验证区,不能算成验证视频。
 */
export function countNoteMediaByType(
  media: readonly TypedItem[],
  showcaseItems: readonly unknown[],
): NoteMediaTypeCounts {
  const verificationVideos = countVideos(showcaseItems);
  return {
    photos: media.filter((item) => item.type === 'IMAGE').length,
    videos: Math.max(0, countVideos(media) - verificationVideos),
    verificationVideos,
  };
}

/** 已保存笔记的同口径计数(编辑前的数量),用笔记行上存好的图片/视频数。 */
export function countStoredNoteMediaByType(note: {
  imageCount?: number | null;
  videoCount?: number | null;
  sections: unknown;
}): NoteMediaTypeCounts {
  const sections = note.sections as { showcase?: { items?: unknown } } | null;
  const showcase = sections?.showcase?.items;
  const verificationVideos = Array.isArray(showcase)
    ? countVideos(showcase)
    : 0;
  return {
    photos: note.imageCount ?? 0,
    videos: Math.max(0, (note.videoCount ?? 0) - verificationVideos),
    verificationVideos,
  };
}

/**
 * 返回第一类超限的媒体,都没超返回 null。
 * 编辑时传 previous:上限前就已经超了的旧笔记,保持原数量或删减都放行,只拦「再往上加」。
 */
export function findExceededNoteMediaType(
  next: NoteMediaTypeCounts,
  previous?: NoteMediaTypeCounts,
): NoteMediaType | null {
  for (const type of Object.keys(NOTE_MEDIA_TYPE_LIMITS) as NoteMediaType[]) {
    const allowed = Math.max(
      NOTE_MEDIA_TYPE_LIMITS[type],
      previous?.[type] ?? 0,
    );
    if (next[type] > allowed) return type;
  }
  return null;
}

import type { NoteSummaryDto } from './dto/note.dto';

type SourceState = {
  sourceNoteId: string;
  status: 'ACTIVE' | 'UNLISTED' | 'DELETED';
  workStatus: 'WORKING' | 'CLOSED' | null;
};

/**
 * 助手提醒后面附带的笔记名片:指向收藏者自己那份副本(点开进他自己的笔记),
 * 开工/打烊与上下架取来源的实时状态。字段与客户端 buildNoteCardPayloadFromSummary
 * 同形;不带「谁分享的」个人名片快照 —— 这张名片不是哪个人分享的。
 */
export function assistantNoteCardContent(
  summary: NoteSummaryDto,
  source: SourceState,
): Record<string, unknown> {
  return {
    noteId: summary.id,
    sourceNoteId: source.sourceNoteId,
    ownerId: summary.ownerId,
    title: summary.title,
    contentPreview: summary.contentPreview ?? null,
    coverUrl: summary.cover?.url ?? null,
    imageCount: summary.imageCount ?? 0,
    videoCount: summary.videoCount ?? 0,
    groupNames: [],
    workStatus: source.workStatus ?? 'UNSET',
    publicationStatus: source.status,
    hasText: summary.hasText,
    showcaseCount: summary.showcaseCount,
    hasLocation: summary.hasLocation,
  };
}

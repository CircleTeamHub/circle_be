/**
 * 聊天笔记卡片读时的内容投影。
 *
 * 卡片原先是发送那一刻的快照(标题、正文预览、图片数、封面地址……),作者后来改了笔记,
 * 已经发出的卡片不跟着变;封面还是一个会过期的签名地址。读聊天记录时按卡片指向的笔记
 * 取此刻的内容覆盖上去,卡片就和笔记本身一致。
 *
 * 由笔记模块实现(NoteService)。笔记模块依赖聊天模块,所以聊天这边只认这个令牌和接口,
 * 运行时按令牌找实现,不反向依赖笔记模块。
 */
export const NOTE_CARD_PROJECTOR = Symbol('NOTE_CARD_PROJECTOR');

export interface NoteCardProjection {
  title: string;
  contentPreview: string | null;
  /** 现签的封面地址;没有封面时为 null。 */
  coverUrl: string | null;
  imageCount: number;
  videoCount: number;
  showcaseCount: number;
  hasText: boolean;
  hasLocation: boolean;
  /** 前几张图片的对象 key(读路径再签成预览图);只含 notes/ 目录下的。 */
  previewKeys: string[];
}

export interface NoteCardProjector {
  /**
   * 只返回此刻可对外分发(ACTIVE + available)的笔记;用访客视角,不带主人的私人标注
   * (备注、分组、名片、来源)。查不到的 id 不在结果里,调用方保留原快照。
   */
  projectChatNoteCards(
    noteIds: readonly string[],
  ): Promise<Map<string, NoteCardProjection>>;
}

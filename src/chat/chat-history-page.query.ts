import { Prisma } from 'src/generated/prisma';
import { chatRetentionWhere, type ChatRetentionWindow } from './chat-retention';
import type { HistoryFilters } from './chat.types';

/** 读消息不带编辑历史(contentHistory 可能很长)和笔记来源索引列(sourceNoteID),读路径都用不到。 */
export const MESSAGE_READ_OMIT = {
  contentHistory: true,
  sourceNoteID: true,
} as const;

/** 历史页的附加过滤(类型页签、按日期)。 */
export function historyFilterWhere(
  filters: HistoryFilters,
): Prisma.ChatMessageWhereInput {
  const where: Prisma.ChatMessageWhereInput = {};
  if (filters.types?.length) {
    where.type = { in: filters.types };
  }
  if (filters.date) {
    const tzOffset = filters.tzOffsetMinutes ?? 0;
    const tzEndOffset = filters.tzEndOffsetMinutes ?? tzOffset;
    const utcStart = Date.parse(`${filters.date}T00:00:00Z`);
    const start = utcStart + tzOffset * 60_000;
    const end = utcStart + 24 * 60 * 60 * 1000 + tzEndOffset * 60_000;
    if (Number.isFinite(start)) {
      where.createdAt = {
        gte: new Date(start),
        lt: new Date(end),
      };
    }
  }
  return where;
}

export type HistoryPageParams = {
  conversationId: string;
  /** 清空水位与增量游标的较高者;0 表示没有下界。 */
  heightFloor: number;
  beforeHeight?: number;
  filters: HistoryFilters;
  retention: ChatRetentionWindow;
};

/**
 * getHistory 的 where。`deleted: false` 让 20261026000300 的两条部分索引
 * (live conversation/height、live conversation/type/height)接得住:Prisma 把它发成
 * `"deleted" = $n`,pg 驱动走未命名语句、每次按实际参数规划,谓词证明得了
 * (test/postgres/chat-history-live-indexes.pg-spec.ts 用这里生成的 SQL 验证)。
 */
export function historyPageWhere(
  params: HistoryPageParams,
): Prisma.ChatMessageWhereInput {
  const heightCondition: Prisma.IntFilter = {
    ...(params.heightFloor > 0 ? { gt: params.heightFloor } : {}),
    ...(params.beforeHeight !== undefined ? { lt: params.beforeHeight } : {}),
  };
  const where: Prisma.ChatMessageWhereInput = {
    conversationID: params.conversationId,
    deleted: false,
    ...(Object.keys(heightCondition).length > 0
      ? { height: heightCondition }
      : {}),
    ...historyFilterWhere(params.filters),
  };
  // 必须用 AND 追加,不能并进同一层 —— 按日期过滤同样写 createdAt,
  // 平铺展开会被它整个盖掉:客户端只要带上 date 参数就能翻出销毁窗口
  // 之外的消息,等于给这个设置留了个后门。
  Object.assign(where, chatRetentionWhere(params.retention));
  return where;
}

/** 不带关键词的历史页:增量补拉从缺口低端往高处追,向旧翻页取最近一段。 */
export function historyPageArgs(
  where: Prisma.ChatMessageWhereInput,
  ascending: boolean,
  take: number,
) {
  return {
    where,
    omit: MESSAGE_READ_OMIT,
    orderBy: { height: ascending ? ('asc' as const) : ('desc' as const) },
    take,
  } satisfies Prisma.ChatMessageFindManyArgs;
}

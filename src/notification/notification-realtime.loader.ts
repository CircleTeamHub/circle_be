import type { Prisma } from 'src/generated/prisma';
import {
  mapNotificationRealtimeDto,
  NOTIFICATION_EXCERPT_LENGTH,
  type NotificationPushSource,
  type NotificationRealtimeBaseRow,
  type NotificationRealtimeDto,
  type NotificationRealtimeRelations,
} from './notification.dto';

/** 关系表的读入口：PrismaService 或事务里的 tx 都行。 */
export type NotificationRelationReader = Pick<
  Prisma.TransactionClient,
  | 'user'
  | 'systemAnnouncement'
  | 'trace'
  | 'traceComment'
  | 'circle'
  | 'circlePost'
  | 'circleInvitation'
  | 'groupAdmission'
>;

type ForeignKey = keyof Pick<
  NotificationRealtimeBaseRow,
  | 'fromUserID'
  | 'systemAnnouncementID'
  | 'fromTraceID'
  | 'fromReplyID'
  | 'fromCircleID'
  | 'fromCirclePostID'
  | 'fromInvitationID'
  | 'fromGroupAdmissionID'
>;

/** 这批行里某个外键的非空取值，去重、保持首次出现的顺序。 */
function referencedIds(
  rows: readonly NotificationRealtimeBaseRow[],
  key: ForeignKey,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = row[key];
    if (id) ids.add(id);
  }
  return [...ids];
}

/** 外键全空就不发这条查询（include 会照发）。 */
async function loadById<T extends { id: string }>(
  ids: readonly string[],
  load: (ids: string[]) => Promise<T[]>,
): Promise<ReadonlyMap<string, T>> {
  if (ids.length === 0) return new Map();
  const found = await load([...ids]);
  return new Map(found.map((row) => [row.id, row]));
}

function lookup<T>(
  map: ReadonlyMap<string, T>,
  id: string | null | undefined,
): T | null {
  return id ? (map.get(id) ?? null) : null;
}

/**
 * 给本表行补上实时 DTO 要的关系，结果与原来的 9 路 include 逐字段一致。
 *
 * - 只查这批行真正引用到的关系（外键全空的整条跳过）；
 * - 逐条 await，同一时刻只占一个池连接（include 是 Promise.all 并发 9 条）；
 * - 每个关系只 select DTO 用到的列；Friend 只为一个 id，直接用外键列，不查表。
 *
 * 外键都是 ON DELETE SET NULL / RESTRICT：外键非空时关系行一定在。万一被并发删掉，
 * 关系是 null —— 与 include 分条查询时的表现相同。
 */
export async function loadNotificationRealtimeRows<
  T extends NotificationRealtimeBaseRow,
>(
  db: NotificationRelationReader,
  rows: readonly T[],
): Promise<Array<T & NotificationRealtimeRelations>> {
  if (rows.length === 0) return [];

  const users = await loadById(referencedIds(rows, 'fromUserID'), (ids) =>
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, nickname: true, avatarUrl: true },
    }),
  );
  const announcements = await loadById(
    referencedIds(rows, 'systemAnnouncementID'),
    (ids) =>
      db.systemAnnouncement.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true },
      }),
  );
  const traces = await loadById(referencedIds(rows, 'fromTraceID'), (ids) =>
    db.trace.findMany({
      where: { id: { in: ids } },
      select: { id: true, content: true, images: true },
    }),
  );
  const replies = await loadById(referencedIds(rows, 'fromReplyID'), (ids) =>
    db.traceComment.findMany({
      where: { id: { in: ids } },
      select: { id: true, content: true },
    }),
  );
  const circles = await loadById(referencedIds(rows, 'fromCircleID'), (ids) =>
    db.circle.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    }),
  );
  const posts = await loadById(referencedIds(rows, 'fromCirclePostID'), (ids) =>
    db.circlePost.findMany({
      where: { id: { in: ids } },
      select: { id: true, content: true, images: true },
    }),
  );
  const invitations = await loadById(
    referencedIds(rows, 'fromInvitationID'),
    (ids) =>
      db.circleInvitation.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true },
      }),
  );
  const admissions = await loadById(
    referencedIds(rows, 'fromGroupAdmissionID'),
    (ids) =>
      db.groupAdmission.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true },
      }),
  );

  return rows.map((row) => {
    const announcement = lookup(announcements, row.systemAnnouncementID);
    return {
      ...row,
      systemAnnouncement: announcement ? { title: announcement.title } : null,
      fromUser: lookup(users, row.fromUserID),
      fromTrace: lookup(traces, row.fromTraceID),
      fromReply: lookup(replies, row.fromReplyID),
      fromCircle: lookup(circles, row.fromCircleID),
      fromCirclePost: lookup(posts, row.fromCirclePostID),
      fromInvitation: lookup(invitations, row.fromInvitationID),
      fromGroupAdmission: lookup(admissions, row.fromGroupAdmissionID),
    };
  });
}

export async function loadNotificationRealtimeDtos(
  db: NotificationRelationReader,
  rows: readonly NotificationRealtimeBaseRow[],
): Promise<NotificationRealtimeDto[]> {
  return (await loadNotificationRealtimeRows(db, rows)).map(
    mapNotificationRealtimeDto,
  );
}

/**
 * 推送文案（composeMessage）只读得到的那几项，比实时 DTO 少得多：
 * - 不要头像、配图、圈子名、邀请 / 入群状态 —— 圈子、邀请、入群三张表都不查；
 * - 邀请 / 入群 / 好友申请 / 动态 / 回复 / 帖子的 id 直接取外键列；
 * - 正文为空时才需要回复 / 帖子 / 动态的正文当兜底，只对这些行去取。
 */
export async function loadNotificationPushSources(
  db: Pick<
    NotificationRelationReader,
    'user' | 'systemAnnouncement' | 'trace' | 'traceComment' | 'circlePost'
  >,
  rows: readonly NotificationRealtimeBaseRow[],
): Promise<NotificationPushSource[]> {
  if (rows.length === 0) return [];
  const bodiless = rows.filter((row) => !row.content);

  const users = await loadById(referencedIds(rows, 'fromUserID'), (ids) =>
    db.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, nickname: true },
    }),
  );
  const announcements = await loadById(
    referencedIds(rows, 'systemAnnouncementID'),
    (ids) =>
      db.systemAnnouncement.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true },
      }),
  );
  const traces = await loadById(referencedIds(bodiless, 'fromTraceID'), (ids) =>
    db.trace.findMany({
      where: { id: { in: ids } },
      select: { id: true, content: true },
    }),
  );
  const replies = await loadById(
    referencedIds(bodiless, 'fromReplyID'),
    (ids) =>
      db.traceComment.findMany({
        where: { id: { in: ids } },
        select: { id: true, content: true },
      }),
  );
  const posts = await loadById(
    referencedIds(bodiless, 'fromCirclePostID'),
    (ids) =>
      db.circlePost.findMany({
        where: { id: { in: ids } },
        select: { id: true, content: true },
      }),
  );

  return rows.map((row) => {
    const user = lookup(users, row.fromUserID);
    const trace = lookup(traces, row.fromTraceID);
    const reply = lookup(replies, row.fromReplyID);
    const post = lookup(posts, row.fromCirclePostID);
    return {
      id: row.id,
      type: row.type,
      content: row.content,
      title: lookup(announcements, row.systemAnnouncementID)?.title ?? null,
      fromUser: user ? { id: user.id, nickname: user.nickname } : null,
      fromTrace: row.fromTraceID
        ? {
            id: row.fromTraceID,
            ...(trace
              ? { excerpt: trace.content.slice(0, NOTIFICATION_EXCERPT_LENGTH) }
              : {}),
          }
        : null,
      fromReply: row.fromReplyID
        ? {
            id: row.fromReplyID,
            ...(reply ? { content: reply.content } : {}),
          }
        : null,
      fromCirclePost: row.fromCirclePostID
        ? {
            id: row.fromCirclePostID,
            ...(post
              ? { excerpt: post.content.slice(0, NOTIFICATION_EXCERPT_LENGTH) }
              : {}),
          }
        : null,
      fromInvitation: row.fromInvitationID
        ? { id: row.fromInvitationID }
        : null,
      fromGroupAdmission: row.fromGroupAdmissionID
        ? { id: row.fromGroupAdmissionID }
        : null,
      requestId: row.fromFriendRequestID ?? null,
    };
  });
}

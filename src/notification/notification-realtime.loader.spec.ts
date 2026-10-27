import { NotificationType } from 'src/generated/prisma';
import { NotificationPushService } from './notification-push.service';
import {
  mapNotificationRealtimeDto,
  type NotificationRealtimeBaseRow,
} from './notification.dto';
import {
  loadNotificationPushSources,
  loadNotificationRealtimeRows,
} from './notification-realtime.loader';

/**
 * 关系改成「按外键按需、逐个顺序」加载之后，列表 / 实时 / 推送的输出必须和原来
 * 9 路 include 逐字段一致。这里用一个只认 `where.id.in` + `select` 的内存假库：
 * 少 select 一个字段，输出里就少一个字段，断言会红。
 */

type Row = Record<string, unknown> & { id: string };
const MODELS = [
  'user',
  'systemAnnouncement',
  'trace',
  'traceComment',
  'circle',
  'circlePost',
  'circleInvitation',
  'groupAdmission',
] as const;
type Model = (typeof MODELS)[number];

const LONG_TRACE = `${'长'.repeat(58)}😀😀tail`;

const TABLES: Record<Model, Row[]> = {
  user: [
    {
      id: 'actor',
      nickname: 'Aki',
      avatarUrl: 'https://cdn/a.png',
      circleOfflinePushEnabled: true,
    },
    { id: 'me', nickname: 'Me', avatarUrl: null },
  ],
  systemAnnouncement: [
    { id: 'sa-1', title: '维护通知', content: '公告正文' },
    { id: 'sa-untitled', title: null, content: '老公告' },
  ],
  trace: [
    { id: 'trace-1', content: LONG_TRACE, images: ['img-1', 'img-2'] },
    { id: 'trace-empty', content: '', images: [] },
  ],
  traceComment: [{ id: 'reply-1', content: '回复正文', images: [] }],
  circle: [{ id: 'circle-1', name: '摄影圈' }],
  circlePost: [
    { id: 'post-1', content: 'x'.repeat(5000), images: ['post-img'] },
  ],
  circleInvitation: [{ id: 'inv-1', status: 'PENDING' }],
  groupAdmission: [{ id: 'ga-1', status: 'INVITED' }],
};

function fakeDb(tables: Record<Model, Row[]> = TABLES) {
  const calls: Array<{ model: Model; ids: string[]; select: string[] }> = [];
  let inFlight = 0;
  let peak = 0;
  const delegate = (model: Model) => ({
    findMany: jest.fn(
      async ({
        where,
        select,
      }: {
        where: { id: { in: string[] } };
        select: Record<string, boolean>;
      }) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        const fields = Object.keys(select).filter((key) => select[key]);
        calls.push({ model, ids: [...where.id.in], select: fields });
        return tables[model]
          .filter((row) => where.id.in.includes(row.id))
          .map((row) =>
            Object.fromEntries(fields.map((key) => [key, row[key]])),
          );
      },
    ),
  });
  const db = Object.fromEntries(
    MODELS.map((model) => [model, delegate(model)]),
  ) as unknown as Parameters<typeof loadNotificationRealtimeRows>[0];
  return { db, calls, peak: () => peak };
}

const base = (
  overrides: Partial<NotificationRealtimeBaseRow> &
    Pick<NotificationRealtimeBaseRow, 'id' | 'type'>,
): NotificationRealtimeBaseRow => ({
  content: '',
  read: false,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  toUserID: 'me',
  fromUserID: 'actor',
  fromTraceID: null,
  fromReplyID: null,
  fromCircleID: null,
  fromCirclePostID: null,
  fromInvitationID: null,
  fromGroupAdmissionID: null,
  fromFriendRequestID: null,
  systemAnnouncementID: null,
  ...overrides,
});

const ROWS: NotificationRealtimeBaseRow[] = [
  base({
    id: 'comment',
    type: NotificationType.TRACE_COMMENT,
    content: '评论正文',
    fromTraceID: 'trace-1',
    fromReplyID: 'reply-1',
  }),
  base({
    id: 'like',
    type: NotificationType.TRACE_LIKE,
    fromTraceID: 'trace-empty',
  }),
  base({
    id: 'mention-empty',
    type: NotificationType.TRACE_MENTION,
    fromTraceID: 'trace-1',
    fromReplyID: 'reply-1',
  }),
  base({
    id: 'verify',
    type: NotificationType.CIRCLE_VERIFICATION_REQUESTED,
    fromCircleID: 'circle-1',
    fromInvitationID: 'inv-1',
  }),
  base({
    id: 'published',
    type: NotificationType.CIRCLE_POST_PUBLISHED,
    fromCirclePostID: 'post-1',
    read: true,
  }),
  base({
    id: 'admission',
    type: NotificationType.GROUP_ADMISSION,
    content: '邀请你入群',
    fromGroupAdmissionID: 'ga-1',
  }),
  base({
    id: 'friend',
    type: NotificationType.FRIEND_REQUEST_RECEIVED,
    content: '你好',
    fromFriendRequestID: 'friend-1',
  }),
  base({
    id: 'announcement',
    type: NotificationType.SYSTEM,
    content: '公告正文',
    fromUserID: 'me',
    systemAnnouncementID: 'sa-1',
  }),
  base({
    id: 'announcement-untitled',
    type: NotificationType.SYSTEM,
    content: '老公告',
    fromUserID: 'me',
    systemAnnouncementID: 'sa-untitled',
  }),
  base({
    id: 'system',
    type: NotificationType.SYSTEM,
    content: '积分已到账',
    fromUserID: 'me',
  }),
  base({ id: 'profile-like', type: NotificationType.PROFILE_LIKE }),
];

const actor = { id: 'actor', nickname: 'Aki', avatarUrl: 'https://cdn/a.png' };
const me = { id: 'me', nickname: 'Me', avatarUrl: null };
const empty = {
  fromTrace: null,
  fromReply: null,
  fromCircle: null,
  fromCirclePost: null,
  fromInvitation: null,
  requestId: null,
};
const head = (id: string, type: NotificationType, content = '') => ({
  id,
  type,
  content,
  read: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  title: null,
});

/** 原来 9 路 include + mapNotificationRealtimeDto 对这批行的输出，逐条钉死。 */
const EXPECTED_DTOS = [
  {
    ...head('comment', NotificationType.TRACE_COMMENT, '评论正文'),
    ...empty,
    fromUser: actor,
    fromTrace: {
      id: 'trace-1',
      excerpt: LONG_TRACE.slice(0, 60),
      firstImage: 'img-1',
    },
    fromReply: { id: 'reply-1', content: '回复正文' },
  },
  {
    ...head('like', NotificationType.TRACE_LIKE),
    ...empty,
    fromUser: actor,
    fromTrace: { id: 'trace-empty', excerpt: '', firstImage: null },
  },
  {
    ...head('mention-empty', NotificationType.TRACE_MENTION),
    ...empty,
    fromUser: actor,
    fromTrace: {
      id: 'trace-1',
      excerpt: LONG_TRACE.slice(0, 60),
      firstImage: 'img-1',
    },
    fromReply: { id: 'reply-1', content: '回复正文' },
  },
  {
    ...head('verify', NotificationType.CIRCLE_VERIFICATION_REQUESTED),
    ...empty,
    fromUser: actor,
    fromCircle: { id: 'circle-1', name: '摄影圈' },
    fromInvitation: { id: 'inv-1', status: 'PENDING' },
  },
  {
    ...head('published', NotificationType.CIRCLE_POST_PUBLISHED),
    read: true,
    ...empty,
    fromUser: actor,
    fromCirclePost: {
      id: 'post-1',
      excerpt: 'x'.repeat(60),
      firstImage: 'post-img',
    },
  },
  {
    ...head('admission', NotificationType.GROUP_ADMISSION, '邀请你入群'),
    ...empty,
    fromUser: actor,
    fromGroupAdmission: { id: 'ga-1', status: 'INVITED' },
  },
  {
    ...head('friend', NotificationType.FRIEND_REQUEST_RECEIVED, '你好'),
    ...empty,
    fromUser: actor,
    requestId: 'friend-1',
  },
  {
    ...head('announcement', NotificationType.SYSTEM, '公告正文'),
    title: '维护通知',
    ...empty,
    fromUser: me,
  },
  {
    ...head('announcement-untitled', NotificationType.SYSTEM, '老公告'),
    ...empty,
    fromUser: me,
  },
  {
    ...head('system', NotificationType.SYSTEM, '积分已到账'),
    ...empty,
    fromUser: me,
  },
  {
    ...head('profile-like', NotificationType.PROFILE_LIKE),
    ...empty,
    fromUser: actor,
  },
];

describe('loadNotificationRealtimeRows', () => {
  it('maps every relation exactly like the old nine-way include', async () => {
    const { db } = fakeDb();

    const rows = await loadNotificationRealtimeRows(db, ROWS);

    expect(rows.map(mapNotificationRealtimeDto)).toEqual(EXPECTED_DTOS);
    // toEqual 不区分「键不存在」和「值为 undefined」：fromGroupAdmission 只在
    // 有值时出现，这一点单独钉住。
    expect(
      rows
        .map(mapNotificationRealtimeDto)
        .map((dto) => Object.keys(dto).includes('fromGroupAdmission')),
    ).toEqual(ROWS.map((row) => row.id === 'admission'));
  });

  it('keeps the input order and the base columns', async () => {
    const { db } = fakeDb();
    const reversed = [...ROWS].reverse();

    const rows = await loadNotificationRealtimeRows(db, reversed);

    expect(rows.map((row) => row.id)).toEqual(reversed.map((row) => row.id));
    expect(rows[0]).toEqual(expect.objectContaining(reversed[0]));
  });

  it('queries only the relations the rows reference, one statement at a time', async () => {
    const { db, calls, peak } = fakeDb();

    await loadNotificationRealtimeRows(db, [
      base({
        id: 'a',
        type: NotificationType.TRACE_LIKE,
        fromTraceID: 'trace-1',
      }),
      base({
        id: 'b',
        type: NotificationType.TRACE_LIKE,
        fromTraceID: 'trace-1',
      }),
      base({ id: 'c', type: NotificationType.PROFILE_LIKE }),
    ]);

    expect(calls).toEqual([
      {
        model: 'user',
        ids: ['actor'],
        select: ['id', 'nickname', 'avatarUrl'],
      },
      { model: 'trace', ids: ['trace-1'], select: ['id', 'content', 'images'] },
    ]);
    // 原来 Prisma 对 9 个关系各发一条、Promise.all 并发，一次占 9 个池连接。
    expect(peak()).toBe(1);
  });

  it('never looks up the friend request row: requestId is its foreign key', async () => {
    const { db, calls } = fakeDb();

    await loadNotificationRealtimeRows(db, ROWS);

    expect(calls.map((call) => call.model)).not.toContain('friend');
    expect(new Set(calls.map((call) => call.model)).size).toBe(calls.length);
  });

  it('does nothing for an empty page', async () => {
    const { db, calls } = fakeDb();

    await expect(loadNotificationRealtimeRows(db, [])).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });

  it('maps a relation whose row is gone to null, like include did', async () => {
    const { db } = fakeDb({ ...TABLES, trace: [] });

    const [row] = await loadNotificationRealtimeRows(db, [
      base({
        id: 'a',
        type: NotificationType.TRACE_LIKE,
        fromTraceID: 'trace-1',
      }),
    ]);

    expect(mapNotificationRealtimeDto(row).fromTrace).toBeNull();
  });
});

describe('loadNotificationPushSources', () => {
  const push = new NotificationPushService(
    {} as never,
    { get: () => undefined } as never,
  );

  it('composes exactly the payload the full realtime DTO composed', async () => {
    const full = await loadNotificationRealtimeRows(fakeDb().db, ROWS);
    const sources = await loadNotificationPushSources(fakeDb().db, ROWS);

    expect(sources.map((source) => push.composeMessage('me', source))).toEqual(
      full.map((row) =>
        push.composeMessage('me', mapNotificationRealtimeDto(row)),
      ),
    );
  });

  it('reads only what composeMessage uses', async () => {
    const { db, calls, peak } = fakeDb();

    await loadNotificationPushSources(db, ROWS);

    // 头像、配图、圈子名、邀请/入群状态都不进推送；正文非空的行不取帖子/动态/回复正文。
    expect(calls).toEqual([
      { model: 'user', ids: ['actor', 'me'], select: ['id', 'nickname'] },
      {
        model: 'systemAnnouncement',
        ids: ['sa-1', 'sa-untitled'],
        select: ['id', 'title'],
      },
      {
        model: 'trace',
        ids: ['trace-empty', 'trace-1'],
        select: ['id', 'content'],
      },
      { model: 'traceComment', ids: ['reply-1'], select: ['id', 'content'] },
      { model: 'circlePost', ids: ['post-1'], select: ['id', 'content'] },
    ]);
    expect(peak()).toBe(1);
  });
});

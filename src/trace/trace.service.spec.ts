import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import {
  TraceService,
  encodeTraceCursor,
  decodeTraceCursor,
} from './trace.service';
import { AvatarFrameService } from 'src/avatar-frame/avatar-frame.service';
import { Prisma } from 'src/generated/prisma';
import {
  TraceCommentPreviewRow,
  TraceLikePreviewRow,
  traceCommentPreviewQuery,
  traceLikePreviewQuery,
} from './trace-preview.query';
import {
  MomentFriendScopeRow,
  momentFriendScopeQuery,
  traceFeedPageQuery,
} from './trace-feed.query';

/** Minimal Trace row in the shape `getFeed`'s include produces. */
function makeTraceRow(id: string, createdAt: Date) {
  return {
    id,
    fromID: 'friend-1',
    deleted: false,
    visibility: 'FRIENDS_ONLY',
    content: `content-${id}`,
    images: [],
    createdAt,
    from: { id: 'friend-1', nickname: 'Friend', avatarUrl: null },
    likeStats: [],
    comments: [],
  };
}

/** 预览查询（原生 SQL）返回的一行点赞。 */
function likeRow(traceID: string, userID: string): TraceLikePreviewRow {
  return { traceID, userID, userNickname: `nick-${userID}` };
}

/** 预览查询（原生 SQL）返回的一行评论（最新在前）。 */
function commentRow(
  traceID: string,
  id: string,
  userID: string,
  extra: Partial<TraceCommentPreviewRow> = {},
): TraceCommentPreviewRow {
  return {
    id,
    traceID,
    userID,
    content: `content-${id}`,
    images: [],
    createdAt: new Date('2026-06-08T01:00:00.000Z'),
    userNickname: `nick-${userID}`,
    replyToID: null,
    replyToNickname: null,
    ...extra,
  };
}

const isLikePreview = (query: unknown) =>
  typeof (query as Prisma.Sql | undefined)?.sql === 'string' &&
  (query as Prisma.Sql).sql.includes('"traceLikeStat"');
const isCommentPreview = (query: unknown) =>
  typeof (query as Prisma.Sql | undefined)?.sql === 'string' &&
  (query as Prisma.Sql).sql.includes('FROM "TraceComment" AS tc');
const isFeedPage = (query: unknown) =>
  typeof (query as Prisma.Sql | undefined)?.sql === 'string' &&
  (query as Prisma.Sql).sql.includes('FROM "Trace" AS t');
const isFriendScope = (query: unknown) =>
  typeof (query as Prisma.Sql | undefined)?.sql === 'string' &&
  (query as Prisma.Sql).sql.includes('AS "chatOnly"');

describe('TraceService', () => {
  let service: TraceService;

  const prisma = {
    trace: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
    },
    traceLikeStat: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    traceComment: {
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    friend: {
      findMany: jest.fn(),
    },
    userPrivacySetting: {
      findMany: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(async (input: any) =>
      Array.isArray(input) ? Promise.all(input) : input(prisma),
    ),
  };
  /**
   * feed 的四条原生 SQL（好友范围、这一页的 id、点赞预览、评论预览）按查询种类分流；
   * 这一页的整行由 trace.findMany 按 id 回填（见 beforeEach）。
   */
  const feed = {
    friends: [] as MomentFriendScopeRow[],
    traces: [] as Array<{ id: string }>,
    likes: [] as TraceLikePreviewRow[],
    comments: [] as TraceCommentPreviewRow[],
  };
  const dispatchRaw = async (query: unknown) => {
    if (isFriendScope(query)) return feed.friends;
    if (isFeedPage(query)) return feed.traces.map(({ id }) => ({ id }));
    if (isLikePreview(query)) return feed.likes;
    if (isCommentPreview(query)) return feed.comments;
    throw new Error('unexpected raw query');
  };
  /** 点赞 / 评论预览走两条原生 SQL；按查询种类分流各自的结果行。 */
  const stubPreviews = (
    likes: TraceLikePreviewRow[],
    comments: TraceCommentPreviewRow[],
  ) => {
    feed.likes = likes;
    feed.comments = comments;
  };
  /** feed 的好友范围（一次 Friend 读取）：好友 id，可带「只给 viewer CHAT_ONLY」。 */
  const stubFriendScope = (
    ...friends: Array<string | MomentFriendScopeRow>
  ) => {
    feed.friends = friends.map((friend) =>
      typeof friend === 'string'
        ? { friendId: friend, chatOnly: false }
        : friend,
    );
  };
  /** 这一页（含游标模式多取的那一行）：原生 SQL 回 id，trace.findMany 回填整行。 */
  const stubFeedTraces = (rows: Array<{ id: string }>) => {
    feed.traces = rows;
  };
  const feedPageQueries = () =>
    prisma.$queryRaw.mock.calls
      .map(([query]) => query as Prisma.Sql)
      .filter(isFeedPage);
  const notificationService = {
    createTraceCommentNotifications: jest.fn(() => Promise.resolve([])),
    createTraceLikeNotification: jest.fn(),
  };
  const realtimeService = {
    broadcastInteractionUnread: jest.fn(() => Promise.resolve()),
    broadcastCirclePostInteractionCreated: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    // #89：feed poke
    broadcastMomentsFeedUpdated: jest.fn(),
    safeBroadcastAll: jest.fn(async (fns: Array<() => unknown>) => {
      for (const fn of fns) await fn();
    }),
  };
  const privacySettings = {
    canViewMoments: jest.fn(),
    // Batched feed path: getSettingsMany loads rows, momentsVisibleFor decides.
    getSettingsMany: jest.fn(),
    momentsVisibleFor: jest.fn(
      (
        settings: { momentsVisibility?: string } | undefined,
        isSelf: boolean,
        isFriend: boolean,
      ) => {
        if (isSelf) return true;
        const visibility = settings?.momentsVisibility ?? 'ALL';
        if (visibility === 'PRIVATE') return false;
        if (visibility === 'FRIENDS_ONLY') return isFriend;
        return true;
      },
    ),
  };
  const avatarFrames = {
    resolvePublicAppearances: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    privacySettings.canViewMoments.mockReset();
    privacySettings.canViewMoments.mockResolvedValue(true);
    privacySettings.getSettingsMany.mockReset();
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    prisma.userPrivacySetting.findMany.mockResolvedValue([]);
    notificationService.createTraceCommentNotifications.mockResolvedValue([]);
    notificationService.createTraceLikeNotification.mockReset();
    avatarFrames.resolvePublicAppearances.mockReset();
    avatarFrames.resolvePublicAppearances.mockResolvedValue(new Map());
    feed.friends = [];
    feed.traces = [];
    feed.likes = [];
    feed.comments = [];
    prisma.$queryRaw.mockReset();
    prisma.$queryRaw.mockImplementation(dispatchRaw);
    prisma.trace.findMany.mockReset();
    prisma.trace.findMany.mockImplementation(
      async (args?: { where?: { id?: { in?: string[] } } }) =>
        feed.traces.filter((row) => args?.where?.id?.in?.includes(row.id)),
    );
    prisma.friend.findMany.mockReset();
    prisma.friend.findMany.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TraceService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn(() => null) } },
        { provide: NotificationService, useValue: notificationService },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: PrivacySettingsService, useValue: privacySettings },
        { provide: AvatarFrameService, useValue: avatarFrames },
      ],
    }).compile();

    service = module.get(TraceService);
  });

  it('blocks liking a private trace that is not visible to the caller', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PRIVATE',
      likeCount: 0,
    });
    prisma.friend.findMany.mockResolvedValue([]);

    await expect(service.toggleLike('viewer-1', 'trace-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('blocks access to a public trace when the author hides moments from the viewer', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
      likeCount: 0,
    });
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.canViewMoments.mockResolvedValue(false);

    await expect(service.toggleLike('viewer-1', 'trace-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('getTraceById returns a single visible moment in the feed DTO shape', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'FRIENDS_ONLY',
      content: 'hello world',
      images: [],
      likeCount: 2,
      replyCount: 1,
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      from: { id: 'author-1', nickname: 'Author', avatarUrl: null },
    });
    stubPreviews(
      [likeRow('trace-1', 'viewer-1')],
      [commentRow('trace-1', 'comment-1', 'author-1', { content: 'nice' })],
    );
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'author-1' },
    ]);
    prisma.traceLikeStat.findFirst.mockResolvedValue({ traceID: 'trace-1' });
    avatarFrames.resolvePublicAppearances.mockResolvedValue(
      new Map([
        [
          'author-1',
          {
            vipLevel: 0,
            avatarFrame: {
              id: 'frame-1',
              key: 'admin-gift',
              name: 'Gift frame',
              imageUrl: null,
            },
          },
        ],
      ]),
    );

    const result = await service.getTraceById('viewer-1', 'trace-1');

    expect(result).toEqual(
      expect.objectContaining({
        id: 'trace-1',
        content: 'hello world',
        likeCount: 2,
        commentCount: 1,
        isLikedByMe: true,
        author: expect.objectContaining({ id: 'author-1' }),
      }),
    );
    expect(result.author.avatarFrameAppearance).toEqual({
      id: 'frame-1',
      key: 'admin-gift',
      name: 'Gift frame',
      imageUrl: null,
    });
    expect(avatarFrames.resolvePublicAppearances).toHaveBeenCalledWith([
      'author-1',
    ]);
    expect(result.comments).toEqual([
      expect.objectContaining({
        id: 'comment-1',
        content: 'nice',
        user: { id: 'author-1', nickname: 'nick-author-1' },
        replyTo: null,
      }),
    ]);
    expect(result.likedFriends).toEqual([
      { id: 'viewer-1', nickname: 'nick-viewer-1' },
    ]);
  });

  it('getTraceById resolves the author membership across an expiry boundary', async () => {
    const baseTrace = {
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'FRIENDS_ONLY',
      content: 'hello world',
      images: [],
      likeCount: 0,
      replyCount: 0,
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      likeStats: [],
      comments: [],
    };
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'author-1' },
    ]);
    prisma.traceLikeStat.findFirst.mockResolvedValue(null);

    // Expired level 3 → 0: no leaked paid name effect on the moment surface.
    prisma.trace.findFirst.mockResolvedValue({
      ...baseTrace,
      from: {
        id: 'author-1',
        nickname: 'Author',
        avatarUrl: null,
        vipLevel: 3,
        vipExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    expect(
      (await service.getTraceById('viewer-1', 'trace-1')).author.vipLevel,
    ).toBe(0);

    // Unexpired level 2 is preserved.
    prisma.trace.findFirst.mockResolvedValue({
      ...baseTrace,
      from: {
        id: 'author-1',
        nickname: 'Author',
        avatarUrl: null,
        vipLevel: 2,
        vipExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      },
    });
    expect(
      (await service.getTraceById('viewer-1', 'trace-1')).author.vipLevel,
    ).toBe(2);
  });

  it('getTraceById caps loaded comments to protect the detail endpoint', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'FRIENDS_ONLY',
      content: 'hello world',
      images: [],
      likeCount: 0,
      replyCount: 250,
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      from: { id: 'author-1', nickname: 'Author', avatarUrl: null },
      likeStats: [],
      comments: [],
    });
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'author-1' },
    ]);
    prisma.traceLikeStat.findFirst.mockResolvedValue(null);

    await service.getTraceById('viewer-1', 'trace-1');

    // 详情的评论上限比 feed 预览高，但同样是 SQL 里每条动态的 LIMIT，不再是嵌套
    // include 的 take（Prisma 7 对嵌套 take 不生成 LIMIT，热门动态会整串读出来）。
    const detailQuery = prisma.trace.findFirst.mock.calls[1][0];
    expect(detailQuery.include).not.toHaveProperty('comments');
    expect(detailQuery.include).not.toHaveProperty('likeStats');
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      traceCommentPreviewQuery(['trace-1'], 100),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      traceLikePreviewQuery(['trace-1'], 20),
    );
  });

  it('getTraceById selects only the replied-to id and nickname and still threads replies', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'FRIENDS_ONLY',
      content: 'hello world',
      images: [],
      likeCount: 0,
      replyCount: 1,
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      from: { id: 'author-1', nickname: 'Author', avatarUrl: null },
    });
    stubPreviews(
      [],
      [
        commentRow('trace-1', 'comment-2', 'author-1', {
          replyToID: 'comment-1',
          replyToNickname: 'Viewer',
        }),
      ],
    );
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'author-1' },
    ]);
    prisma.traceLikeStat.findFirst.mockResolvedValue(null);

    const result = await service.getTraceById('viewer-1', 'trace-1');

    // 预览 SQL 只为 replyTo 取父评论 id 与被回复人昵称（不是整条父评论）。
    const [commentQuery] = prisma.$queryRaw.mock.calls
      .map(([query]) => query as Prisma.Sql)
      .filter(isCommentPreview);
    expect(commentQuery.sql).toContain('parent."id" AS "replyToID"');
    expect(commentQuery.sql).toContain(
      'parent_author."nickname" AS "replyToNickname"',
    );
    // 客户端按父评论 id 串楼，这个 id 必须仍是被回复的那条评论。
    expect(result.comments[0].replyTo).toEqual({
      id: 'comment-1',
      nickname: 'Viewer',
    });
  });

  it('getTraceById throws NotFound when the moment is missing or deleted', async () => {
    prisma.trace.findFirst.mockResolvedValue(null);

    await expect(
      service.getTraceById('viewer-1', 'trace-missing'),
    ).rejects.toThrow(NotFoundException);
  });

  it('getTraceById throws Forbidden for a private moment the viewer does not own', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PRIVATE',
    });
    prisma.friend.findMany.mockResolvedValue([]);

    await expect(service.getTraceById('viewer-1', 'trace-1')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('hides chat-only moments as not found on direct detail access', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'FRIENDS_ONLY',
      content: 'hidden from chat-only friends',
    });
    // author-1 (userID) granted viewer-1 (friendID) only CHAT_ONLY via permissionA.
    prisma.friend.findMany.mockResolvedValue([
      {
        userID: 'author-1',
        friendID: 'viewer-1',
        permissionA: 'CHAT_ONLY',
        permissionB: 'FULL',
      },
    ]);

    await expect(service.getTraceById('viewer-1', 'trace-1')).rejects.toThrow(
      NotFoundException,
    );
  });

  // 点赞 / 评论 / 详情此前为判断「作者是不是 viewer 的好友」把 viewer 的已接受好友
  // 整表读出来（最多 5000 行），再加一条 chat-only 查询。现在是对这一个作者的单点查询，
  // 一条语句同时给出「是不是好友」和「作者是否只授予了 CHAT_ONLY」。可见性规则不变。
  describe('single-author friendship check (like / comment / detail)', () => {
    const PAIR_QUERY = {
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: 'author-1', friendID: 'viewer-1' },
          { userID: 'viewer-1', friendID: 'author-1' },
        ],
      },
      select: {
        userID: true,
        friendID: true,
        permissionA: true,
        permissionB: true,
      },
    };
    const trace = (visibility: string, fromID = 'author-1') => ({
      id: 'trace-1',
      fromID,
      deleted: false,
      visibility,
      likeCount: 0,
    });
    const friendship = (
      permissions: { permissionA?: string; permissionB?: string } = {},
      viewerIsUserID = true,
    ) => ({
      userID: viewerIsUserID ? 'viewer-1' : 'author-1',
      friendID: viewerIsUserID ? 'author-1' : 'viewer-1',
      permissionA: permissions.permissionA ?? 'FULL',
      permissionB: permissions.permissionB ?? 'FULL',
    });
    /** 走到点赞事务之前就停：只看可见性闸门的结果。 */
    const gate = () => service.toggleLike('viewer-1', 'trace-1');

    beforeEach(() => {
      prisma.$transaction.mockImplementation(async () => {
        throw new Error('past the gate');
      });
    });

    afterEach(() => {
      // 换回 harness 的默认实现，别把「过闸即抛」漏给后面的用例。
      prisma.$transaction.mockImplementation(async (input: any) =>
        Array.isArray(input) ? Promise.all(input) : input(prisma),
      );
    });

    it('queries only the viewer–author pair, never the whole friend list', async () => {
      prisma.trace.findFirst.mockResolvedValue(trace('FRIENDS_ONLY'));
      prisma.friend.findMany.mockResolvedValue([friendship()]);

      await expect(gate()).rejects.toThrow('past the gate');

      expect(prisma.friend.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.friend.findMany).toHaveBeenCalledWith(PAIR_QUERY);
      expect(privacySettings.canViewMoments).toHaveBeenCalledWith(
        'author-1',
        false,
        true,
      );
    });

    it('lets the author through without any friendship lookup', async () => {
      prisma.trace.findFirst.mockResolvedValue(trace('PRIVATE', 'viewer-1'));

      await expect(gate()).rejects.toThrow('past the gate');

      expect(prisma.friend.findMany).not.toHaveBeenCalled();
      expect(privacySettings.canViewMoments).not.toHaveBeenCalled();
    });

    it.each([
      [
        'the author is userID (permissionA)',
        { permissionA: 'CHAT_ONLY' },
        false,
      ],
      [
        'the author is friendID (permissionB)',
        { permissionB: 'CHAT_ONLY' },
        true,
      ],
    ])(
      'hides the moment as not found when %s granted only CHAT_ONLY',
      async (_, permissions, viewerIsUserID) => {
        prisma.trace.findFirst.mockResolvedValue(trace('PUBLIC'));
        prisma.friend.findMany.mockResolvedValue([
          friendship(permissions, viewerIsUserID),
        ]);

        await expect(gate()).rejects.toThrow(NotFoundException);
        expect(privacySettings.canViewMoments).not.toHaveBeenCalled();
      },
    );

    it("ignores the viewer's own CHAT_ONLY grant to the author", async () => {
      // viewer 给作者设了 CHAT_ONLY，挡的是作者看 viewer，不挡 viewer 看作者。
      prisma.trace.findFirst.mockResolvedValue(trace('FRIENDS_ONLY'));
      prisma.friend.findMany.mockResolvedValue([
        friendship({ permissionA: 'CHAT_ONLY' }, true),
      ]);

      await expect(gate()).rejects.toThrow('past the gate');
    });

    it('treats any CHAT_ONLY row of a duplicated friendship as chat-only', async () => {
      prisma.trace.findFirst.mockResolvedValue(trace('FRIENDS_ONLY'));
      prisma.friend.findMany.mockResolvedValue([
        friendship(),
        friendship({ permissionA: 'CHAT_ONLY' }, false),
      ]);

      await expect(gate()).rejects.toThrow(NotFoundException);
    });

    it('forbids a FRIENDS_ONLY moment to a non-friend', async () => {
      prisma.trace.findFirst.mockResolvedValue(trace('FRIENDS_ONLY'));
      prisma.friend.findMany.mockResolvedValue([]);

      await expect(gate()).rejects.toThrow(ForbiddenException);
      expect(privacySettings.canViewMoments).toHaveBeenCalledWith(
        'author-1',
        false,
        false,
      );
    });

    it('opens a PUBLIC moment to a non-friend the author allows', async () => {
      prisma.trace.findFirst.mockResolvedValue(trace('PUBLIC'));
      prisma.friend.findMany.mockResolvedValue([]);

      await expect(gate()).rejects.toThrow('past the gate');
      expect(privacySettings.canViewMoments).toHaveBeenCalledWith(
        'author-1',
        false,
        false,
      );
    });

    it('forbids a PUBLIC moment when the author hides moments from friends', async () => {
      prisma.trace.findFirst.mockResolvedValue(trace('PUBLIC'));
      prisma.friend.findMany.mockResolvedValue([friendship()]);
      privacySettings.canViewMoments.mockResolvedValue(false);

      await expect(gate()).rejects.toThrow(ForbiddenException);
      expect(privacySettings.canViewMoments).toHaveBeenCalledWith(
        'author-1',
        false,
        true,
      );
    });

    it('forbids a PRIVATE moment even to a friend, judged as a non-friend', async () => {
      prisma.trace.findFirst.mockResolvedValue(trace('PRIVATE'));
      prisma.friend.findMany.mockResolvedValue([friendship()]);

      await expect(gate()).rejects.toThrow(ForbiddenException);
      // 与旧实现一致：PRIVATE 不查好友列表，按非好友去问作者设置。
      expect(privacySettings.canViewMoments).toHaveBeenCalledWith(
        'author-1',
        false,
        false,
      );
    });

    it('addComment goes through the same single-pair gate', async () => {
      prisma.trace.findFirst.mockResolvedValue(trace('FRIENDS_ONLY'));
      prisma.friend.findMany.mockResolvedValue([]);

      await expect(
        service.addComment('viewer-1', 'trace-1', { content: 'hi' }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.friend.findMany).toHaveBeenCalledWith(PAIR_QUERY);
    });

    it('getTraceById checks friendship only for the people in the previews', async () => {
      prisma.trace.findFirst.mockResolvedValue({
        ...trace('FRIENDS_ONLY'),
        content: 'hello',
        images: [],
        replyCount: 2,
        createdAt: new Date('2026-06-08T00:00:00.000Z'),
        from: { id: 'author-1', nickname: 'Author', avatarUrl: null },
      });
      prisma.traceLikeStat.findFirst.mockResolvedValue(null);
      stubPreviews(
        [likeRow('trace-1', 'mutual'), likeRow('trace-1', 'stranger')],
        [
          commentRow('trace-1', 'c-2', 'stranger'),
          commentRow('trace-1', 'c-1', 'mutual'),
        ],
      );
      prisma.friend.findMany
        // 可见性闸门：viewer 与作者是好友。
        .mockResolvedValueOnce([friendship()])
        // 共同好友过滤：预览里只有 mutual 是 viewer 的好友。
        .mockResolvedValueOnce([{ userID: 'mutual', friendID: 'viewer-1' }]);

      const result = await service.getTraceById('viewer-1', 'trace-1');

      expect(prisma.friend.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.friend.findMany).toHaveBeenLastCalledWith({
        where: {
          state: 'ACCEPTED',
          OR: [
            { userID: 'viewer-1', friendID: { in: ['mutual', 'stranger'] } },
            { userID: { in: ['mutual', 'stranger'] }, friendID: 'viewer-1' },
          ],
        },
        select: { userID: true, friendID: true },
      });
      expect(result.likedFriends).toEqual([
        { id: 'mutual', nickname: 'nick-mutual' },
      ]);
      expect(result.comments.map((comment) => comment.id)).toEqual(['c-1']);
    });
  });

  it('rejects replying to a comment from a different trace', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceComment.findFirst.mockResolvedValue({
      id: 'comment-1',
      traceID: 'trace-2',
      deleted: false,
    });
    prisma.friend.findMany.mockResolvedValue([]);

    await expect(
      service.addComment('viewer-1', 'trace-1', {
        content: 'reply',
        replyToId: 'comment-1',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('addComment returns the parent COMMENT id as replyTo.id (client threads by it)', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceComment.findFirst.mockResolvedValue({
      id: 'parent-comment',
      traceID: 'trace-1',
      deleted: false,
    });
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'reply-comment',
      content: 'a reply',
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      // Prisma returns the parent comment relation; its `id` is the comment id,
      // while `user` is the replied-to author.
      replyTo: {
        id: 'parent-comment',
        user: { id: 'author-1', nickname: 'Bob' },
      },
    });
    prisma.trace.update.mockResolvedValue({});

    const result = await service.addComment('actor-1', 'trace-1', {
      content: 'a reply',
      replyToId: 'parent-comment',
    });

    // id is the parent comment id (not the author's user id 'author-1');
    // nickname is the replied-to user.
    expect(result.replyTo).toEqual({ id: 'parent-comment', nickname: 'Bob' });
  });

  it('addComment stores images and allows an image-only comment', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-img',
      content: '',
      images: ['https://cdn.example/img.jpg'],
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    const result = await service.addComment('actor-1', 'trace-1', {
      images: ['https://cdn.example/img.jpg'],
    });

    expect(prisma.traceComment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: '',
          images: ['https://cdn.example/img.jpg'],
        }),
      }),
    );
    expect(result.images).toEqual(['https://cdn.example/img.jpg']);
  });

  it('rejects blank image entries instead of storing an empty image comment', async () => {
    await expect(
      service.addComment('actor-1', 'trace-1', { images: [''] }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.traceComment.create).not.toHaveBeenCalled();
  });

  it('addComment rejects a comment with neither text nor images', async () => {
    await expect(
      service.addComment('actor-1', 'trace-1', { content: '   ' }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.traceComment.create).not.toHaveBeenCalled();
  });

  it('creates the comment and aggregates missing or inactive mentions as ignored', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    const result = await service.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: ['mention-user-1'],
    });

    expect(result.ignoredMentionCount).toBe(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['mention-user-1'] },
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    expect(prisma.traceComment.create).toHaveBeenCalled();
    expect(
      notificationService.createTraceCommentNotifications,
    ).toHaveBeenCalledWith(expect.objectContaining({ mentionedUserIds: [] }));
  });

  it('creates the comment while filtering mentions blocked by author privacy', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'mention-user-1' }]);
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.getSettingsMany.mockResolvedValue(
      new Map([['actor-1', { momentsVisibility: 'PRIVATE' }]]),
    );
    privacySettings.momentsVisibleFor.mockImplementationOnce(() => false);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    const result = await service.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: ['mention-user-1'],
    });

    expect(result.ignoredMentionCount).toBe(1);
    expect(prisma.traceComment.create).toHaveBeenCalled();
  });

  it('keeps eligible mentions, filters ineligible ones, and exposes only the aggregate count', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'mention-user-1' }]);
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.canViewMoments.mockResolvedValue(true);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    const result = await service.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: ['actor-1', 'mention-user-1', 'missing-user-1'],
    });

    expect(result.ignoredMentionCount).toBe(1);
    expect(result).not.toHaveProperty('ignoredMentionUserIds');
    expect(
      notificationService.createTraceCommentNotifications,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        mentionedUserIds: ['mention-user-1'],
      }),
    );
  });

  it('filters private, inactive, and missing recipients without aborting the comment', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PRIVATE',
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'private-user-1' }]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    const result = await service.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: ['private-user-1', 'inactive-user-1', 'missing-user-1'],
    });

    expect(result.ignoredMentionCount).toBe(3);
    expect(
      notificationService.createTraceCommentNotifications,
    ).toHaveBeenCalledWith(expect.objectContaining({ mentionedUserIds: [] }));
  });

  it('authorizes the maximum mention set with bounded batch queries', async () => {
    const mentionedUserIds = Array.from(
      { length: 20 },
      (_, index) => `mention-user-${index + 1}`,
    );
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue(
      mentionedUserIds.map((id) => ({ id })),
    );
    prisma.friend.findMany.mockResolvedValue(
      mentionedUserIds.map((friendID) => ({
        userID: 'actor-1',
        friendID,
        permissionA: 'FULL',
        permissionB: 'FULL',
      })),
    );
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    await service.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds,
    });

    expect(prisma.trace.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.friend.findMany).toHaveBeenCalledTimes(1);
    expect(privacySettings.getSettingsMany).toHaveBeenCalledTimes(1);
    expect(privacySettings.canViewMoments).not.toHaveBeenCalled();
  });

  it('propagates mention authorization database failures unchanged', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'mention-user-1' }]);
    prisma.friend.findMany.mockRejectedValue(
      new Error('friendship database unavailable'),
    );

    await expect(
      service.addComment('actor-1', 'trace-1', {
        content: 'hello',
        mentionedUserIds: ['mention-user-1'],
      }),
    ).rejects.toThrow('friendship database unavailable');

    expect(prisma.traceComment.create).not.toHaveBeenCalled();
  });

  it('returns trace-unavailable without recipient details when the boundary trace is missing', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'mention-user-1' }]);
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    await service.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: ['mention-user-1'],
    });
    const [notificationParams] = notificationService
      .createTraceCommentNotifications.mock.calls[0] as unknown as [
      {
        recheckMentionEligibility: (recipientIds: string[]) => Promise<{
          traceAvailable: boolean;
          eligibleUserIds: string[];
        }>;
      },
    ];
    prisma.trace.findFirst.mockResolvedValue(null);

    await expect(
      notificationParams.recheckMentionEligibility(['mention-user-1']),
    ).resolves.toEqual({ traceAvailable: false, eligibleUserIds: [] });
  });

  it('propagates trace refresh database failures from the boundary callback', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'actor-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.user.findMany.mockResolvedValue([{ id: 'mention-user-1' }]);
    prisma.friend.findMany.mockResolvedValue([]);
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      images: [],
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});

    await service.addComment('actor-1', 'trace-1', {
      content: 'hello',
      mentionedUserIds: ['mention-user-1'],
    });
    const [notificationParams] = notificationService
      .createTraceCommentNotifications.mock.calls[0] as unknown as [
      {
        recheckMentionEligibility: (recipientIds: string[]) => Promise<{
          traceAvailable: boolean;
          eligibleUserIds: string[];
        }>;
      },
    ];
    const databaseError = new Error('trace refresh database unavailable');
    prisma.trace.findFirst.mockRejectedValue(databaseError);

    await expect(
      notificationParams.recheckMentionEligibility(['mention-user-1']),
    ).rejects.toBe(databaseError);
  });

  it('broadcasts the created notification payload after adding a trace comment', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});
    notificationService.createTraceCommentNotifications.mockResolvedValue([
      {
        targetUserId: 'author-1',
        notification: {
          id: 'notification-1',
          type: 'TRACE_COMMENT',
          content: 'hello',
          read: false,
          createdAt: '2026-06-08T00:00:00.000Z',
          fromUser: { id: 'actor-1', nickname: 'Alice', avatarUrl: null },
          fromTrace: { id: 'trace-1', excerpt: 'trace', firstImage: null },
          fromReply: { id: 'comment-1', content: 'hello' },
          fromCircle: null,
          fromCirclePost: null,
          fromInvitation: null,
        },
      },
    ]);

    await service.addComment('actor-1', 'trace-1', { content: 'hello' });

    expect(realtimeService.broadcastInteractionUnread).toHaveBeenCalledWith(
      'author-1',
    );
    expect(realtimeService.broadcastNotificationCreated).toHaveBeenCalledWith(
      'author-1',
      expect.objectContaining({ id: 'notification-1', type: 'TRACE_COMMENT' }),
    );
  });

  it('does not fail an added trace comment when notification delivery fails', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.traceComment.create.mockResolvedValue({
      id: 'comment-1',
      content: 'hello',
      createdAt: new Date('2026-06-08T00:00:00.000Z'),
      user: { id: 'actor-1', nickname: 'Alice' },
      replyTo: null,
    });
    prisma.trace.update.mockResolvedValue({});
    notificationService.createTraceCommentNotifications.mockRejectedValue(
      new Error('notification unavailable'),
    );

    await expect(
      service.addComment('actor-1', 'trace-1', { content: 'hello' }),
    ).resolves.toEqual(
      expect.objectContaining({ id: 'comment-1', content: 'hello' }),
    );
  });

  // 嵌套 include 的 likeStats / comments 带 take 时，Prisma 7 不生成 LIMIT：一页 feed
  // 把每条动态的全部点赞、全部评论连同 user / replyTo 都读了出来。预览改成两条原生 SQL，
  // 每条动态在 SQL 里各取前 20 条。
  it('loads like and comment previews with a per-trace LIMIT instead of nested includes', async () => {
    stubFriendScope('friend-1');
    stubFeedTraces([
      makeTraceRow('trace-1', new Date('2026-06-08T00:00:00.000Z')),
      makeTraceRow('trace-2', new Date('2026-06-07T00:00:00.000Z')),
    ]);
    prisma.trace.count.mockResolvedValue(2);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', { page: 1, limit: 20 });

    const [feedQuery] = prisma.trace.findMany.mock.calls[0];
    expect(feedQuery.include).not.toHaveProperty('likeStats');
    expect(feedQuery.include).not.toHaveProperty('comments');
    // 好友范围、这一页的 id、点赞预览、评论预览：四条原生 SQL。
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      traceLikePreviewQuery(['trace-1', 'trace-2'], 20),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      traceCommentPreviewQuery(['trace-1', 'trace-2'], 20),
    );
  });

  it('skips the preview queries and the row hydration when the page is empty', async () => {
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', { page: 1, limit: 20 });

    const rawQueries = prisma.$queryRaw.mock.calls.map(([query]) => query);
    expect(rawQueries.filter(isLikePreview)).toHaveLength(0);
    expect(rawQueries.filter(isCommentPreview)).toHaveLength(0);
    expect(prisma.trace.findMany).not.toHaveBeenCalled();
  });

  it('maps preview rows onto each trace with the mutual-friend filter and oldest-first comments', async () => {
    stubFriendScope('friend-1', 'friend-2');
    stubFeedTraces([
      makeTraceRow('trace-1', new Date('2026-06-08T00:00:00.000Z')),
      makeTraceRow('trace-2', new Date('2026-06-07T00:00:00.000Z')),
    ]);
    prisma.trace.count.mockResolvedValue(2);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);
    stubPreviews(
      [
        likeRow('trace-1', 'friend-2'),
        // 陌生人（不是 viewer 的好友，也不是作者/本人）的赞不展示 —— 微信朋友圈口径。
        likeRow('trace-1', 'stranger'),
        likeRow('trace-1', 'viewer-1'),
        likeRow('trace-2', 'friend-1'),
      ],
      [
        // SQL 按 createdAt 倒序给出；DTO 里是旧 → 新。
        commentRow('trace-1', 'c-3', 'friend-1', {
          createdAt: new Date('2026-06-08T03:00:00.000Z'),
          replyToID: 'c-1',
          replyToNickname: 'nick-friend-2',
        }),
        commentRow('trace-1', 'c-2', 'stranger', {
          createdAt: new Date('2026-06-08T02:00:00.000Z'),
        }),
        commentRow('trace-1', 'c-1', 'friend-2', {
          createdAt: new Date('2026-06-08T01:00:00.000Z'),
          images: ['https://cdn.example/a.jpg'],
        }),
      ],
    );

    const result = await service.getFeed('viewer-1', { page: 1, limit: 20 });

    const [first, second] = result.items;
    expect(first.likedFriends).toEqual([
      { id: 'friend-2', nickname: 'nick-friend-2' },
      { id: 'viewer-1', nickname: 'nick-viewer-1' },
    ]);
    expect(first.comments.map((comment) => comment.id)).toEqual(['c-1', 'c-3']);
    expect(first.comments[0]).toEqual(
      expect.objectContaining({
        id: 'c-1',
        content: 'content-c-1',
        images: ['https://cdn.example/a.jpg'],
        user: { id: 'friend-2', nickname: 'nick-friend-2' },
        replyTo: null,
        ignoredMentionCount: 0,
        createdAt: '2026-06-08T01:00:00.000Z',
      }),
    );
    // replyTo.id 是父评论 id（客户端按它串楼），nickname 是被回复人。
    expect(first.comments[1].replyTo).toEqual({
      id: 'c-1',
      nickname: 'nick-friend-2',
    });
    expect(second.likedFriends).toEqual([
      { id: 'friend-1', nickname: 'nick-friend-1' },
    ]);
    expect(second.comments).toEqual([]);
  });

  it('drops replyTo when the parent comment row is gone', async () => {
    stubFeedTraces([
      makeTraceRow('trace-1', new Date('2026-06-08T00:00:00.000Z')),
    ]);
    prisma.trace.count.mockResolvedValue(1);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);
    stubPreviews(
      [],
      [
        commentRow('trace-1', 'c-1', 'viewer-1', {
          replyToID: null,
          replyToNickname: null,
        }),
      ],
    );

    const result = await service.getFeed('viewer-1', { page: 1, limit: 20 });

    expect(result.items[0].comments[0].replyTo).toBeNull();
  });

  // 好友范围每个 feed 页都要跑。按好友业务上限（会员 5000，FriendService 的
  // FRIEND_LIMIT_MEMBER）收口，排序与 listFriends 一致；好友 id 与 CHAT_ONLY 授权
  // 一次读出来，不再拿 5000 个 id 的 IN 列表把同一批关系行再读一遍。
  it('reads the accepted-friend scope once, bounded at the friend business cap', async () => {
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', { page: 1, limit: 20 });

    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      momentFriendScopeQuery('viewer-1', 5000),
    );
    expect(
      prisma.$queryRaw.mock.calls.filter(([q]) => isFriendScope(q)),
    ).toHaveLength(1);
    expect(prisma.friend.findMany).not.toHaveBeenCalled();
  });

  it('hides chat-only friends from the feed scope but never the viewer', async () => {
    stubFriendScope(
      'friend-open',
      { friendId: 'friend-chat-only', chatOnly: true },
      // 自己加自己的脏行即使带着 CHAT_ONLY，本人的动态也照样可见。
      { friendId: 'viewer-1', chatOnly: true },
    );
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', { page: 1, limit: 20 });

    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      traceFeedPageQuery({
        viewerId: 'viewer-1',
        authorIds: ['viewer-1', 'friend-open', 'viewer-1'],
        cursor: null,
        offset: 0,
        take: 20,
      }),
    );
    // 老客户端的 count 仍按原 where（IN 列表 + 可见性 OR）计。
    expect(prisma.trace.count).toHaveBeenCalledWith({
      where: {
        deleted: false,
        fromID: { in: ['viewer-1', 'friend-open', 'viewer-1'] },
        OR: [
          { fromID: 'viewer-1' },
          { visibility: 'FRIENDS_ONLY' },
          { visibility: 'PUBLIC' },
        ],
      },
    });
  });

  it('returns the page in SQL order and drops rows soft-deleted before hydration', async () => {
    stubFriendScope('friend-1');
    const rows = [
      makeTraceRow('t3', new Date('2026-06-03T00:00:00.000Z')),
      makeTraceRow('t2', new Date('2026-06-02T00:00:00.000Z')),
      makeTraceRow('t1', new Date('2026-06-01T00:00:00.000Z')),
    ];
    stubFeedTraces(rows);
    // 回填查询不保证次序；t2 在两次读取之间被软删（where deleted=false 查不到）。
    prisma.trace.findMany.mockResolvedValueOnce([rows[2], rows[0]]);
    prisma.trace.count.mockResolvedValue(3);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const result = await service.getFeed('viewer-1', { page: 1, limit: 20 });

    expect(prisma.trace.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['t3', 't2', 't1'] }, deleted: false },
      include: {
        from: {
          select: {
            id: true,
            nickname: true,
            avatarUrl: true,
            vipLevel: true,
            vipExpiresAt: true,
          },
        },
      },
    });
    expect(result.items.map((item) => item.id)).toEqual(['t3', 't1']);
    expect(result.total).toBe(3);
  });

  it('counts new moments over the same one-read friend scope', async () => {
    stubFriendScope('friend-1', {
      friendId: 'friend-chat-only',
      chatOnly: true,
    });
    prisma.trace.count.mockResolvedValue(4);

    const count = await service.getNewCount(
      'viewer-1',
      '2026-06-01T00:00:00.000Z',
    );

    expect(count).toBe(4);
    expect(prisma.friend.findMany).not.toHaveBeenCalled();
    expect(prisma.trace.count).toHaveBeenCalledWith({
      where: {
        deleted: false,
        fromID: { in: ['viewer-1', 'friend-1'] },
        createdAt: { gt: new Date('2026-06-01T00:00:00.000Z') },
        OR: [
          { fromID: 'viewer-1' },
          { visibility: 'FRIENDS_ONLY' },
          { visibility: 'PUBLIC' },
        ],
      },
    });
  });

  it('resolves feed author appearances in one deduped batch', async () => {
    stubFriendScope('friend-1');
    stubFeedTraces([
      makeTraceRow('trace-1', new Date('2026-06-08T00:00:00.000Z')),
      makeTraceRow('trace-2', new Date('2026-06-07T00:00:00.000Z')),
    ]);
    prisma.trace.count.mockResolvedValue(2);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);
    avatarFrames.resolvePublicAppearances.mockResolvedValue(
      new Map([
        [
          'friend-1',
          {
            vipLevel: 0,
            avatarFrame: {
              id: 'frame-1',
              key: 'admin-gift',
              name: 'Gift frame',
              imageUrl: null,
            },
          },
        ],
      ]),
    );

    const result = await service.getFeed('viewer-1', {});

    expect(avatarFrames.resolvePublicAppearances).toHaveBeenCalledTimes(1);
    expect(avatarFrames.resolvePublicAppearances).toHaveBeenCalledWith([
      'friend-1',
    ]);
    expect(result.items[0].author.avatarFrameAppearance).toEqual({
      id: 'frame-1',
      key: 'admin-gift',
      name: 'Gift frame',
      imageUrl: null,
    });
  });

  it('narrows the feed to a single author when authorId is a visible friend', async () => {
    prisma.friend.findMany.mockResolvedValue([
      { userID: 'viewer-1', friendID: 'friend-1' },
    ]);
    privacySettings.canViewMoments.mockResolvedValue(true);
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', {
      page: 1,
      limit: 20,
      authorId: 'friend-1',
    });

    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      traceFeedPageQuery({
        viewerId: 'viewer-1',
        authorIds: ['friend-1'],
        cursor: null,
        offset: 0,
        take: 20,
      }),
    );
    expect(prisma.trace.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ fromID: 'friend-1' }),
    });
  });

  it('returns empty without querying when authorId is not visible to the viewer', async () => {
    prisma.friend.findMany.mockResolvedValue([]);
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const result = await service.getFeed('viewer-1', {
      page: 1,
      limit: 20,
      authorId: 'stranger-1',
    });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(feedPageQueries()).toHaveLength(0);
    expect(prisma.trace.findMany).not.toHaveBeenCalled();
  });

  it('hides a chat-only friend from the album feed even when asked by authorId', async () => {
    // friend-1 (friendID) granted viewer-1 (userID) only CHAT_ONLY via permissionB,
    // so viewer-1 must not see friend-1's moments.
    prisma.friend.findMany.mockResolvedValue([
      {
        userID: 'viewer-1',
        friendID: 'friend-1',
        permissionA: 'FULL',
        permissionB: 'CHAT_ONLY',
      },
    ]);
    privacySettings.canViewMoments.mockResolvedValue(true);
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const result = await service.getFeed('viewer-1', {
      page: 1,
      limit: 20,
      authorId: 'friend-1',
    });

    expect(result.items).toEqual([]);
    expect(feedPageQueries()).toHaveLength(0);
  });

  // 相册（authorId）只看一个作者：此前同样把 viewer 的全部好友（最多 5000）读出来、
  // 对整个好友集合跑隐私过滤，只为判断这一个作者可不可见。
  describe('album visibility without loading the friend list', () => {
    const albumQuery = { page: 1, limit: 20, authorId: 'friend-1' };
    const bulkFriendScope = expect.objectContaining({ take: 5000 });
    const albumPage = (authorId: string) =>
      traceFeedPageQuery({
        viewerId: 'viewer-1',
        authorIds: [authorId],
        cursor: null,
        offset: 0,
        take: 20,
      });

    beforeEach(() => {
      prisma.trace.count.mockResolvedValue(0);
      prisma.traceLikeStat.findMany.mockResolvedValue([]);
    });

    it("checks only the viewer–author pair and that author's settings", async () => {
      prisma.friend.findMany.mockResolvedValue([
        {
          userID: 'viewer-1',
          friendID: 'friend-1',
          permissionA: 'FULL',
          permissionB: 'FULL',
        },
      ]);

      await service.getFeed('viewer-1', albumQuery);

      expect(prisma.friend.findMany).not.toHaveBeenCalledWith(bulkFriendScope);
      expect(
        prisma.$queryRaw.mock.calls.filter(([q]) => isFriendScope(q)),
      ).toHaveLength(0);
      expect(prisma.friend.findMany).toHaveBeenCalledWith({
        where: {
          state: 'ACCEPTED',
          OR: [
            { userID: 'friend-1', friendID: 'viewer-1' },
            { userID: 'viewer-1', friendID: 'friend-1' },
          ],
        },
        select: {
          userID: true,
          friendID: true,
          permissionA: true,
          permissionB: true,
        },
      });
      expect(privacySettings.getSettingsMany).toHaveBeenCalledWith([
        'friend-1',
      ]);
      expect(prisma.$queryRaw).toHaveBeenCalledWith(albumPage('friend-1'));
    });

    it.each([
      ['PRIVATE', false],
      ['FRIENDS_ONLY', true],
      ['ALL', true],
    ])(
      "applies the author's momentsVisibility=%s to a friend (visible=%s)",
      async (momentsVisibility, visible) => {
        prisma.friend.findMany.mockResolvedValue([
          {
            userID: 'friend-1',
            friendID: 'viewer-1',
            permissionA: 'FULL',
            permissionB: 'FULL',
          },
        ]);
        privacySettings.getSettingsMany.mockResolvedValue(
          new Map([['friend-1', { momentsVisibility }]]),
        );

        const result = await service.getFeed('viewer-1', albumQuery);

        expect(feedPageQueries()).toHaveLength(visible ? 1 : 0);
        expect(result.total).toBe(0);
      },
    );

    it("keeps a non-friend's album empty even when the author shows moments to everyone", async () => {
      prisma.friend.findMany.mockResolvedValue([]);
      privacySettings.getSettingsMany.mockResolvedValue(
        new Map([['friend-1', { momentsVisibility: 'ALL' }]]),
      );

      const result = await service.getFeed('viewer-1', albumQuery);

      expect(result.items).toEqual([]);
      expect(feedPageQueries()).toHaveLength(0);
    });

    it("opens the viewer's own album without any friendship lookup for the gate", async () => {
      await service.getFeed('viewer-1', {
        ...albumQuery,
        authorId: 'viewer-1',
      });

      expect(prisma.friend.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).toHaveBeenCalledWith(albumPage('viewer-1'));
    });

    it("filters album likes and comments by a friendship lookup over the page's people only", async () => {
      prisma.friend.findMany
        // 相册闸门：viewer 与作者 friend-1 是好友。
        .mockResolvedValueOnce([
          {
            userID: 'viewer-1',
            friendID: 'friend-1',
            permissionA: 'FULL',
            permissionB: 'FULL',
          },
        ])
        // 共同好友过滤：这一页的点赞 / 评论人里只有 mutual 是 viewer 的好友。
        .mockResolvedValueOnce([{ userID: 'viewer-1', friendID: 'mutual' }]);
      stubFeedTraces([
        makeTraceRow('trace-1', new Date('2026-06-08T00:00:00.000Z')),
      ]);
      prisma.trace.count.mockResolvedValue(1);
      stubPreviews(
        [likeRow('trace-1', 'mutual'), likeRow('trace-1', 'stranger')],
        [
          commentRow('trace-1', 'c-1', 'stranger'),
          commentRow('trace-1', 'c-0', 'friend-1'),
        ],
      );

      const result = await service.getFeed('viewer-1', albumQuery);

      expect(prisma.friend.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.friend.findMany).toHaveBeenLastCalledWith({
        where: {
          state: 'ACCEPTED',
          OR: [
            {
              userID: 'viewer-1',
              friendID: { in: ['mutual', 'stranger', 'friend-1'] },
            },
            {
              userID: { in: ['mutual', 'stranger', 'friend-1'] },
              friendID: 'viewer-1',
            },
          ],
        },
        select: { userID: true, friendID: true },
      });
      expect(result.items[0].likedFriends).toEqual([
        { id: 'mutual', nickname: 'nick-mutual' },
      ]);
      // 作者本人的评论总是可见。
      expect(result.items[0].comments.map((comment) => comment.id)).toEqual([
        'c-0',
      ]);
    });
  });

  it('excludes a friend who hides their moments from the feed scope (batched privacy check)', async () => {
    stubFriendScope('friend-open', 'friend-private');
    // friend-private has momentsVisibility=PRIVATE; getSettingsMany surfaces it.
    privacySettings.getSettingsMany.mockResolvedValue(
      new Map([['friend-private', { momentsVisibility: 'PRIVATE' }]]),
    );
    prisma.trace.count.mockResolvedValue(0);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    await service.getFeed('viewer-1', { page: 1, limit: 20 });

    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      traceFeedPageQuery({
        viewerId: 'viewer-1',
        authorIds: ['viewer-1', 'friend-open'],
        cursor: null,
        offset: 0,
        take: 20,
      }),
    );
  });

  it('keyset mode (cursor): no skip, no count(), fetches limit+1 with the tuple predicate', async () => {
    stubFriendScope('friend-1');
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    // limit=2 → return 3 rows so the extra row signals a next page.
    stubFeedTraces([
      makeTraceRow('t3', new Date('2026-06-03T00:00:00.000Z')),
      makeTraceRow('t2', new Date('2026-06-02T00:00:00.000Z')),
      makeTraceRow('t1', new Date('2026-06-01T00:00:00.000Z')),
    ]);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const cursor = encodeTraceCursor(
      new Date('2026-06-04T00:00:00.000Z'),
      't4',
    );
    const result = await service.getFeed('viewer-1', { limit: 2, cursor });

    // No count() runs on the keyset path.
    expect(prisma.trace.count).not.toHaveBeenCalled();
    // limit + 1 rows from the cursor on, no offset.
    expect(prisma.$queryRaw).toHaveBeenCalledWith(
      traceFeedPageQuery({
        viewerId: 'viewer-1',
        authorIds: ['viewer-1', 'friend-1'],
        cursor: {
          createdAt: new Date('2026-06-04T00:00:00.000Z'),
          id: 't4',
        },
        offset: 0,
        take: 3,
      }),
    );
    // 多取的那一行不回填。
    expect(prisma.trace.findMany.mock.calls[0][0].where.id.in).toEqual([
      't3',
      't2',
    ]);

    // Only `limit` items returned; the dropped extra row drives hasMore/cursor.
    expect(result.items).toHaveLength(2);
    expect(result.total).toBeNull();
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(
      encodeTraceCursor(new Date('2026-06-02T00:00:00.000Z'), 't2'),
    );
  });

  it('keyset last page: fewer than limit+1 rows → hasMore false, nextCursor null', async () => {
    privacySettings.getSettingsMany.mockResolvedValue(new Map());
    stubFeedTraces([makeTraceRow('t1', new Date('2026-06-01T00:00:00.000Z'))]);
    prisma.traceLikeStat.findMany.mockResolvedValue([]);

    const cursor = encodeTraceCursor(
      new Date('2026-06-02T00:00:00.000Z'),
      't2',
    );
    const result = await service.getFeed('viewer-1', { limit: 2, cursor });

    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('rejects a malformed cursor before touching the DB', async () => {
    await expect(
      service.getFeed('viewer-1', { cursor: 'not a valid cursor' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.trace.findMany).not.toHaveBeenCalled();
  });

  it('cursor encode/decode round-trips (createdAt + id)', () => {
    const at = new Date('2026-06-08T12:34:56.000Z');
    const decoded = decodeTraceCursor(encodeTraceCursor(at, 'abc-123'));
    expect(decoded.id).toBe('abc-123');
    expect(decoded.createdAt.toISOString()).toBe(at.toISOString());
  });

  it('toggleLike increments likeCount atomically and returns the DB value', async () => {
    const notification = {
      id: 'notification-1',
      type: 'TRACE_LIKE',
    };
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceLikeStat.findUnique.mockResolvedValue(null);
    prisma.traceLikeStat.create.mockResolvedValue({ id: 'like-1' });
    prisma.trace.update.mockResolvedValue({ likeCount: 8 });
    notificationService.createTraceLikeNotification.mockResolvedValue(
      notification,
    );

    const result = await service.toggleLike('viewer-1', 'trace-1');

    expect(result).toEqual({ liked: true, likeCount: 8 });
    expect(prisma.trace.update).toHaveBeenCalledWith({
      where: { id: 'trace-1' },
      data: { likeCount: { increment: 1 } },
      select: { likeCount: true },
    });
    expect(
      notificationService.createTraceLikeNotification,
    ).toHaveBeenCalledWith({
      actorId: 'viewer-1',
      traceId: 'trace-1',
      traceOwnerId: 'author-1',
    });
    expect(realtimeService.broadcastNotificationCreated).toHaveBeenCalledWith(
      'author-1',
      notification,
    );
  });

  it('does not fail a successful like when notification delivery fails', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceLikeStat.findUnique.mockResolvedValue(null);
    prisma.traceLikeStat.create.mockResolvedValue({ id: 'like-1' });
    prisma.trace.update.mockResolvedValue({ likeCount: 8 });
    notificationService.createTraceLikeNotification.mockRejectedValue(
      new Error('notification unavailable'),
    );

    await expect(service.toggleLike('viewer-1', 'trace-1')).resolves.toEqual({
      liked: true,
      likeCount: 8,
    });
  });

  it('toggleLike on an existing like unlikes and decrements', async () => {
    prisma.trace.findFirst.mockResolvedValue({
      id: 'trace-1',
      fromID: 'author-1',
      deleted: false,
      visibility: 'PUBLIC',
    });
    prisma.traceLikeStat.findUnique.mockResolvedValue({
      id: 'like-1',
      deleted: false,
    });
    prisma.traceLikeStat.update.mockResolvedValue({ id: 'like-1' });
    prisma.trace.update.mockResolvedValue({ likeCount: 4 });

    const result = await service.toggleLike('viewer-1', 'trace-1');

    expect(result).toEqual({ liked: false, likeCount: 4 });
    expect(prisma.trace.update).toHaveBeenCalledWith({
      where: { id: 'trace-1' },
      data: { likeCount: { increment: -1 } },
      select: { likeCount: true },
    });
    expect(
      notificationService.createTraceLikeNotification,
    ).not.toHaveBeenCalled();
    expect(realtimeService.broadcastNotificationCreated).not.toHaveBeenCalled();
  });
  describe('moments feed poke (#89)', () => {
    it('does not commit a moment when its appearance projection cannot be resolved', async () => {
      avatarFrames.resolvePublicAppearances.mockRejectedValue(
        new Error('database unavailable'),
      );

      await expect(
        service.createTrace('user-1', { content: 'hi' } as never),
      ).rejects.toThrow('database unavailable');

      expect(prisma.trace.create).not.toHaveBeenCalled();
      expect(
        realtimeService.broadcastMomentsFeedUpdated,
      ).not.toHaveBeenCalled();
    });

    it('pokes the author and accepted friends on create (FRIENDS_ONLY)', async () => {
      prisma.trace.create.mockResolvedValue({
        id: 'trace-1',
        content: 'hi',
        images: [],
        visibility: 'FRIENDS_ONLY',
        createdAt: new Date(),
        from: { id: 'user-1', nickname: 'A', avatarUrl: null },
      });
      prisma.friend.findMany.mockResolvedValue([
        {
          id: 'f-1',
          userID: 'user-1',
          friendID: 'friend-1',
          permissionA: 'ALL',
          permissionB: 'ALL',
        },
        {
          id: 'f-2',
          userID: 'friend-2',
          friendID: 'user-1',
          permissionA: 'ALL',
          permissionB: 'ALL',
        },
      ]);

      await service.createTrace('user-1', { content: 'hi' } as never);
      await new Promise((resolve) => setImmediate(resolve));

      const poked = (
        realtimeService.broadcastMomentsFeedUpdated as jest.Mock
      ).mock.calls.map((call) => call[0]);
      expect(new Set(poked)).toEqual(
        new Set(['user-1', 'friend-1', 'friend-2']),
      );
    });

    it('skips friends gated by CHAT_ONLY or hidden moments settings (PR #122 P2)', async () => {
      prisma.trace.create.mockResolvedValue({
        id: 'trace-3',
        content: 'hi',
        images: [],
        visibility: 'FRIENDS_ONLY',
        createdAt: new Date(),
        from: { id: 'user-1', nickname: 'A', avatarUrl: null },
      });
      prisma.friend.findMany.mockResolvedValue([
        // 作者侧 permissionA=CHAT_ONLY：friend-1 看不到作者朋友圈，不得 poke
        {
          id: 'f-1',
          userID: 'user-1',
          friendID: 'friend-1',
          permissionA: 'CHAT_ONLY',
          permissionB: 'ALL',
        },
        // 反向行：作者是 friendID，作者侧权限在 permissionB
        {
          id: 'f-2',
          userID: 'friend-2',
          friendID: 'user-1',
          permissionA: 'ALL',
          permissionB: 'ALL',
        },
      ]);

      await service.createTrace('user-1', { content: 'hi' } as never);
      await new Promise((resolve) => setImmediate(resolve));

      const poked = (
        realtimeService.broadcastMomentsFeedUpdated as jest.Mock
      ).mock.calls.map((call) => call[0]);
      expect(new Set(poked)).toEqual(new Set(['user-1', 'friend-2']));
    });

    it('pokes only the author when moments are hidden from friends entirely', async () => {
      prisma.trace.create.mockResolvedValue({
        id: 'trace-4',
        content: 'hi',
        images: [],
        visibility: 'FRIENDS_ONLY',
        createdAt: new Date(),
        from: { id: 'user-1', nickname: 'A', avatarUrl: null },
      });
      privacySettings.getSettingsMany.mockResolvedValue(
        new Map([['user-1', { momentsVisibility: 'NOBODY' }]]),
      );
      privacySettings.momentsVisibleFor.mockReturnValueOnce(false);

      await service.createTrace('user-1', { content: 'hi' } as never);
      await new Promise((resolve) => setImmediate(resolve));

      const poked = (
        realtimeService.broadcastMomentsFeedUpdated as jest.Mock
      ).mock.calls.map((call) => call[0]);
      expect(poked).toEqual(['user-1']);
      expect(prisma.friend.findMany).not.toHaveBeenCalled();
    });

    it('pages through fan-out past 500 rows instead of truncating (review)', async () => {
      prisma.trace.create.mockResolvedValue({
        id: 'trace-5',
        content: 'hi',
        images: [],
        visibility: 'FRIENDS_ONLY',
        createdAt: new Date(),
        from: { id: 'user-1', nickname: 'A', avatarUrl: null },
      });
      const fullPage = Array.from({ length: 500 }, (_, index) => ({
        id: `f-${index}`,
        userID: 'user-1',
        friendID: `friend-${index}`,
        permissionA: 'ALL',
        permissionB: 'ALL',
      }));
      prisma.friend.findMany
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce([
          {
            id: 'f-500',
            userID: 'user-1',
            friendID: 'friend-500',
            permissionA: 'ALL',
            permissionB: 'ALL',
          },
        ]);

      await service.createTrace('user-1', { content: 'hi' } as never);
      await new Promise((resolve) => setImmediate(resolve));

      expect(prisma.friend.findMany).toHaveBeenCalledTimes(2);
      expect(prisma.friend.findMany.mock.calls[1][0]).toMatchObject({
        cursor: { id: 'f-499' },
        skip: 1,
      });
      const poked = (
        realtimeService.broadcastMomentsFeedUpdated as jest.Mock
      ).mock.calls.map((call) => call[0]);
      // 501 个好友 + 作者
      expect(new Set(poked).size).toBe(502);
    });

    it('still pokes the author when fan-out reads fail (review)', async () => {
      prisma.trace.create.mockResolvedValue({
        id: 'trace-6',
        content: 'hi',
        images: [],
        visibility: 'FRIENDS_ONLY',
        createdAt: new Date(),
        from: { id: 'user-1', nickname: 'A', avatarUrl: null },
      });
      prisma.friend.findMany.mockRejectedValue(new Error('db down'));

      await service.createTrace('user-1', { content: 'hi' } as never);
      await new Promise((resolve) => setImmediate(resolve));

      const poked = (
        realtimeService.broadcastMomentsFeedUpdated as jest.Mock
      ).mock.calls.map((call) => call[0]);
      expect(poked).toEqual(['user-1']);
    });

    it('coalesces rapid pokes per author — leading edge fans out, burst queues a trailing one (review)', async () => {
      prisma.trace.create.mockResolvedValue({
        id: 'trace-7',
        content: 'hi',
        images: [],
        visibility: 'FRIENDS_ONLY',
        createdAt: new Date(),
        from: { id: 'user-1', nickname: 'A', avatarUrl: null },
      });
      prisma.friend.findMany.mockResolvedValue([
        {
          id: 'f-1',
          userID: 'user-1',
          friendID: 'friend-1',
          permissionA: 'ALL',
          permissionB: 'ALL',
        },
      ]);

      await service.createTrace('user-1', { content: 'hi' } as never);
      await service.createTrace('user-1', { content: 'hi again' } as never);
      await new Promise((resolve) => setImmediate(resolve));

      // 领先沿只有一次真实扇出（好友表只被查一遍）；第二次进了尾随队列
      expect(prisma.friend.findMany).toHaveBeenCalledTimes(1);
    });

    it('pokes only the author for PRIVATE moments', async () => {
      prisma.trace.create.mockResolvedValue({
        id: 'trace-2',
        content: 'secret',
        images: [],
        visibility: 'PRIVATE',
        createdAt: new Date(),
        from: { id: 'user-1', nickname: 'A', avatarUrl: null },
      });

      await service.createTrace('user-1', {
        content: 'secret',
        visibility: 'PRIVATE',
      } as never);
      await new Promise((resolve) => setImmediate(resolve));

      const poked = (
        realtimeService.broadcastMomentsFeedUpdated as jest.Mock
      ).mock.calls.map((call) => call[0]);
      expect(poked).toEqual(['user-1']);
      expect(prisma.friend.findMany).not.toHaveBeenCalled();
    });
  });
});

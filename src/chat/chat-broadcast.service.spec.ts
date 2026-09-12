/* eslint-disable sonarjs/no-internal-api-use -- This contract regression intentionally executes the installed Socket.IO RemoteSocket implementation. */
import { RemoteSocket } from '../../node_modules/socket.io/dist/broadcast-operator';
import { ChatBroadcastService } from './chat-broadcast.service';
import {
  PRESENCE_VISIBILITY_CHANGED,
  privacySettingsEvents,
} from 'src/privacy/privacy-events';

function message(conversationId = 'conv-1') {
  return {
    id: 'message-1',
    conversationId,
    height: 5,
    type: 'system',
    content: { kind: 'member-removed' },
  } as never;
}

function prismaWithActiveUsers(userIDs: string[]) {
  return {
    chatMember: {
      findMany: jest
        .fn()
        .mockResolvedValue(userIDs.map((userID) => ({ userID }))),
    },
  };
}

function realRemoteSocket(
  adapter: Record<string, unknown>,
  id = 'socket-1',
  rooms: string[] = [id],
) {
  return new RemoteSocket(adapter as never, {
    id,
    handshake: {} as never,
    rooms,
    data: { userId: 'removed-user' },
  });
}

describe('ChatBroadcastService.joinUserToConversation', () => {
  function buildHarness() {
    // This is the real RemoteSocket contract: join dispatches adapter work and
    // returns void, so callers cannot treat it as an acknowledgement.
    const sockets = [
      { join: jest.fn(() => undefined) },
      { join: jest.fn(() => undefined) },
    ];
    const server = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue(sockets),
      })),
    };
    const presence = {
      conversationJoined: jest.fn(),
      isOnline: jest.fn(),
      getOnlineUserIds: jest.fn(),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers([]) as never,
    );
    service.setServer(server as never);
    return { service, sockets, presence };
  }

  it('uses the real void RemoteSocket join contract', async () => {
    const { service, sockets, presence } = buildHarness();

    await service.joinUserToConversation('u1', 'conv-1');

    expect(presence.conversationJoined).toHaveBeenCalledWith('u1', 'conv-1');
    expect(sockets[0].join).toHaveBeenCalledWith('c:conv-1');
    expect(sockets[1].join).toHaveBeenCalledWith('c:conv-1');
  });

  it('is a no-op without an attached server', async () => {
    const presence = { conversationJoined: jest.fn() };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers([]) as never,
    );

    await expect(
      service.joinUserToConversation('u1', 'conv-1'),
    ).resolves.toBeUndefined();
  });
});

describe('ChatBroadcastService.emitHistoryCleared', () => {
  it('broadcasts the authoritative watermark to the conversation room', () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const presence = {};
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers([]) as never,
    );
    service.setServer({ to } as never);

    service.emitHistoryCleared({
      conversationId: 'conv-1',
      clearedBeforeHeight: 42,
      clearedBy: 'u1',
    });

    expect(to).toHaveBeenCalledWith('c:conv-1');
    expect(emit).toHaveBeenCalledWith('chat:history_cleared', {
      conversationId: 'conv-1',
      clearedBeforeHeight: 42,
      clearedBy: 'u1',
    });
  });
});

describe('ChatBroadcastService member eviction', () => {
  it('uses the real void RemoteSocket leave contract without pretending it is an acknowledgement', async () => {
    const adapter = { delSockets: jest.fn() };
    const socket = realRemoteSocket(adapter, 'socket-1', [
      'socket-1',
      'c:conv-1',
    ]);
    expect(socket.leave('contract-probe')).toBeUndefined();
    adapter.delSockets.mockClear();
    // 第一次查到人还在房里 → 派发 leave；第二次查已经不在 → 收敛，直接返回。
    const fetchSockets = jest
      .fn()
      .mockResolvedValueOnce([socket])
      .mockResolvedValueOnce([]);
    const server = { in: jest.fn(() => ({ fetchSockets })) };
    const presence = {
      conversationLeft: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers([]) as never,
    );
    service.setServer(server as never);

    await service.removeUserFromConversation('u1', 'conv-1');

    expect(presence.conversationLeft).toHaveBeenCalledWith('u1', 'conv-1');
    expect(adapter.delSockets).toHaveBeenCalledTimes(1);
  });

  it('uses the real RemoteSocket disconnect contract, which returns the socket rather than a promise', async () => {
    const adapter = { disconnectSockets: jest.fn() };
    const socket = realRemoteSocket(adapter);
    expect(socket.disconnect(true)).toBe(socket);
    adapter.disconnectSockets.mockClear();
    const server = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([socket]),
      })),
    };
    const service = new ChatBroadcastService(
      {} as never,
      prismaWithActiveUsers([]) as never,
    );
    service.setServer(server as never);

    await service.disconnectUserSockets('u1');

    expect(adapter.disconnectSockets).toHaveBeenCalledTimes(1);
  });

  it('targets only DB-active members even when presence still contains a removed user', async () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const presence = {
      getOnlineUserIds: jest
        .fn()
        .mockResolvedValue(['active-user', 'removed-user']),
    };
    const prisma = prismaWithActiveUsers(['active-user']);
    const service = new ChatBroadcastService(
      presence as never,
      prisma as never,
    );
    service.setServer({ to } as never);

    await service.emitMessage(message());

    expect(prisma.chatMember.findMany).toHaveBeenCalledWith({
      where: {
        conversationID: 'conv-1',
        leftAt: null,
        clearedBeforeHeight: { lt: 5 },
      },
      select: { userID: true },
    });
    expect(to).toHaveBeenCalledWith(['u:active-user']);
    expect(to).not.toHaveBeenCalledWith('c:conv-1');
    expect(emit).toHaveBeenCalledWith('chat:msg', message());
  });

  it('delivers to DB-active members when the presence registry is temporarily empty', async () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const presence = { getOnlineUserIds: jest.fn().mockResolvedValue([]) };
    const prisma = prismaWithActiveUsers(['ready-user']);
    const service = new ChatBroadcastService(
      presence as never,
      prisma as never,
    );
    service.setServer({ to } as never);

    await service.emitMessage(message());

    expect(prisma.chatMember.findMany).toHaveBeenCalledWith({
      where: {
        conversationID: 'conv-1',
        leftAt: null,
        clearedBeforeHeight: { lt: 5 },
      },
      select: { userID: true },
    });
    expect(to).toHaveBeenCalledWith(['u:ready-user']);
  });

  it('does not wait for delayed presence before querying all DB-active members', async () => {
    const presence = {
      getOnlineUserIds: jest.fn(
        () =>
          new Promise<null>(() => {
            // Deliberately unresolved: content delivery must not depend on it.
          }),
      ),
    };
    const prisma = prismaWithActiveUsers(['direct-member', 'temp-guest']);
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const service = new ChatBroadcastService(
      presence as never,
      prisma as never,
    );
    service.setServer({ to } as never);

    await service.emitMessage(message('direct-or-temp'));

    expect(presence.getOnlineUserIds).not.toHaveBeenCalled();
    expect(prisma.chatMember.findMany).toHaveBeenCalledWith({
      where: {
        conversationID: 'direct-or-temp',
        leftAt: null,
        clearedBeforeHeight: { lt: 5 },
      },
      select: { userID: true },
    });
    expect(to).toHaveBeenCalledWith(['u:direct-member', 'u:temp-guest']);
  });

  it('keeps future messages private while a void remote leave is still delayed', async () => {
    jest.useFakeTimers();
    try {
      let remoteEvicted = false;
      const adapter = {
        delSockets: jest.fn(() => {
          return new Promise<void>((resolve) => {
            setTimeout(() => {
              remoteEvicted = true;
              resolve();
            }, 100);
          });
        }),
      };
      const socket = realRemoteSocket(adapter, 'socket-1', [
        'socket-1',
        'c:conv-1',
      ]);
      const emit = jest.fn();
      const to = jest.fn(() => ({ emit }));
      const fetchSockets = jest
        .fn()
        .mockResolvedValueOnce([socket])
        .mockResolvedValueOnce([]);
      const server = { in: jest.fn(() => ({ fetchSockets })), to };
      const presence = {
        conversationLeft: jest.fn().mockResolvedValue(undefined),
        getOnlineUserIds: jest
          .fn()
          .mockResolvedValue(['active-user', 'removed-user']),
      };
      const service = new ChatBroadcastService(
        presence as never,
        prismaWithActiveUsers(['active-user']) as never,
      );
      service.setServer(server as never);

      await service.removeUserFromConversation('removed-user', 'conv-1');
      expect(remoteEvicted).toBe(false);
      await service.emitMessage(message());

      expect(to).toHaveBeenCalledWith(['u:active-user']);
      expect(to).not.toHaveBeenCalledWith('c:conv-1');
      jest.advanceTimersByTime(100);
      expect(remoteEvicted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  // leave() 没有回执，「发出去了」不等于「生效了」。发完要复查；复查仍在房里
  // 就重试；重试到上限还在，才动用断连这个粗暴手段（它会断掉该用户所有会话）。
  it('retries the leave and only disconnects once the room never converges', async () => {
    const adapter = { delSockets: jest.fn(), disconnectSockets: jest.fn() };
    // 真实的 RemoteSocket.leave() 不会改自己的 rooms，所以「一直查得到」正是
    // 没收敛的样子。
    const socket = realRemoteSocket(adapter, 'stuck-socket', [
      'stuck-socket',
      'c:conv-1',
    ]);
    const server = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([socket]),
      })),
    };
    const presence = {
      conversationLeft: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers([]) as never,
    );
    service.setServer(server as never);
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await service.removeUserFromConversation('removed-user', 'conv-1');

    expect(adapter.delSockets).toHaveBeenCalledTimes(3);
    expect(adapter.disconnectSockets).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('room eviction did not converge'),
    );
  });

  // 人不在房里（离线，或者上一次已经退掉了）：一次 leave 都不该发，也不该等。
  it('dispatches nothing when the member holds no socket in the room', async () => {
    const adapter = { delSockets: jest.fn(), disconnectSockets: jest.fn() };
    const socket = realRemoteSocket(adapter, 'elsewhere', ['elsewhere']);
    const server = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([socket]),
      })),
    };
    const presence = {
      conversationLeft: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers([]) as never,
    );
    service.setServer(server as never);

    await service.removeUserFromConversation('removed-user', 'conv-1');

    expect(adapter.delSockets).not.toHaveBeenCalled();
    expect(adapter.disconnectSockets).not.toHaveBeenCalled();
  });

  it('keeps future messages private when leave fails and void disconnect fallback cannot acknowledge completion', async () => {
    const leaveAdapter = {
      delSockets: jest.fn(() => {
        throw new Error('adapter unavailable');
      }),
    };
    const disconnectAdapter = { disconnectSockets: jest.fn() };
    const leavingRemote = realRemoteSocket(leaveAdapter, 'leaving-remote', [
      'leaving-remote',
      'c:conv-1',
    ]);
    const disconnectRemote = realRemoteSocket(
      disconnectAdapter,
      'disconnect-remote',
    );
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const fetchSockets = jest
      .fn()
      .mockResolvedValueOnce([leavingRemote])
      .mockResolvedValueOnce([disconnectRemote]);
    const server = { in: jest.fn(() => ({ fetchSockets })), to };
    const presence = {
      conversationLeft: jest.fn().mockResolvedValue(undefined),
      getOnlineUserIds: jest
        .fn()
        .mockResolvedValue(['active-user', 'removed-user']),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers(['active-user']) as never,
    );
    service.setServer(server as never);

    await expect(
      service.removeUserFromConversation('removed-user', 'conv-1'),
    ).rejects.toThrow('adapter unavailable');
    await service.disconnectUserSockets('removed-user');
    await service.emitMessage(message());

    expect(disconnectAdapter.disconnectSockets).toHaveBeenCalledTimes(1);
    expect(to).toHaveBeenCalledWith(['u:active-user']);
    expect(to).not.toHaveBeenCalledWith('c:conv-1');
  });

  it('keeps future messages private when the real void leave hides a later adapter rejection', async () => {
    let rejectAdapter!: (error: Error) => void;
    const adapterResult = new Promise<void>((_resolve, reject) => {
      rejectAdapter = reject;
    });
    // Socket.IO cannot observe this through RemoteSocket.leave(); attach a
    // test-only rejection observer so Jest does not treat it as unhandled.
    void adapterResult.catch(() => undefined);
    const leaveAdapter = {
      delSockets: jest.fn(() => adapterResult),
    };
    const socket = realRemoteSocket(leaveAdapter);
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const server = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue([socket]),
      })),
      to,
    };
    const presence = {
      conversationLeft: jest.fn().mockResolvedValue(undefined),
      getOnlineUserIds: jest
        .fn()
        .mockResolvedValue(['active-user', 'removed-user']),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers(['active-user']) as never,
    );
    service.setServer(server as never);

    await service.removeUserFromConversation('removed-user', 'conv-1');
    rejectAdapter(new Error('redis publish failed later'));
    await Promise.resolve();
    await service.emitMessage(message());

    expect(to).toHaveBeenCalledWith(['u:active-user']);
    expect(to).not.toHaveBeenCalledWith('c:conv-1');
  });

  it('explicitly excludes the removed user from the current log even if the active-seat snapshot contains them', async () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const presence = {
      getOnlineUserIds: jest
        .fn()
        .mockResolvedValue(['active-user', 'removed-user']),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers(['active-user', 'removed-user']) as never,
    );
    service.setServer({ to } as never);

    await service.emitMessageExcludingUsers(message(), ['removed-user']);

    expect(to).toHaveBeenCalledWith(['u:active-user']);
    expect(emit).toHaveBeenCalledWith('chat:msg', message());
  });
});

describe('ChatBroadcastService content-bearing edit privacy', () => {
  it('does not let an incomplete presence registry exclude an active edit recipient', async () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const findMany = jest.fn(async ({ where }: any) => {
      const active = ['registered-user', 'late-user'];
      const candidates = where.userID?.in as string[] | undefined;
      return active
        .filter((userID) => !candidates || candidates.includes(userID))
        .map((userID) => ({ userID }));
    });
    const presence = {
      getOnlineUserIds: jest.fn().mockResolvedValue(['registered-user']),
    };
    const service = new ChatBroadcastService(
      presence as never,
      { chatMember: { findMany } } as never,
    );
    service.setServer({ to } as never);

    await service.emitEdit({
      conversationId: 'conv-1',
      messageId: 'message-1',
      height: 5,
      content: { text: 'private edit' },
      editedAt: '2026-09-03T00:00:00.000Z',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        conversationID: 'conv-1',
        leftAt: null,
        clearedBeforeHeight: { lt: 5 },
      },
      select: { userID: true },
    });
    expect(to).toHaveBeenCalledWith(['u:registered-user', 'u:late-user']);
    expect(emit).toHaveBeenCalledWith('chat:edit', expect.any(Object));
  });

  it('does not deliver an edit to a removed real RemoteSocket that remains in the stale conversation room', async () => {
    const activeSocket = realRemoteSocket({}, 'active-socket', [
      'c:conv-1',
      'u:active-user',
    ]);
    const removedSocket = realRemoteSocket({}, 'removed-socket', [
      'c:conv-1',
      'u:removed-user',
    ]);
    const deliveries: string[] = [];
    const to = jest.fn((targetRooms: string | string[]) => ({
      emit: jest.fn(() => {
        const rooms = Array.isArray(targetRooms) ? targetRooms : [targetRooms];
        for (const socket of [activeSocket, removedSocket]) {
          if (rooms.some((room) => socket.rooms.has(room))) {
            deliveries.push(socket.id);
          }
        }
      }),
    }));
    const presence = {
      getOnlineUserIds: jest
        .fn()
        .mockResolvedValue(['active-user', 'removed-user']),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers(['active-user']) as never,
    );
    service.setServer({ to } as never);

    await service.emitEdit({
      conversationId: 'conv-1',
      messageId: 'message-1',
      height: 5,
      content: { text: 'private edit' },
      editedAt: '2026-09-03T00:00:00.000Z',
    });

    expect(removedSocket.rooms.has('c:conv-1')).toBe(true);
    expect(to).toHaveBeenCalledWith(['u:active-user']);
    expect(deliveries).toEqual(['active-socket']);
  });
});

/**
 * 在线判定的降级路径：Redis 配了但这一刻不可用时，绝不能再走 fetchSockets。
 *
 * 事故（2026-09-08 本地）：一条 WebSocket 断开就把整个后端进程打死。
 *   Error: Connection is closed.
 *     at RedisAdapter.serverCount / fetchSockets
 *     at async ChatBroadcastService.isUserOnline
 *
 * 根因是 null 被两种情况共用：
 *   1. Redis 压根没配（单实例部署）—— 此时 socket.io 用的是内存 adapter，
 *      fetchSockets 是本进程操作，降级到它是对的、也便宜；
 *   2. Redis 配了但这一刻读失败 —— 此时挂的是 RedisAdapter，fetchSockets 会变成
 *      经 Redis 的跨节点 RPC，正是刚刚失败的那条链路。降级到它必然抛。
 *
 * 于是「Redis 不可用时的降级」反过来又去问了 Redis。
 */
describe('ChatBroadcastService presence fallback under Redis outage', () => {
  function buildHarness(redisConfigured: boolean) {
    const fetchSockets = jest
      .fn()
      .mockRejectedValue(new Error('Connection is closed.'));
    const server = { in: jest.fn(() => ({ fetchSockets })) };
    const presence = {
      // 注册表答不上来（读失败或没配）
      isOnline: jest.fn().mockResolvedValue(null),
      getOnlineUserIds: jest.fn().mockResolvedValue(null),
      isRedisConfigured: jest.fn().mockReturnValue(redisConfigured),
      conversationJoined: jest.fn(),
    };
    const service = new ChatBroadcastService(
      presence as never,
      prismaWithActiveUsers([]) as never,
    );
    service.setServer(server as never);
    return { service, presence, fetchSockets };
  }

  it('isUserOnline 不再对着已断的 Redis 发起跨节点 RPC', async () => {
    const { service, fetchSockets } = buildHarness(true);

    await expect(service.isUserOnline('u1')).resolves.toBe(true);
    expect(fetchSockets).not.toHaveBeenCalled();
  });

  it('读不到时判为「仍在线」——宁可少推一条离线通知，也不误判成离线', async () => {
    // 与 ChatPresenceRegistry.socketDisconnected 既有策略一致：
    // 「null = Redis 这一刻不可用:宁可留着在线条目…也不要把人误判成离线」。
    const { service } = buildHarness(true);
    await expect(service.isUserOnline('u1')).resolves.toBe(true);
  });

  it('getOnlineUserIdsInConversation 读不到时返回空集——宁可重复推送也不丢消息', async () => {
    // 这个集合在 ChatPushService 里用来**排除**收件人。返回空集 = 谁都不排除
    // = 全员收到推送；反过来把人当在线会让他彻底收不到。
    const { service, fetchSockets } = buildHarness(true);

    await expect(
      service.getOnlineUserIdsInConversation('conv-1'),
    ).resolves.toEqual(new Set());
    expect(fetchSockets).not.toHaveBeenCalled();
  });

  it('Redis 没配的单实例部署仍然走 fetchSockets（内存 adapter，本来就该降级到它）', async () => {
    const { service, fetchSockets } = buildHarness(false);
    fetchSockets.mockResolvedValue([{ id: 's1' }]);

    await expect(service.isUserOnline('u1')).resolves.toBe(true);
    expect(fetchSockets).toHaveBeenCalled();
  });
});

describe('ChatBroadcastService presence visibility events', () => {
  function harness(online: boolean, lastOnline: Date | null) {
    const emit = jest.fn();
    const except = jest.fn(() => ({ emit }));
    const server = { to: jest.fn(() => ({ emit, except })) };
    const presence = {
      isOnline: jest.fn().mockResolvedValue(online),
      isRedisConfigured: jest.fn().mockReturnValue(true),
    };
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ lastOnline }) },
    };
    const service = new ChatBroadcastService(
      presence as never,
      prisma as never,
    );
    service.setServer(server as never);
    service.onModuleInit();
    return { service, server, emit, except, prisma };
  }

  afterEach(() => {
    privacySettingsEvents.removeAllListeners(PRESENCE_VISIBILITY_CHANGED);
  });

  // 关掉 → hidden:对方界面要把在线点与「N 分钟前在线」一起收掉,
  // 而不是改成「离线」—— 那仍然是信息。
  it('tells every seat room to forget the user when presence is switched off', async () => {
    const { service, server, emit, prisma } = harness(true, null);

    privacySettingsEvents.emit(PRESENCE_VISIBILITY_CHANGED, {
      userId: 'u1',
      visible: false,
      conversationIds: ['conv-1', 'conv-2'],
      excludeUserIds: [],
    });
    await service['presenceVisibilityQueue'];

    expect(server.to).toHaveBeenCalledWith(['c:conv-1', 'c:conv-2']);
    expect(emit).toHaveBeenCalledWith('chat:presence', {
      userId: 'u1',
      online: false,
      lastSeenAt: null,
      hidden: true,
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('re-announces the live state with last-seen when presence is switched back on', async () => {
    const { service, emit, except } = harness(
      false,
      new Date('2026-09-11T08:00:00.000Z'),
    );

    privacySettingsEvents.emit(PRESENCE_VISIBILITY_CHANGED, {
      userId: 'u1',
      visible: true,
      conversationIds: ['conv-1'],
      excludeUserIds: ['blocked'],
    });
    await service['presenceVisibilityQueue'];

    // 互相拉黑的人照旧剔掉,与网关上下线广播同一条规则。
    expect(except).toHaveBeenCalledWith(['u:blocked']);
    expect(emit).toHaveBeenCalledWith('chat:presence', {
      userId: 'u1',
      online: false,
      lastSeenAt: '2026-09-11T08:00:00.000Z',
    });
    service.onModuleDestroy();
  });

  it('announces online without a last-seen when the user is currently connected', async () => {
    const { service, emit } = harness(
      true,
      new Date('2026-09-11T08:00:00.000Z'),
    );

    privacySettingsEvents.emit(PRESENCE_VISIBILITY_CHANGED, {
      userId: 'u1',
      visible: true,
      conversationIds: ['conv-1'],
      excludeUserIds: [],
    });
    await service['presenceVisibilityQueue'];

    expect(emit).toHaveBeenCalledWith('chat:presence', {
      userId: 'u1',
      online: true,
      lastSeenAt: null,
    });
    service.onModuleDestroy();
  });
});

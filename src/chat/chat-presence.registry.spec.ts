import { ChatPresenceRegistry } from './chat-presence.registry';

describe('ChatPresenceRegistry', () => {
  /** 连接租约与在线成员都是 ZSET;这个替身就地维护成员集合。 */
  const sets = new Map<string, Set<string>>();
  /** 实例心跳(setJson / getJsonMany)。 */
  const values = new Map<string, unknown>();
  const redis = {
    isEnabled: jest.fn(),
    addToExpiringSet: jest.fn((key: string, member: string) => {
      const bucket = sets.get(key) ?? new Set<string>();
      bucket.add(member);
      sets.set(key, bucket);
      return Promise.resolve(true);
    }),
    removeFromExpiringSet: jest.fn((key: string, member: string) => {
      sets.get(key)?.delete(member);
      return Promise.resolve(true);
    }),
    getLiveSetMembers: jest.fn((key: string) =>
      Promise.resolve([...(sets.get(key) ?? [])]),
    ),
    deleteKey: jest.fn((key: string) => {
      sets.delete(key);
      values.delete(key);
      return Promise.resolve(true);
    }),
    setJson: jest.fn((key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve(true);
    }),
    getJsonMany: jest.fn((keys: string[]) =>
      Promise.resolve(keys.map((key) => values.get(key) ?? null)),
    ),
    touchTtl: jest.fn(),
  };

  const opened: ChatPresenceRegistry[] = [];
  const open = () => {
    const registry = new ChatPresenceRegistry(redis as never);
    registry.onModuleInit();
    opened.push(registry);
    return registry;
  };
  /** 这个实例写进 Redis 的租约成员:实例 id|socket id|推送 token。 */
  const lease = (
    registry: ChatPresenceRegistry,
    socketId: string,
    pushToken = '',
  ) =>
    `${(registry as unknown as { instanceId: string }).instanceId}|${socketId}|${pushToken}`;
  const heartbeatKey = (registry: ChatPresenceRegistry) =>
    `chat:instance:${(registry as unknown as { instanceId: string }).instanceId}`;
  const refresh = (registry: ChatPresenceRegistry) =>
    (registry as unknown as { refreshLocal(): Promise<void> }).refreshLocal();

  beforeEach(() => {
    jest.clearAllMocks();
    sets.clear();
    values.clear();
    redis.isEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    for (const registry of opened.splice(0)) registry.onModuleDestroy();
  });

  it('registers a lease and joins the conversation online sets', async () => {
    const registry = open();

    const count = await registry.registerSocket('u1', 'sock-1');
    expect(count).toBe(1);
    await registry.registerConversations('u1', ['c1', 'c2']);

    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:conn:z:u1',
      lease(registry, 'sock-1'),
      expect.any(Number),
    );
    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
      expect.any(Number),
    );
    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c2',
      'u1',
      expect.any(Number),
    );
  });

  it('only leaves the online sets when the LAST lease goes away (multi-device)', async () => {
    const registry = open();
    expect(await registry.registerSocket('u1', 'sock-1')).toBe(1);
    expect(await registry.registerSocket('u1', 'sock-2')).toBe(2);
    await registry.registerConversations('u1', ['c1']);

    await registry.socketDisconnected('u1', 'sock-1');
    // 另一端还在线:不能把人从在线集合里摘掉。
    expect(redis.removeFromExpiringSet).not.toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
    );

    await registry.socketDisconnected('u1', 'sock-2');
    expect(redis.removeFromExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
    );
    expect(redis.deleteKey).toHaveBeenCalledWith('chat:conn:z:u1');
  });

  it('refreshes only its own leases, so a crashed instance never renews its leftovers', async () => {
    const crashed = open();
    await crashed.registerSocket('u1', 'A-sock-1');
    const survivor = open();
    await survivor.registerSocket('u1', 'B-sock-1');
    await survivor.registerConversations('u1', ['c1']);
    redis.addToExpiringSet.mockClear();

    await refresh(survivor);

    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:conn:z:u1',
      lease(survivor, 'B-sock-1'),
      expect.any(Number),
    );
    expect(redis.addToExpiringSet).not.toHaveBeenCalledWith(
      'chat:conn:z:u1',
      lease(crashed, 'A-sock-1'),
      expect.any(Number),
    );
    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
      expect.any(Number),
    );
  });

  // 崩溃实例留下的租约要等 90 分钟 TTL 才消失:这段时间里人一直被当成在线、
  // 正开着 App,推送一条都不发。心跳一停,它的租约就不再算数。
  it('stops counting leases of an instance whose heartbeat is gone', async () => {
    const crashed = open();
    await crashed.registerSocket('u1', 'A-sock-1', 'ExponentPushToken[phone]');
    await crashed.registerConversations('u1', ['c1']);
    const survivor = open();
    expect(await survivor.isOnline('u1')).toBe(true);
    expect(await survivor.getForegroundPushTokens('c1')).toEqual(
      new Map([['u1', new Set(['ExponentPushToken[phone]'])]]),
    );

    // 进程被杀:没有 onModuleDestroy,心跳过期。
    values.delete(heartbeatKey(crashed));

    expect(await survivor.isOnline('u1')).toBe(false);
    expect(await survivor.getForegroundPushTokens('c1')).toEqual(new Map());
    // 连接数上限也不再被它占着。
    expect(await survivor.registerSocket('u1', 'B-sock-1')).toBe(1);
    await survivor.registerConversations('u1', ['c1']);

    // 本机最后一条断开:只剩残留租约 = 离线,顺手清掉。
    await survivor.socketDisconnected('u1', 'B-sock-1');
    expect(redis.removeFromExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
    );
    expect(sets.has('chat:conn:z:u1')).toBe(false);
  });

  it('keeps a heartbeat while running and drops it on graceful shutdown', async () => {
    const registry = open();
    await Promise.resolve();
    expect(values.has(heartbeatKey(registry))).toBe(true);

    registry.onModuleDestroy();
    expect(values.has(heartbeatKey(registry))).toBe(false);
  });

  it('treats leases written by the previous version as alive', async () => {
    // 发布期间旧实例写的是裸 socket id,没有实例 id 可查心跳:按原语义算数。
    sets.set('chat:conn:z:u1', new Set(['legacy-sock']));
    const registry = open();
    expect(await registry.isOnline('u1')).toBe(true);
  });

  it('does not filter anything when heartbeats cannot be read', async () => {
    const other = open();
    await other.registerSocket('u1', 'sock-1');
    values.delete(heartbeatKey(other));
    redis.getJsonMany.mockResolvedValueOnce(null as never);
    // 读不到心跳时沿用 TTL 兜底的旧语义,不在读失败时把活人判成离线。
    expect(await open().isOnline('u1')).toBe(true);
  });

  it('conversationJoined only marks online members into the set', async () => {
    const registry = open();
    await registry.conversationJoined('u1', 'c1');
    expect(redis.addToExpiringSet).not.toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
      expect.any(Number),
    );

    await registry.registerSocket('u1', 'sock-1');
    await registry.conversationJoined('u1', 'c1');
    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
      expect.any(Number),
    );
  });

  it('a lease that never landed is removed by id, never by blind decrement', async () => {
    // Redis 那一刻不可用:ZADD 失败,这条连接没有租约。
    redis.addToExpiringSet.mockResolvedValueOnce(null as never);
    const registry = open();
    expect(await registry.registerSocket('u1', 'sock-1')).toBeNull();

    // 另一实例上有一条活着的连接。
    sets.set('chat:conn:z:u1', new Set(['other-pod-sock']));

    await registry.socketDisconnected('u1', 'sock-1');

    // 按 id 摘除:摘不到自己那条(本来就没登上),更不会误伤别人那条 ——
    // 旧的共享标量 DECR 会把它抹到 0,人被判成离线。
    expect([...(sets.get('chat:conn:z:u1') ?? [])]).toEqual(['other-pod-sock']);
    expect(redis.deleteKey).not.toHaveBeenCalledWith('chat:conn:z:u1');
  });

  it('degrades to null (single-instance semantics) without redis', async () => {
    redis.isEnabled.mockReturnValue(false);
    const registry = open();

    expect(await registry.registerSocket('u1', 'sock-1')).toBeNull();
    expect(await registry.getOnlineUserIds('c1')).toBeNull();
    expect(await registry.getForegroundPushTokens('c1')).toBeNull();
    expect(await registry.isOnline('u1')).toBeNull();
    expect(redis.addToExpiringSet).not.toHaveBeenCalled();
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  describe('foreground devices', () => {
    const PHONE = 'ExponentPushToken[phone]';
    const TABLET = 'ExponentPushToken[tablet]';

    it('names the push token of each device that has the app open', async () => {
      const registry = open();
      await registry.registerSocket('u1', 'phone', PHONE);
      await registry.registerConversations('u1', ['c1']);
      expect(await registry.getForegroundPushTokens('c1')).toEqual(
        new Map([['u1', new Set([PHONE])]]),
      );

      await registry.setSocketBackground('u1', 'phone', true);
      // 锁屏的那部手机连接还在,但什么都收不到 —— 推送必须照发。
      expect(await registry.getForegroundPushTokens('c1')).toEqual(new Map());
      expect(await registry.isOnline('u1')).toBe(true);

      await registry.setSocketBackground('u1', 'phone', false);
      expect(await registry.getForegroundPushTokens('c1')).toEqual(
        new Map([['u1', new Set([PHONE])]]),
      );
    });

    // 按人判断时,电脑上开着网页版就让手机一条推送都收不到。
    it('never lets a device without a push token (web) hide the phone', async () => {
      const registry = open();
      await registry.registerSocket('u1', 'desktop-web');
      await registry.registerSocket('u1', 'phone', PHONE);
      await registry.registerSocket('u1', 'tablet', TABLET);
      await registry.registerConversations('u1', ['c1']);
      await registry.setSocketBackground('u1', 'phone', true);

      expect(await registry.getForegroundPushTokens('c1')).toEqual(
        new Map([['u1', new Set([TABLET])]]),
      );
    });

    it('drop the background mark on disconnect and ignore a late switch', async () => {
      const registry = open();
      await registry.registerSocket('u1', 'sock-1', PHONE);
      await registry.registerSocket('u1', 'sock-2');
      await registry.setSocketBackground('u1', 'sock-1', true);

      await registry.socketDisconnected('u1', 'sock-1');
      expect(
        sets.get('chat:bg:z:u1')?.has(lease(registry, 'sock-1', PHONE)),
      ).toBe(false);

      // 断开之后才到的切换:不能被本实例续期续成一条永不过期的死租约。
      await registry.setSocketBackground('u1', 'sock-1', true);
      redis.addToExpiringSet.mockClear();
      await refresh(registry);
      expect(redis.addToExpiringSet).not.toHaveBeenCalledWith(
        'chat:bg:z:u1',
        lease(registry, 'sock-1', PHONE),
        expect.any(Number),
      );
    });

    it('refreshes this instance background marks with its leases', async () => {
      const registry = open();
      await registry.registerSocket('u1', 'sock-1', PHONE);
      await registry.setSocketBackground('u1', 'sock-1', true);
      redis.addToExpiringSet.mockClear();

      await refresh(registry);

      expect(redis.addToExpiringSet).toHaveBeenCalledWith(
        'chat:bg:z:u1',
        lease(registry, 'sock-1', PHONE),
        expect.any(Number),
      );
    });

    it('treat an unreadable lease set as no foreground device (push rather than stay silent)', async () => {
      const registry = open();
      await registry.registerSocket('u1', 'sock-1', PHONE);
      await registry.registerConversations('u1', ['c1']);
      redis.getLiveSetMembers.mockImplementation((key: string) =>
        key === 'chat:bg:z:u1'
          ? Promise.resolve(null as never)
          : Promise.resolve([...(sets.get(key) ?? [])]),
      );

      expect(await registry.getForegroundPushTokens('c1')).toEqual(new Map());
      redis.getLiveSetMembers.mockImplementation((key: string) =>
        Promise.resolve([...(sets.get(key) ?? [])]),
      );
    });
  });
});

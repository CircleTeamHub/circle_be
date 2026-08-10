import { ChatPresenceRegistry } from './chat-presence.registry';

describe('ChatPresenceRegistry', () => {
  /** 连接租约与在线成员都是 ZSET;这个替身就地维护成员集合。 */
  const sets = new Map<string, Set<string>>();
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
      return Promise.resolve(true);
    }),
    touchTtl: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    sets.clear();
    redis.isEnabled.mockReturnValue(true);
  });

  it('registers a lease and joins the conversation online sets', async () => {
    const registry = new ChatPresenceRegistry(redis as never);

    const count = await registry.registerSocket('u1', 'sock-1');
    expect(count).toBe(1);
    await registry.registerConversations('u1', ['c1', 'c2']);

    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:conn:z:u1',
      'sock-1',
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
    registry.onModuleDestroy();
  });

  it('only leaves the online sets when the LAST lease goes away (multi-device)', async () => {
    const registry = new ChatPresenceRegistry(redis as never);
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
    registry.onModuleDestroy();
  });

  it('a crashed pod leaves an expiring lease, not a permanent count', async () => {
    // pod A 的两条连接;A 崩了,它的租约不再续期。
    const crashed = new ChatPresenceRegistry(redis as never);
    await crashed.registerSocket('u1', 'A-sock-1');
    await crashed.registerConversations('u1', ['c1']);
    crashed.onModuleDestroy();

    // pod B 上还有一条连接,它只给**自己**那条租约续期。
    const survivor = new ChatPresenceRegistry(redis as never);
    await survivor.registerSocket('u1', 'B-sock-1');
    await survivor.registerConversations('u1', ['c1']);
    redis.addToExpiringSet.mockClear();
    await (
      survivor as unknown as { refreshLocal(): Promise<void> }
    ).refreshLocal();
    expect(redis.addToExpiringSet).not.toHaveBeenCalledWith(
      'chat:conn:z:u1',
      'A-sock-1',
      expect.any(Number),
    );

    // A 的租约到期消失(ZSET 逐条目过期,这里直接摘掉模拟)。
    sets.get('chat:conn:z:u1')?.delete('A-sock-1');

    // B 最后一条连接断开 → 用户真的离线。旧的共享标量 DECR 在这里会被 A 那次
    // 从未回收的 +1 顶住,永远减不到 0:人一直被判在线,离线推送从此不发。
    await survivor.socketDisconnected('u1', 'B-sock-1');
    expect(redis.removeFromExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
    );
    survivor.onModuleDestroy();
  });

  it('conversationJoined only marks online members into the set', async () => {
    const registry = new ChatPresenceRegistry(redis as never);
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
    registry.onModuleDestroy();
  });

  it('a lease that never landed is removed by id, never by blind decrement', async () => {
    // Redis 那一刻不可用:ZADD 失败,这条连接没有租约。
    redis.addToExpiringSet.mockResolvedValueOnce(null);
    const registry = new ChatPresenceRegistry(redis as never);
    expect(await registry.registerSocket('u1', 'sock-1')).toBeNull();

    // 另一实例上有一条活着的连接。
    sets.set('chat:conn:z:u1', new Set(['other-pod-sock']));

    await registry.socketDisconnected('u1', 'sock-1');

    // 按 id 摘除:摘不到自己那条(本来就没登上),更不会误伤别人那条 ——
    // 旧的共享标量 DECR 会把它抹到 0,人被判成离线。
    expect([...(sets.get('chat:conn:z:u1') ?? [])]).toEqual(['other-pod-sock']);
    expect(redis.deleteKey).not.toHaveBeenCalled();
    registry.onModuleDestroy();
  });

  it('refreshes only its own leases and members', async () => {
    const registry = new ChatPresenceRegistry(redis as never);
    await registry.registerSocket('u1', 'sock-1');
    await registry.registerConversations('u1', ['c1']);
    redis.addToExpiringSet.mockClear();

    await (
      registry as unknown as { refreshLocal(): Promise<void> }
    ).refreshLocal();

    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:conn:z:u1',
      'sock-1',
      expect.any(Number),
    );
    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
      expect.any(Number),
    );
    registry.onModuleDestroy();
  });

  it('degrades to null (single-instance semantics) without redis', async () => {
    redis.isEnabled.mockReturnValue(false);
    const registry = new ChatPresenceRegistry(redis as never);

    expect(await registry.registerSocket('u1', 'sock-1')).toBeNull();
    expect(await registry.getOnlineUserIds('c1')).toBeNull();
    expect(await registry.isOnline('u1')).toBeNull();
    expect(redis.addToExpiringSet).not.toHaveBeenCalled();
    registry.onModuleDestroy();
  });
});

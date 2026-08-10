import { ChatPresenceRegistry } from './chat-presence.registry';

describe('ChatPresenceRegistry', () => {
  const redis = {
    isEnabled: jest.fn(),
    incrementWithTtl: jest.fn(),
    decrementFloorZero: jest.fn(),
    addToExpiringSet: jest.fn(),
    removeFromExpiringSet: jest.fn(),
    getLiveSetMembers: jest.fn(),
    getCounter: jest.fn(),
    deleteKey: jest.fn(),
    touchTtl: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.isEnabled.mockReturnValue(true);
    redis.deleteKey.mockResolvedValue(true);
    redis.addToExpiringSet.mockResolvedValue(true);
    redis.removeFromExpiringSet.mockResolvedValue(true);
  });

  it('registers globally and joins the conversation online sets', async () => {
    redis.incrementWithTtl.mockResolvedValue(1);
    const registry = new ChatPresenceRegistry(redis as never);

    const count = await registry.registerSocket('u1');
    expect(count).toBe(1);
    await registry.registerConversations('u1', ['c1', 'c2']);

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

  it('only leaves the online sets when the LAST socket goes away (multi-device)', async () => {
    redis.incrementWithTtl.mockResolvedValue(2);
    const registry = new ChatPresenceRegistry(redis as never);
    await registry.registerSocket('u1');
    await registry.registerSocket('u1');
    await registry.registerConversations('u1', ['c1']);

    redis.decrementFloorZero.mockResolvedValueOnce(1);
    await registry.socketDisconnected('u1');
    // 另一端还在线:不能把人从在线集合里摘掉。
    expect(redis.removeFromExpiringSet).not.toHaveBeenCalled();

    redis.decrementFloorZero.mockResolvedValueOnce(0);
    await registry.socketDisconnected('u1');
    expect(redis.removeFromExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
    );
    expect(redis.deleteKey).toHaveBeenCalledWith('chat:conn:u1');
    registry.onModuleDestroy();
  });

  it('conversationJoined only marks online members into the set', async () => {
    const registry = new ChatPresenceRegistry(redis as never);
    redis.getCounter.mockResolvedValueOnce(0);
    await registry.conversationJoined('u1', 'c1');
    expect(redis.addToExpiringSet).not.toHaveBeenCalled();

    redis.getCounter.mockResolvedValueOnce(2);
    await registry.conversationJoined('u1', 'c1');
    expect(redis.addToExpiringSet).toHaveBeenCalledWith(
      'chat:online:z:c1',
      'u1',
      expect.any(Number),
    );
    registry.onModuleDestroy();
  });

  it('does not decrement a lease it never acquired (redis down at connect)', async () => {
    // Redis 那一刻不可用:incrementWithTtl 返回 null,这条连接没有全局计数。
    redis.incrementWithTtl.mockResolvedValue(null);
    const registry = new ChatPresenceRegistry(redis as never);
    expect(await registry.registerSocket('u1')).toBeNull();

    await registry.socketDisconnected('u1', false);

    // 不能去减:另一实例上那条活着的连接的计数会被抹到 0,人被判成离线。
    expect(redis.decrementFloorZero).not.toHaveBeenCalled();
    expect(redis.removeFromExpiringSet).not.toHaveBeenCalled();
    registry.onModuleDestroy();
  });

  it('refreshes only its own member score, never the whole set', async () => {
    redis.incrementWithTtl.mockResolvedValue(1);
    const registry = new ChatPresenceRegistry(redis as never);
    await registry.registerSocket('u1');
    await registry.registerConversations('u1', ['c1']);
    redis.addToExpiringSet.mockClear();

    await (
      registry as unknown as { refreshLocal(): Promise<void> }
    ).refreshLocal();

    // ZADD 只抬 u1 这一条的到期时刻;崩溃实例留下的成员照常到期。
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

    expect(await registry.registerSocket('u1')).toBeNull();
    expect(await registry.getOnlineUserIds('c1')).toBeNull();
    expect(await registry.isOnline('u1')).toBeNull();
    expect(redis.incrementWithTtl).not.toHaveBeenCalled();
    registry.onModuleDestroy();
  });
});

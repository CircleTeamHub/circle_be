import { ChatPresenceRegistry } from './chat-presence.registry';

describe('ChatPresenceRegistry', () => {
  const redis = {
    isEnabled: jest.fn(),
    incrementWithTtl: jest.fn(),
    decrementFloorZero: jest.fn(),
    addToSet: jest.fn(),
    removeFromSet: jest.fn(),
    getSetMembers: jest.fn(),
    getCounter: jest.fn(),
    deleteKey: jest.fn(),
    touchTtl: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.isEnabled.mockReturnValue(true);
    redis.deleteKey.mockResolvedValue(true);
    redis.addToSet.mockResolvedValue(true);
    redis.removeFromSet.mockResolvedValue(true);
  });

  it('registers globally and joins the conversation online sets', async () => {
    redis.incrementWithTtl.mockResolvedValue(1);
    const registry = new ChatPresenceRegistry(redis as never);

    const count = await registry.registerSocket('u1');
    expect(count).toBe(1);
    await registry.registerConversations('u1', ['c1', 'c2']);

    expect(redis.addToSet).toHaveBeenCalledWith(
      'chat:online:c1',
      'u1',
      expect.any(Number),
    );
    expect(redis.addToSet).toHaveBeenCalledWith(
      'chat:online:c2',
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
    expect(redis.removeFromSet).not.toHaveBeenCalled();

    redis.decrementFloorZero.mockResolvedValueOnce(0);
    await registry.socketDisconnected('u1');
    expect(redis.removeFromSet).toHaveBeenCalledWith('chat:online:c1', 'u1');
    expect(redis.deleteKey).toHaveBeenCalledWith('chat:conn:u1');
    registry.onModuleDestroy();
  });

  it('conversationJoined only marks online members into the set', async () => {
    const registry = new ChatPresenceRegistry(redis as never);
    redis.getCounter.mockResolvedValueOnce(0);
    await registry.conversationJoined('u1', 'c1');
    expect(redis.addToSet).not.toHaveBeenCalled();

    redis.getCounter.mockResolvedValueOnce(2);
    await registry.conversationJoined('u1', 'c1');
    expect(redis.addToSet).toHaveBeenCalledWith(
      'chat:online:c1',
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

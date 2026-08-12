import { ChatBroadcastService } from './chat-broadcast.service';

/** 延迟兑现的 join —— 用来暴露「没 await」的时序缺陷。 */
function deferredJoin(id: string, completed: string[], delayMs: number) {
  return jest.fn(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          completed.push(id);
          resolve();
        }, delayMs);
      }),
  );
}

describe('ChatBroadcastService.joinUserToConversation', () => {
  function buildHarness(joinDelayMs = 0) {
    const completed: string[] = [];
    // 多副本部署下 fetchSockets() 拿到的是 RemoteSocket —— join() 是跨节点
    // 异步调用,返回 Promise。
    const sockets = [
      { join: deferredJoin('s1', completed, joinDelayMs) },
      { join: deferredJoin('s2', completed, joinDelayMs) },
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
    const service = new ChatBroadcastService(presence as never);
    service.setServer(server as never);
    return { service, sockets, completed, presence };
  }

  it('awaits every remote join before resolving', async () => {
    // 不等的话本方法会在对方真正入房之前返回,调用方紧接着广播的第一条消息
    // 直接丢空 —— 结算卡片就是这么丢的:客户端连 chat:msg 都收不到,
    // 也就没有任何东西能触发它自愈补拉。
    const { service, sockets, completed } = buildHarness(5);

    await service.joinUserToConversation('u1', 'conv-1');

    expect(sockets[0].join).toHaveBeenCalledWith('c:conv-1');
    expect(sockets[1].join).toHaveBeenCalledWith('c:conv-1');
    expect(completed).toEqual(['s1', 's2']);
  });

  it('is a no-op without an attached server', async () => {
    const presence = { conversationJoined: jest.fn() };
    const service = new ChatBroadcastService(presence as never);

    await expect(
      service.joinUserToConversation('u1', 'conv-1'),
    ).resolves.toBeUndefined();
  });
});

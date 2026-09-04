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

function deferredSocketAction(id: string, completed: string[]) {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      completed.push(id);
      done();
    };
  });
  return { action: jest.fn(() => promise), resolve };
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

describe('ChatBroadcastService.emitHistoryCleared', () => {
  it('broadcasts the authoritative watermark to the conversation room', () => {
    const emit = jest.fn();
    const to = jest.fn(() => ({ emit }));
    const presence = {};
    const service = new ChatBroadcastService(presence as never);
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
  it('awaits every remote leave before resolving', async () => {
    const completed: string[] = [];
    const first = deferredSocketAction('s1', completed);
    const second = deferredSocketAction('s2', completed);
    const sockets = [{ leave: first.action }, { leave: second.action }];
    const server = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue(sockets),
      })),
    };
    const presence = { conversationLeft: jest.fn() };
    const service = new ChatBroadcastService(presence as never);
    service.setServer(server as never);

    let resolved = false;
    const removal = service
      .removeUserFromConversation('u1', 'conv-1')
      .then(() => {
        resolved = true;
      });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(false);
    first.resolve();
    second.resolve();
    await removal;

    expect(completed).toEqual(['s1', 's2']);
    expect(sockets[0].leave).toHaveBeenCalledWith('c:conv-1');
    expect(sockets[1].leave).toHaveBeenCalledWith('c:conv-1');
  });

  it('awaits every remote disconnect fallback before resolving', async () => {
    const completed: string[] = [];
    const first = deferredSocketAction('s1', completed);
    const second = deferredSocketAction('s2', completed);
    const sockets = [
      { disconnect: first.action },
      { disconnect: second.action },
    ];
    const server = {
      in: jest.fn(() => ({
        fetchSockets: jest.fn().mockResolvedValue(sockets),
      })),
    };
    const service = new ChatBroadcastService({} as never);
    service.setServer(server as never);

    let resolved = false;
    const disconnect = service.disconnectUserSockets('u1').then(() => {
      resolved = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(false);
    first.resolve();
    second.resolve();
    await disconnect;

    expect(completed).toEqual(['s1', 's2']);
    expect(sockets[0].disconnect).toHaveBeenCalledWith(true);
    expect(sockets[1].disconnect).toHaveBeenCalledWith(true);
  });

  it('broadcasts a message to the conversation room except excluded user rooms', () => {
    const emit = jest.fn();
    const except = jest.fn(() => ({ emit }));
    const to = jest.fn(() => ({ except }));
    const service = new ChatBroadcastService({} as never);
    service.setServer({ to } as never);
    const message = {
      id: 'message-1',
      conversationId: 'conv-1',
      type: 'system',
      content: { kind: 'member-removed' },
    } as never;

    (service as any).emitMessageExcludingUsers(message, ['removed-user']);

    expect(to).toHaveBeenCalledWith('c:conv-1');
    expect(except).toHaveBeenCalledWith(['u:removed-user']);
    expect(emit).toHaveBeenCalledWith('chat:msg', message);
  });
});

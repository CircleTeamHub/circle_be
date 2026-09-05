/* eslint-disable sonarjs/no-internal-api-use -- This contract regression intentionally executes the installed Socket.IO RemoteSocket implementation. */
import { RemoteSocket } from '../../node_modules/socket.io/dist/broadcast-operator';
import { ChatBroadcastService } from './chat-broadcast.service';

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
    const socket = realRemoteSocket(adapter);
    expect(socket.leave('contract-probe')).toBeUndefined();
    adapter.delSockets.mockClear();
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
      const socket = realRemoteSocket(adapter);
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

  it('keeps future messages private when leave fails and void disconnect fallback cannot acknowledge completion', async () => {
    const leaveAdapter = {
      delSockets: jest.fn(() => {
        throw new Error('adapter unavailable');
      }),
    };
    const disconnectAdapter = { disconnectSockets: jest.fn() };
    const leavingRemote = realRemoteSocket(leaveAdapter, 'leaving-remote');
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

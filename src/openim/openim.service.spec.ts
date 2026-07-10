import { ConfigService } from '@nestjs/config';
import { OpenimService } from './openim.service';

describe('OpenimService group/auth admin calls', () => {
  let service: OpenimService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    const config = {
      get: (k: string) => {
        if (k === 'OPENIM_API_URL') return 'http://im.local';
        if (k === 'OPENIM_ADMIN_SECRET') return 'secret';
        return undefined;
      },
    } as unknown as ConfigService;
    service = new OpenimService(config);

    fetchMock = jest.fn(async (url: string) => ({
      json: async () =>
        url.endsWith('/auth/get_admin_token')
          ? { errCode: 0, data: { token: 'admin-token' } }
          : { errCode: 0, data: {} },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('createGroup puts ownerUserID at the top level (not inside groupInfo)', async () => {
    await service.createGroup('tmpABC', 'Weekend Hike', 'host-1', ['host-1']);
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/group/create_group'),
    );
    expect(call).toBeDefined();
    const body = JSON.parse(call![1].body);
    // OpenIM 要求 ownerUserID 在请求顶层；放进 groupInfo 会被判为空 → ArgsError。
    expect(body.ownerUserID).toBe('host1');
    expect(body.groupInfo.ownerUserID).toBeUndefined();
    expect(body.groupInfo).toEqual({
      groupID: 'tmpABC',
      groupName: 'Weekend Hike',
      groupType: 2,
    });
  });

  it('createGroup drops the owner from memberUserIDs to avoid "group member repeated"', async () => {
    await service.createGroup('tmpABC', 'T', 'host-1', ['host-1', 'g-2-3']);
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/group/create_group'),
    );
    const body = JSON.parse(call![1].body);
    // owner 由服务端自动入群；保留在 memberUserIDs 里会重复 → ArgsError。
    expect(body.memberUserIDs).toEqual(['g23']);
  });

  it('updateUserInfo posts /user/update_user_info with a hyphen-stripped userID', async () => {
    await service.updateUserInfo('a1b2-c3d4-e5', {
      nickname: '小霸王',
      avatarUrl: 'https://cdn/a.jpg',
    });
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/user/update_user_info'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      userInfo: {
        userID: 'a1b2c3d4e5',
        nickname: '小霸王',
        faceURL: 'https://cdn/a.jpg',
      },
    });
  });

  it('updateUserInfo maps avatarUrl:null to an empty faceURL and omits unset fields', async () => {
    await service.updateUserInfo('u-1', { avatarUrl: null });
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/user/update_user_info'),
    );
    const body = JSON.parse(call![1].body);
    expect(body.userInfo).toEqual({ userID: 'u1', faceURL: '' });
  });

  it('updateUserInfo is a no-op when neither nickname nor avatar is provided', async () => {
    await service.updateUserInfo('u-1', {});
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/user/update_user_info'),
    );
    expect(call).toBeUndefined();
  });

  it('singleConversationID strips hyphens and sorts ascending (order-independent)', () => {
    expect(OpenimService.singleConversationID('751b-7308', '0a9a-d3d6')).toBe(
      'si_0a9ad3d6_751b7308',
    );
    expect(OpenimService.singleConversationID('0a9a-d3d6', '751b-7308')).toBe(
      'si_0a9ad3d6_751b7308',
    );
  });

  it('clearConversationMessages posts /msg/clear_conversation_msg with a hyphen-stripped userID', async () => {
    await service.clearConversationMessages('a1-b2', ['si_a1b2_c3d4']);
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/msg/clear_conversation_msg'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      userID: 'a1b2',
      conversationIDs: ['si_a1b2_c3d4'],
      deleteSyncOpt: { isSyncSelf: true, isSyncOther: false },
    });
  });

  it('clearConversationMessages is a no-op when no conversation ids are given', async () => {
    await service.clearConversationMessages('a1', []);
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/msg/clear_conversation_msg'),
    );
    expect(call).toBeUndefined();
  });

  it('dismissGroup posts /group/dismiss_group with deleteMember=true', async () => {
    await service.dismissGroup('tmpABC');
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/group/dismiss_group'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      groupID: 'tmpABC',
      deleteMember: true,
    });
  });

  it('isGroupMember posts /group/get_group_members_info with the normalized user id', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      json: async () =>
        url.endsWith('/auth/get_admin_token')
          ? { errCode: 0, data: { token: 'admin-token' } }
          : {
              errCode: 0,
              data: { members: [{ userID: 'user123' }] },
            },
    }));

    await expect(service.isGroupMember('group-1', 'user-123')).resolves.toBe(
      true,
    );
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/group/get_group_members_info'),
    );

    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      groupID: 'group-1',
      userIDs: ['user123'],
    });
  });

  it('isGroupMember returns false when OpenIM returns no matching member', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      json: async () =>
        url.endsWith('/auth/get_admin_token')
          ? { errCode: 0, data: { token: 'admin-token' } }
          : { errCode: 0, data: { members: [] } },
    }));

    await expect(service.isGroupMember('group-1', 'user-123')).resolves.toBe(
      false,
    );
  });

  it('importFriends posts /friend/import_friend with normalized user ids', async () => {
    await service.importFriends('owner-1', ['friend-1', 'friend-2']);
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/friend/import_friend'),
    );

    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      ownerUserID: 'owner1',
      friendUserIDs: ['friend1', 'friend2'],
    });
  });

  it('sendTextMessage posts /msg/send_msg as a single chat text message', async () => {
    await service.sendTextMessage({
      sendID: 'sender-1',
      recvID: 'receiver-2',
      content: '我是小李',
      senderNickname: '小李',
      senderFaceURL: 'https://cdn.example/avatar.png',
    });
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/msg/send_msg'),
    );

    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      sendID: 'sender1',
      recvID: 'receiver2',
      content: { content: '我是小李' },
      contentType: 101,
      sessionType: 1,
      senderNickname: '小李',
      senderFaceURL: 'https://cdn.example/avatar.png',
      senderPlatformID: 5,
      isOnlineOnly: false,
      notOfflinePush: false,
      sendTime: expect.any(Number),
      offlinePushInfo: {
        title: '小李',
        desc: '我是小李',
        ex: '',
        iOSPushSound: 'default',
        iOSBadgeCount: true,
      },
      ex: '',
    });
  });

  it('deleteFriend posts /friend/delete_friend with normalized user ids', async () => {
    await service.deleteFriend('owner-1', 'friend-1');
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/friend/delete_friend'),
    );

    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      ownerUserID: 'owner1',
      friendUserID: 'friend1',
    });
  });

  it('addBlacklist posts /friend/add_black with normalized user ids', async () => {
    await service.addBlacklist('owner-1', 'blocked-1');
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/friend/add_black'),
    );

    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      ownerUserID: 'owner1',
      blackUserID: 'blocked1',
      ex: '',
    });
  });

  it('removeBlacklist posts /friend/remove_black with normalized user ids', async () => {
    await service.removeBlacklist('owner-1', 'blocked-1');
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/friend/remove_black'),
    );

    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      ownerUserID: 'owner1',
      blackUserID: 'blocked1',
    });
  });

  it('forceLogout strips hyphens and posts /auth/force_logout', async () => {
    await service.forceLogout('gX-Y-Z', 5);
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/auth/force_logout'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      userID: 'gXYZ',
      platformID: 5,
    });
  });

  it('includes OpenIM errDlt details in thrown API errors', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      json: async () =>
        url.endsWith('/auth/get_admin_token')
          ? { errCode: 0, data: { token: 'admin-token' } }
          : {
              errCode: 1001,
              errMsg: 'ArgsError',
              errDlt: 'group member repeated',
            },
    }));

    await expect(
      service.createGroup('tmpABC', 'T', 'host-1', ['host-2']),
    ).rejects.toThrow('OpenIM error: ArgsError (group member repeated)');
  });

  it('throws a clear error for non-2xx OpenIM HTTP responses', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/auth/get_admin_token')
        ? { json: async () => ({ errCode: 0, data: { token: 'admin-token' } }) }
        : {
            ok: false,
            status: 502,
            text: async () => '<html>bad gateway</html>',
          },
    );

    await expect(
      service.createGroup('tmpABC', 'T', 'host-1', []),
    ).rejects.toThrow('OpenIM HTTP 502: <html>bad gateway</html>');
  });

  it('refreshes the cached admin token and retries once when OpenIM rejects the token', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/get_admin_token')) {
        const token =
          fetchMock.mock.calls.filter(([u]) =>
            String(u).endsWith('/auth/get_admin_token'),
          ).length === 1
            ? 'expired-token'
            : 'fresh-token';
        return { json: async () => ({ errCode: 0, data: { token } }) };
      }

      if ((init?.headers as Record<string, string>).token === 'expired-token') {
        return {
          json: async () => ({
            errCode: 1501,
            errMsg: 'TokenInvalidError',
            errDlt: 'token expired',
          }),
        };
      }

      return { json: async () => ({ errCode: 0, data: {} }) };
    });

    await expect(
      service.createGroup('tmpABC', 'T', 'host-1', []),
    ).resolves.toBeUndefined();

    const createGroupCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/group/create_group'),
    );
    expect(createGroupCalls).toHaveLength(2);
    expect(createGroupCalls.map(([, init]) => init.headers.token)).toEqual([
      'expired-token',
      'fresh-token',
    ]);
  });

  it('backs off admin token refresh after an OpenIM outage', async () => {
    fetchMock.mockRejectedValue(new Error('connect timeout'));

    await expect(service.getUserToken('user-1')).rejects.toThrow(
      'connect timeout',
    );
    await expect(service.getUserToken('user-1')).rejects.toThrow(
      'OpenIM unavailable',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

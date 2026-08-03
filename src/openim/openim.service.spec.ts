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
      lookMemberInfo: 1,
      applyMemberFriend: 1,
    });
  });

  it('sets a group member role through the OpenIM admin API', async () => {
    expect(typeof (service as any).setGroupMemberRole).toBe('function');

    await (service as any).setGroupMemberRole('group-1', 'user-123', 60);

    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/group/set_group_member_info'),
    );
    expect(call).toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({
      members: [{ groupID: 'group-1', userID: 'user123', roleLevel: 60 }],
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

  it('lists OpenIM groups with server-side pagination and search', async () => {
    fetchMock.mockImplementation(
      async (url: string, options?: RequestInit) => ({
        json: async () => {
          if (url.endsWith('/auth/get_admin_token')) {
            return { errCode: 0, data: { token: 'admin-token' } };
          }
          const body = JSON.parse(String(options?.body ?? '{}'));
          if (body.groupID) {
            return { errCode: 0, data: { total: 0, groups: [] } };
          }
          return {
            errCode: 0,
            data: {
              total: 1,
              groups: [
                {
                  groupInfo: {
                    groupID: 'group-1',
                    groupName: 'Weekend Hike',
                    status: 0,
                    memberCount: 20,
                  },
                  groupOwnerUserID: 'owner-1',
                  groupOwnerUserName: 'Alice',
                },
              ],
            },
          };
        },
      }),
    );

    await expect(
      service.listGroups({ page: 2, limit: 25, keyword: 'Weekend' }),
    ).resolves.toMatchObject({ total: 1 });
    const calls = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/group/get_groups'),
    );
    expect(JSON.parse(calls[0]![1].body)).toEqual({
      groupID: 'Weekend',
      pagination: { pageNumber: 1, showNumber: 1 },
    });
    expect(JSON.parse(calls[1]![1].body)).toEqual({
      groupName: 'Weekend',
      pagination: { pageNumber: 2, showNumber: 25 },
    });
  });

  it.each([
    ['muteGroup', '/group/mute_group'],
    ['unmuteGroup', '/group/cancel_mute_group'],
  ] as const)('%s posts the group id to OpenIM', async (method, path) => {
    await service[method]('group-1');
    const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith(path));
    expect(JSON.parse(call![1].body)).toEqual({ groupID: 'group-1' });
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

  it('reads a normalized group member role from OpenIM', async () => {
    fetchMock.mockImplementation(async (url: string) => ({
      json: async () =>
        url.endsWith('/auth/get_admin_token')
          ? { errCode: 0, data: { token: 'admin-token' } }
          : {
              errCode: 0,
              data: { members: [{ userID: 'user123', roleLevel: 100 }] },
            },
    }));

    expect(typeof (service as any).getGroupMemberRole).toBe('function');
    await expect(
      (service as any).getGroupMemberRole('group-1', 'user-123'),
    ).resolves.toBe(100);

    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).endsWith('/group/get_group_members_info'),
    );
    expect(JSON.parse(call![1].body)).toEqual({
      groupID: 'group-1',
      userIDs: ['user123'],
    });
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

describe('OpenimService userID <-> imUserID mapping', () => {
  it('strips hyphens going to OpenIM and restores them coming back', () => {
    const uuid = '2f1a4b6c-8d9e-4a1b-8c2d-3e4f5a6b7c8d';
    const imId = OpenimService.toImUserId(uuid);

    expect(imId).toBe('2f1a4b6c8d9e4a1b8c2d3e4f5a6b7c8d');
    expect(imId).not.toContain('-');
    expect(OpenimService.fromImUserId(imId)).toBe(uuid);
  });

  it('normalizes uppercase im ids to the lowercase UUID Postgres stores', () => {
    // 正则大小写不敏感,但 Prisma/Postgres 的 User.id 恒为小写。大写 im id 若按原样重建
    // 会拼出大写 UUID、与 DB 比对全落空。fromImUserId 必须归一到小写。
    const upper = '2F1A4B6C8D9E4A1B8C2D3E4F5A6B7C8D';

    expect(OpenimService.fromImUserId(upper)).toBe(
      '2f1a4b6c-8d9e-4a1b-8c2d-3e4f5a6b7c8d',
    );
  });

  it('returns non-32-hex ids unchanged (already a UUID or other shape)', () => {
    const alreadyUuid = '2f1a4b6c-8d9e-4a1b-8c2d-3e4f5a6b7c8d';
    expect(OpenimService.fromImUserId(alreadyUuid)).toBe(alreadyUuid);
    expect(OpenimService.fromImUserId('admin')).toBe('admin');
  });
});

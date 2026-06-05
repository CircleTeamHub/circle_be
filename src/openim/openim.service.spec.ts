import { ConfigService } from '@nestjs/config';
import { OpenimService } from './openim.service';

describe('OpenimService group/auth admin calls', () => {
  let service: OpenimService;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    const config = {
      get: (k: string) =>
        k === 'OPENIM_API_URL'
          ? 'http://im.local'
          : k === 'OPENIM_ADMIN_SECRET'
            ? 'secret'
            : undefined,
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
});

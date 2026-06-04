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

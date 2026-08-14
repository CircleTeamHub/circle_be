import { CircleInvitationController } from './circle-invitation.controller';

describe('CircleInvitationController pagination', () => {
  it('forwards list cursors and limits with the authenticated scope', async () => {
    const service = {
      getMyPendingVerifications: jest.fn().mockResolvedValue([]),
      getMyApplications: jest.fn().mockResolvedValue([]),
      getPendingInvitationsForCircle: jest.fn().mockResolvedValue([]),
    };
    const controller = new CircleInvitationController(service as any);
    const request = { user: { userId: 'user-1' } } as any;
    const query = {
      cursor: '11111111-1111-4111-8111-111111111111',
      limit: 25,
    };

    await controller.myPendingVerifications(request, query);
    await controller.myApplications(request, query);
    await controller.circlePending('circle-1', request, query);

    expect(service.getMyPendingVerifications).toHaveBeenCalledWith(
      'user-1',
      query,
    );
    expect(service.getMyApplications).toHaveBeenCalledWith('user-1', query);
    expect(service.getPendingInvitationsForCircle).toHaveBeenCalledWith(
      'user-1',
      'circle-1',
      query,
    );
  });
});

// requiredVerifierCount=1 下这条路由是「当场入圈 + 通知 + 实时广播 + 席位同步」。
// AppModule 没装全局 throttler,不在路由上限就等于一个成员可以一路刷到圈子容量。
describe('invite throttling', () => {
  it('guards the controller with the throttler and budgets invite at 20/min', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      CircleInvitationController,
    ) as Array<{ name: string }>;
    expect(guards.map((guard) => guard.name)).toContain('ThrottlerGuard');

    // 与 POST /group/:groupID/members/invite 同一条预算(@Throttle 展开成
    // 每个命名空间一个 key,不是一个对象)。
    const invite = CircleInvitationController.prototype.invite;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', invite)).toBe(20);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', invite)).toBe(60_000);
  });
});
